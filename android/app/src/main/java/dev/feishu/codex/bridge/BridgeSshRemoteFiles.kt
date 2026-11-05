package dev.feishu.codex.bridge

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.connectbot.sshlib.SessionExit
import org.connectbot.sshlib.SftpAttributes
import org.connectbot.sshlib.SftpClient
import org.connectbot.sshlib.SftpOpenFlag
import org.connectbot.sshlib.getOrThrow
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream

internal data class BridgeSshRemoteFile(
    val name: String,
    val relativePath: String,
    val directory: Boolean,
    val size: Long?,
    val modifiedAtSeconds: Long?,
)

/** A read/transfer boundary rooted at the current SSH host and tmux identity. */
internal class BridgeSshRemoteFiles internal constructor(
    private val resolveCurrentRoot: suspend () -> String,
    private val openSftp: suspend () -> SftpClient,
    private val api: BridgeSshApiClient? = null,
    private val apiTarget: BridgeSshTmuxSession? = null,
    private val canReadRemote: suspend (String) -> Boolean = { true },
) {
    constructor(transport: BridgeCbSshTransport, target: BridgeSshTmuxSession?, tmux: BridgeSshTmuxClient?, api: BridgeSshApiClient? = null) : this(
        resolveCurrentRoot = {
            if (target != null) {
                val live = checkNotNull(tmux).listSessions().firstOrNull { it.id == target.id && it.createdAt == target.createdAt }
                    ?: error("tmux Session 已失效，请重新打开文件页。")
                live.cwd
            } else {
                val home = transport.exec("printenv HOME", maxOutputBytes = 16 * 1024)
                check((home.exitInfo as? SessionExit.Status)?.code == 0L) { "无法读取 SSH 主机目录。" }
                home.stdout.toString(Charsets.UTF_8).trimEnd('\r', '\n')
            }
        },
        openSftp = { transport.openSftp() },
        api = api,
        apiTarget = target,
        canReadRemote = { path ->
            val result = transport.exec(BridgeSshAttachmentTransfer.remoteReadCheckCommand(path), maxOutputBytes = 16 * 1024)
            (result.exitInfo as? SessionExit.Status)?.code == 0L
        },
    )

    private var initialRoot: String? = null

    suspend fun list(relative: String): Pair<String, List<BridgeSshRemoteFile>> = withContext(Dispatchers.IO) {
        requireRelative(relative)
        if (api != null && apiTarget != null) {
            try {
                val result = api.listFiles(apiTarget, relative, initialRoot)
                rememberRoot(result.first)
                return@withContext result
            } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (_: BridgeSshApiFallbackException) { /* Continue with the SSH host's SFTP. */ }
        }
        openSftp().use { sftp ->
            val root = root(sftp)
            val path = checkedPath(sftp, root, relative, directory = true)
            val entries = sftp.listdir(path).getOrThrow().mapNotNull { entry ->
                val name = entry.filename
                if (!validName(name)) return@mapNotNull null
                val type = (entry.attrs.permissions ?: return@mapNotNull null) and TYPE_MASK
                if (type != DIRECTORY && type != REGULAR) return@mapNotNull null
                val child = if (relative.isEmpty()) name else "$relative/$name"
                // SFTP v3 encodes timestamps as unsigned 32-bit seconds.
                val modifiedAt = entry.attrs.mtime?.toLong()?.and(0xffff_ffffL)
                BridgeSshRemoteFile(name, child, type == DIRECTORY, entry.attrs.size, modifiedAt)
            }.sortedWith(compareByDescending<BridgeSshRemoteFile> { it.directory }.thenBy { it.name.lowercase() })
            root to entries
        }
    }

    suspend fun preview(relative: String): Pair<String, Boolean> = withContext(Dispatchers.IO) {
        val buffer = ByteArrayOutputStream()
        val truncated = transferApiFirst(relative, buffer, PREVIEW_BYTES)
        val bytes = buffer.toByteArray()
        require(bytes.none { it == 0.toByte() }) { "此文件不是文本，请下载后打开。" }
        bytes.toString(Charsets.UTF_8) to truncated
    }

    suspend fun absolutePath(relative: String): String = withContext(Dispatchers.IO) {
        requireRelative(relative)
        if (api != null && apiTarget != null && relative.isNotEmpty()) {
            try {
                val parent = relative.substringBeforeLast('/', "")
                val name = relative.substringAfterLast('/')
                val result = api.listFiles(apiTarget, parent, initialRoot)
                rememberRoot(result.first)
                check(result.second.any { it.name == name && !it.directory }) { "文件已失效或无法访问。" }
                val path = result.first.trimEnd('/') + "/" + relative
                if (!canReadRemote(path)) throw BridgeSshApiRequestException("当前 SSH 主机无法读取此文件，请核对 Bridge 和 SSH 目标。")
                return@withContext path
            } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (_: BridgeSshApiFallbackException) { /* Continue with the SSH host's SFTP. */ }
        }
        openSftp().use { sftp -> checkedPath(sftp, root(sftp), relative, directory = false) }
    }

    suspend fun download(relative: String, output: OutputStream) = withContext(Dispatchers.IO) {
        transferApiFirst(relative, output, null)
    }

    private suspend fun transferApiFirst(relative: String, output: OutputStream, maxBytes: Long?): Boolean {
        requireRelative(relative)
        if (api != null && apiTarget != null) {
            try {
                val root = apiRoot(api, apiTarget)
                return api.downloadFile(apiTarget, relative, root, output, maxBytes)
            } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (_: BridgeSshApiFallbackException) { /* No API bytes reached output; try SFTP. */ }
        }
        return transfer(relative, output, maxBytes)
    }

    private suspend fun transfer(relative: String, output: OutputStream, maxBytes: Long?): Boolean {
        return openSftp().use { sftp ->
            val root = root(sftp)
            val path = checkedPath(sftp, root, relative, directory = false)
            val size = sftp.stat(path).getOrThrow().size ?: error("无法读取远端文件大小。")
            val handle = sftp.open(path, setOf(SftpOpenFlag.READ), SftpAttributes()).getOrThrow()
            try {
                val end = minOf(size, maxBytes ?: size)
                var offset = 0L
                while (offset < end) {
                    currentCoroutineContext().ensureActive()
                    val count = minOf(CHUNK_BYTES.toLong(), end - offset).toInt()
                    val bytes = sftp.read(handle, offset, count).getOrThrow() ?: error("远端文件读取中断。")
                    check(bytes.isNotEmpty()) { "远端文件读取中断。" }
                    output.write(bytes)
                    offset += bytes.size
                }
                size > end
            } finally { withContext(NonCancellable) { runCatching { withTimeout(5_000) { sftp.close(handle).getOrThrow() } } } }
        }
    }

    suspend fun upload(relativeDirectory: String, name: String, input: InputStream) = withContext(Dispatchers.IO) {
        require(validName(name)) { "文件名无效。" }
        requireRelative(relativeDirectory)
        if (api != null && apiTarget != null) {
            try {
                val root = apiRoot(api, apiTarget)
                api.uploadFile(apiTarget, relativeDirectory, root, name, input)
                return@withContext
            } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (_: BridgeSshApiFallbackException) { /* No upload was started; try SFTP. */ }
        }
        openSftp().use { sftp ->
            val root = root(sftp)
            val directory = checkedPath(sftp, root, relativeDirectory, directory = true)
            val path = directory.trimEnd('/') + "/" + name
            val handle = sftp.open(path, setOf(SftpOpenFlag.WRITE, SftpOpenFlag.CREATE, SftpOpenFlag.EXCLUDE),
                SftpAttributes(permissions = 384)).getOrThrow()
            var complete = false
            try {
                val buffer = ByteArray(CHUNK_BYTES)
                var offset = 0L
                input.use { source ->
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
                        require(offset + count <= MAX_UPLOAD_BYTES) { "文件超过 100 MiB。" }
                        sftp.write(handle, offset, buffer.copyOf(count)).getOrThrow()
                        offset += count
                    }
                }
                sftp.close(handle).getOrThrow()
                complete = true
            } finally {
                if (!complete) {
                    withContext(NonCancellable) {
                        runCatching { withTimeout(5_000) { sftp.close(handle).getOrThrow() } }
                        runCatching { withTimeout(5_000) { sftp.remove(path).getOrThrow() } }
                    }
                }
            }
        }
    }

    private suspend fun root(sftp: SftpClient): String {
        val raw = resolveCurrentRoot()
        require(raw.startsWith('/') && raw.none(Char::isISOControl)) { "远端目录无效。" }
        val canonical = sftp.realpath(raw).getOrThrow().trimEnd('/').ifEmpty { "/" }
        rememberRoot(canonical)
        return canonical
    }

    private suspend fun apiRoot(client: BridgeSshApiClient, target: BridgeSshTmuxSession): String {
        val root = client.listFiles(target, "", initialRoot).first
        rememberRoot(root)
        return root
    }

    private fun rememberRoot(root: String) {
        val canonical = root.trimEnd('/').ifEmpty { "/" }
        val previous = initialRoot
        check(previous == null || previous == canonical) { "Session 目录已变化，请重新打开文件页。" }
        initialRoot = canonical
    }

    private fun requireRelative(relative: String) {
        require(relative.isEmpty() || relative.split('/').all(::validName)) { "路径无效。" }
    }

    private suspend fun checkedPath(sftp: SftpClient, root: String, relative: String, directory: Boolean): String {
        require(relative.isEmpty() || relative.split('/').all(::validName)) { "路径无效。" }
        var path = root
        for (part in relative.split('/').filter(String::isNotEmpty)) {
            path = path.trimEnd('/') + "/" + part
            val mode = sftp.lstat(path).getOrThrow().permissions ?: error("无法验证远端路径。")
            check(mode and TYPE_MASK != SYMLINK) { "不支持符号链接。" }
            val real = sftp.realpath(path).getOrThrow()
            check(root == "/" || real == root || real.startsWith("$root/")) { "路径超出当前目录。" }
        }
        val mode = sftp.lstat(path).getOrThrow().permissions ?: error("无法验证远端路径。")
        check(mode and TYPE_MASK == if (directory) DIRECTORY else REGULAR) { "文件类型已变化。" }
        return path
    }

    companion object {
        private const val CHUNK_BYTES = 32 * 1024
        private const val PREVIEW_BYTES = 2L * 1024 * 1024
        private const val MAX_UPLOAD_BYTES = 100L * 1024 * 1024
        private const val TYPE_MASK = 0xF000
        private const val DIRECTORY = 0x4000
        private const val REGULAR = 0x8000
        private const val SYMLINK = 0xA000
        internal fun validName(name: String): Boolean = name.isNotEmpty() && name != "." && name != ".." &&
            '/' !in name && name.none(Char::isISOControl)
    }
}
