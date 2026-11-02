package dev.feishu.codex.bridge

import java.io.IOException
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.connectbot.sshlib.SessionExit
import org.connectbot.sshlib.SftpAttributes
import org.connectbot.sshlib.SftpClient
import org.connectbot.sshlib.SftpFileHandle
import org.connectbot.sshlib.SftpOpenFlag
import org.connectbot.sshlib.SftpResult
import org.connectbot.sshlib.SftpStatusCode
import org.connectbot.sshlib.getOrThrow

/** A file on the connected SSH host, with its original local display name. */
internal data class BridgeSshUploadedAttachment(
    val originalName: String,
    val remotePath: String,
    val sizeBytes: Long,
)

/** Small seam for testing transfer and cleanup without a remote server. */
internal interface BridgeSshAttachmentSftp : AutoCloseable {
    suspend fun realpath(path: String): String
    /** POSIX mode, including the file type; null only when the path is absent. */
    suspend fun lstatMode(path: String): Int?
    suspend fun mkdir(path: String, mode: Int)
    suspend fun openExclusive(path: String, mode: Int): BridgeSshAttachmentRemoteFile
    suspend fun remove(path: String)
}

internal interface BridgeSshAttachmentRemoteFile {
    suspend fun write(offset: Long, data: ByteArray)
    suspend fun close()
}

/**
 * Streams an attachment to the authenticated SSH target's home directory.
 * The stream belongs to this call and is closed on both success and failure.
 * Progress runs on the IO dispatcher and reports acknowledged bytes only.
 */
internal class BridgeSshAttachmentTransfer internal constructor(
    private val resolveHome: suspend () -> String,
    private val openSftp: suspend () -> BridgeSshAttachmentSftp,
    private val canReadInShell: suspend (String) -> Boolean,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    constructor(transport: BridgeCbSshTransport) : this(
        resolveHome = { readRemoteHome(transport) },
        openSftp = { BridgeCbSshAttachmentSftp(transport.openSftp()) },
        canReadInShell = { path -> remoteShellCanRead(transport, path) },
    )

    suspend fun upload(
        originalName: String,
        input: InputStream,
        onProgress: (Long) -> Unit = {},
    ): BridgeSshUploadedAttachment {
        var streamOwned = false
        try {
            return withContext(Dispatchers.IO) {
                streamOwned = true
                uploadOnIo(originalName, input, onProgress)
            }
        } catch (error: Throwable) {
            // Coroutine stack-trace recovery may copy an exception across the IO
            // boundary without copying cleanup failures from the original cause.
            val cause = error.cause
            if (cause != null && cause !== error && cause.javaClass == error.javaClass && cause.message == error.message) {
                cause.suppressed.filterNot { it in error.suppressed }.forEach(error::addSuppressed)
            }
            // withContext can be cancelled before its IO block ever starts.
            if (!streamOwned) {
                try {
                    input.close()
                } catch (closeError: Throwable) {
                    error.addSuppressed(closeError)
                }
            }
            throw error
        }
    }

    private suspend fun uploadOnIo(
        originalName: String,
        input: InputStream,
        onProgress: (Long) -> Unit,
    ): BridgeSshUploadedAttachment {
        var sftp: BridgeSshAttachmentSftp? = null
        var remoteFile: BridgeSshAttachmentRemoteFile? = null
        var createdPath: String? = null
        var failure: Throwable? = null
        try {
            val result = input.use { source ->
                currentCoroutineContext().ensureActive()
                val home = checkedAbsolutePath(resolveHome())
                val connection = openSftp()
                sftp = connection
                val canonicalHome = checkedAbsolutePath(connection.realpath(home))
                val base = join(canonicalHome, ".feishu-codex-bridge")
                val directory = join(base, "ssh-attachments")
                ensureDirectory(connection, base, requirePrivate = false)
                ensureDirectory(connection, directory, requirePrivate = true)
                if (checkedAbsolutePath(connection.realpath(directory)) != directory) {
                    throw IOException("Remote attachment directory resolves outside its expected path")
                }

                val id = newId()
                require(id.matches(Regex("[A-Za-z0-9-]{1,64}"))) { "Invalid attachment identifier" }
                val path = join(directory, id + safeExtension(originalName))
                val file = connection.openExclusive(path, PRIVATE_FILE_MODE)
                // The path is eligible for cleanup only after the server has
                // confirmed exclusive creation and returned a file handle.
                remoteFile = file
                createdPath = path

                val buffer = ByteArray(CHUNK_BYTES)
                var bytes = 0L
                while (true) {
                    currentCoroutineContext().ensureActive()
                    var count = source.read(buffer)
                    if (count < 0) break
                    if (count == 0) {
                        val one = source.read()
                        if (one < 0) break
                        buffer[0] = one.toByte()
                        count = 1
                    }
                    currentCoroutineContext().ensureActive()
                    if (bytes > Long.MAX_VALUE - count) throw IOException("Attachment is too large to address")
                    file.write(bytes, buffer.copyOf(count))
                    bytes += count
                    onProgress(bytes)
                }
                file.close()
                remoteFile = null
                currentCoroutineContext().ensureActive()
                if (!canReadInShell(path)) {
                    throw IOException("The uploaded file is not readable from the current SSH shell")
                }
                currentCoroutineContext().ensureActive()
                BridgeSshUploadedAttachment(originalName, path, bytes)
            }
            sftp?.close()
            sftp = null
            return result
        } catch (error: Throwable) {
            failure = error
            val connection = sftp
            val path = createdPath
            if (connection != null && path != null) {
                withContext(NonCancellable) {
                    try {
                        withTimeout(CLEANUP_TIMEOUT_MS) {
                            try {
                                remoteFile?.close()
                            } catch (cancelled: CancellationException) {
                                throw cancelled
                            } catch (cleanupError: Throwable) {
                                error.addSuppressed(cleanupError)
                            }
                            try {
                                connection.remove(path)
                            } catch (cancelled: CancellationException) {
                                throw cancelled
                            } catch (cleanupError: Throwable) {
                                error.addSuppressed(cleanupError)
                            }
                        }
                    } catch (cleanupError: Throwable) {
                        error.addSuppressed(cleanupError)
                    }
                }
            }
            throw error
        } finally {
            try {
                sftp?.close()
            } catch (closeError: Throwable) {
                val original = failure
                if (original != null) original.addSuppressed(closeError) else throw closeError
            }
        }
    }

    companion object {
        internal const val CHUNK_BYTES = 32 * 1024
        private const val CLEANUP_TIMEOUT_MS = 5_000L
        private const val PRIVATE_DIRECTORY_MODE = 448 // 0700
        private const val PRIVATE_FILE_MODE = 384 // 0600
        private const val FILE_TYPE_MASK = 0xF000
        private const val DIRECTORY_TYPE = 0x4000
        private const val GROUP_OTHER_WRITE = 0x12 // 0022
        private const val GROUP_OTHER_PERMISSIONS = 0x3F // 0077

        private fun checkedAbsolutePath(path: String): String {
            require(path.startsWith('/') && path.none(Char::isISOControl)) { "Invalid remote absolute path" }
            require(path.split('/').none { it == "." || it == ".." }) { "Non-canonical remote path" }
            return path.trimEnd('/').ifEmpty { "/" }
        }

        private fun join(parent: String, name: String): String = parent.trimEnd('/') + "/" + name

        private fun safeExtension(originalName: String): String {
            val extension = originalName.substringAfterLast('.', "")
            return if (extension.matches(Regex("[A-Za-z0-9]{1,12}"))) ".$extension" else ""
        }

        private suspend fun ensureDirectory(
            sftp: BridgeSshAttachmentSftp,
            path: String,
            requirePrivate: Boolean,
        ) {
            var mode = sftp.lstatMode(path)
            if (mode == null) {
                try {
                    sftp.mkdir(path, PRIVATE_DIRECTORY_MODE)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (mkdirError: Throwable) {
                    // Another transfer may have created the directory after
                    // our lstat. Only continue after checking its attributes.
                    mode = sftp.lstatMode(path)
                    if (mode == null) throw mkdirError
                }
                if (mode == null) mode = sftp.lstatMode(path)
            }
            val actual = mode ?: throw IOException("Could not verify remote attachment directory")
            if (actual and FILE_TYPE_MASK != DIRECTORY_TYPE) {
                throw IOException("Remote attachment path is not a directory")
            }
            val forbidden = if (requirePrivate) GROUP_OTHER_PERMISSIONS else GROUP_OTHER_WRITE
            if (actual and forbidden != 0) {
                throw IOException("Remote attachment directory permissions are not private")
            }
        }

        private suspend fun readRemoteHome(transport: BridgeCbSshTransport): String {
            val result = transport.exec("printenv HOME", maxOutputBytes = 16 * 1024)
            val status = result.exitInfo as? SessionExit.Status
            if (status?.code != 0L) throw IOException("Could not read HOME from the SSH host")
            val output = Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(result.stdout))
                .toString()
            if (!output.endsWith('\n')) throw IOException("Invalid HOME response from the SSH host")
            return output.dropLast(1)
        }

        private suspend fun remoteShellCanRead(transport: BridgeCbSshTransport, path: String): Boolean {
            val result = transport.exec(remoteReadCheckCommand(path), maxOutputBytes = 16 * 1024)
            return (result.exitInfo as? SessionExit.Status)?.code == 0L
        }

        internal fun remoteReadCheckCommand(path: String): String {
            // Interpolate only an absolute path, as one POSIX shell word. The
            // destination basename is generated locally, never from the name.
            val checked = checkedAbsolutePath(path)
            val quoted = "'" + checked.replace("'", "'\"'\"'") + "'"
            return "test -r $quoted"
        }
    }
}

private class BridgeCbSshAttachmentSftp(private val client: SftpClient) : BridgeSshAttachmentSftp {
    override suspend fun realpath(path: String): String = client.realpath(path).getOrThrow()

    override suspend fun lstatMode(path: String): Int? {
        val result = client.lstat(path)
        if (result is SftpResult.ServerError && result.statusCode == SftpStatusCode.NO_SUCH_FILE) return null
        return result.getOrThrow().permissions ?: throw IOException("SFTP server omitted directory permissions")
    }

    override suspend fun mkdir(path: String, mode: Int) {
        client.mkdir(path, SftpAttributes(permissions = mode)).getOrThrow()
    }

    override suspend fun openExclusive(path: String, mode: Int): BridgeSshAttachmentRemoteFile {
        val handle = client.open(
            path,
            setOf(SftpOpenFlag.WRITE, SftpOpenFlag.CREATE, SftpOpenFlag.EXCLUDE),
            SftpAttributes(permissions = mode),
        ).getOrThrow()
        return BridgeCbSshAttachmentFile(client, handle)
    }

    override suspend fun remove(path: String) {
        client.remove(path).getOrThrow()
    }

    override fun close() = client.close()
}

private class BridgeCbSshAttachmentFile(
    private val client: SftpClient,
    private val handle: SftpFileHandle,
) : BridgeSshAttachmentRemoteFile {
    override suspend fun write(offset: Long, data: ByteArray) {
        client.write(handle, offset, data).getOrThrow()
    }

    override suspend fun close() {
        client.close(handle).getOrThrow()
    }
}
