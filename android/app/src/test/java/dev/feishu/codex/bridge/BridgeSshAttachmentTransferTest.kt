package dev.feishu.codex.bridge

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeSshAttachmentTransferTest {
    private val home = "/Users/测试"
    private val base = "/Users/测试/.feishu-codex-bridge"
    private val directory = "/Users/测试/.feishu-codex-bridge/ssh-attachments"

    @Test
    fun streamsInChunksAndRetainsOriginalName() = runBlocking {
        val fake = FakeSftp()
        val bytes = ByteArray(BridgeSshAttachmentTransfer.CHUNK_BYTES * 2 + 7) { (it % 251).toByte() }
        val input = TrackingInputStream(bytes)
        val progress = mutableListOf<Long>()

        val result = transfer(fake).upload("图片 说明.PDF", input) { progress.add(it) }

        assertEquals("图片 说明.PDF", result.originalName)
        assertEquals("$directory/test-id.PDF", result.remotePath)
        assertEquals(bytes.size.toLong(), result.sizeBytes)
        assertEquals(listOf(0L, 32768L, 65536L), fake.writeOffsets)
        assertEquals(listOf(32768L, 65536L, bytes.size.toLong()), progress)
        assertArrayEquals(bytes, fake.files[result.remotePath]?.toByteArray())
        assertEquals(0x4000 or 448, fake.modes[base])
        assertEquals(0x4000 or 448, fake.modes[directory])
        assertEquals(384, fake.createdFileModes.single())
        assertTrue(fake.handleClosed)
        assertTrue(fake.closed)
        assertTrue(input.closed)
    }

    @Test
    fun exclusiveCreateFailureDoesNotRemoveExistingFile() = runBlocking {
        val fake = FakeSftp()
        val path = "$directory/test-id.txt"
        val existing = byteArrayOf(1, 2, 3)
        fake.files[path] = ByteArrayOutputStream().apply { write(existing) }
        val input = TrackingInputStream(byteArrayOf(4))

        val error = runCatching { transfer(fake).upload("existing.txt", input) }.exceptionOrNull()

        assertTrue(error is IOException)
        assertTrue(fake.removed.isEmpty())
        assertArrayEquals(existing, fake.files[path]?.toByteArray())
        assertTrue(input.closed)
        assertTrue(fake.closed)
    }

    @Test
    fun failedWriteClosesAndRemovesOnlyTheCreatedFile() = runBlocking {
        val fake = FakeSftp().apply { failWriteAt = 2 }
        val unrelatedPath = "$directory/keep.txt"
        val unrelated = byteArrayOf(9, 8, 7)
        fake.files[unrelatedPath] = ByteArrayOutputStream().apply { write(unrelated) }
        val input = TrackingInputStream(ByteArray(BridgeSshAttachmentTransfer.CHUNK_BYTES + 3))

        val error = runCatching { transfer(fake).upload("新文件.txt", input) }.exceptionOrNull()

        assertTrue(error is IOException)
        assertEquals(listOf("$directory/test-id.txt"), fake.removed)
        assertArrayEquals(unrelated, fake.files[unrelatedPath]?.toByteArray())
        assertTrue(fake.handleClosed)
        assertTrue(fake.closed)
        assertTrue(input.closed)
    }

    @Test
    fun cancellationClosesHandleAndCleansUpConfirmedCreation() = runBlocking {
        val fake = FakeSftp().apply {
            afterWrite = {
                currentCoroutineContext()[Job]?.cancel(CancellationException("cancel transfer"))
            }
        }
        val input = TrackingInputStream(ByteArray(BridgeSshAttachmentTransfer.CHUNK_BYTES + 1))

        val job = launch { transfer(fake).upload("图片.png", input) }
        job.join()

        assertTrue(job.isCancelled)
        assertTrue(fake.handleClosed)
        assertEquals(listOf("$directory/test-id.png"), fake.removed)
        assertTrue(fake.closed)
        assertTrue(input.closed)
    }

    @Test
    fun cancellationBeforeIoBlockStillClosesInput() {
        val input = TrackingInputStream(byteArrayOf(1))
        val fake = FakeSftp()
        val thrown = runCatching {
            runBlocking {
                currentCoroutineContext()[Job]?.cancel()
                transfer(fake).upload("file.txt", input)
            }
        }.exceptionOrNull()

        assertTrue(thrown is CancellationException)
        assertTrue(input.closed)
        assertTrue(fake.files.isEmpty())
    }

    @Test
    fun shellCannotReadTargetAndTransferMustFail() = runBlocking {
        val fake = FakeSftp()
        val error = runCatching {
            transfer(fake, readable = false).upload("图片.png", TrackingInputStream(byteArrayOf(1)))
        }.exceptionOrNull()

        assertTrue(error is IOException)
        assertEquals(listOf("$directory/test-id.png"), fake.removed)
        assertTrue(fake.handleClosed)
    }

    @Test
    fun cleanupFailureIsRetainedOnTheOriginalError() = runBlocking {
        val fake = FakeSftp().apply {
            failWriteAt = 1
            failRemove = true
        }
        val error = runCatching {
            transfer(fake).upload("file.txt", TrackingInputStream(byteArrayOf(1)))
        }.exceptionOrNull()

        assertTrue(error is IOException)
        assertTrue(error!!.suppressed.any { it.message == "remove failed" })
        assertNotNull(fake.files["$directory/test-id.txt"])
        assertTrue(fake.closed)
    }

    @Test
    fun rejectsUnsafeHomeAndSymbolicLinkDirectories() = runBlocking {
        val badHomeSftp = FakeSftp()
        val input = TrackingInputStream(byteArrayOf(1))
        val invalidHome = runCatching {
            transfer(badHomeSftp, remoteHome = "/Users/测试\nignored").upload("file", input)
        }.exceptionOrNull()
        assertTrue(invalidHome is IllegalArgumentException)
        assertFalse(badHomeSftp.opened)
        assertTrue(input.closed)

        val symlinkSftp = FakeSftp().apply { modes[base] = 0xA000 or 448 }
        val symlink = runCatching {
            transfer(symlinkSftp).upload("file", TrackingInputStream(byteArrayOf(1)))
        }.exceptionOrNull()
        assertTrue(symlink is IOException)
        assertTrue(symlinkSftp.files.isEmpty())
        assertTrue(symlinkSftp.removed.isEmpty())
    }

    @Test
    fun rejectsDirectoryCanonicalizingOutsideHome() = runBlocking {
        val fake = FakeSftp().apply { realpathOverrides[directory] = "/elsewhere" }
        val error = runCatching {
            transfer(fake).upload("file.txt", TrackingInputStream(byteArrayOf(1)))
        }.exceptionOrNull()

        assertTrue(error is IOException)
        assertTrue(fake.files.isEmpty())
        assertTrue(fake.removed.isEmpty())
    }

    @Test
    fun readCheckQuotesTheEntireRemotePathAsOneWord() {
        val remote = "/Users/O'Brien/a ; " + 36.toChar() + "(danger).txt"
        val expected = "test -r '/Users/O'\"'\"'Brien/a ; " + 36.toChar() + "(danger).txt'"
        val command = BridgeSshAttachmentTransfer.remoteReadCheckCommand(remote)

        assertEquals(expected, command)
        BridgeCbSshTransport.requireExecCommand(command)
        assertTrue(
            runCatching { BridgeSshAttachmentTransfer.remoteReadCheckCommand("/tmp/a\ncommand") }
                .exceptionOrNull() is IllegalArgumentException,
        )
    }

    private fun transfer(
        fake: FakeSftp,
        remoteHome: String = home,
        readable: Boolean = true,
    ) = BridgeSshAttachmentTransfer(
        resolveHome = { remoteHome },
        openSftp = { fake.opened = true; fake },
        canReadInShell = { readable },
        newId = { "test-id" },
    )

    private class TrackingInputStream(data: ByteArray) : ByteArrayInputStream(data) {
        var closed = false
        override fun close() {
            closed = true
            super.close()
        }
    }

    private class FakeSftp : BridgeSshAttachmentSftp {
        val modes = mutableMapOf<String, Int>()
        val files = mutableMapOf<String, ByteArrayOutputStream>()
        val realpathOverrides = mutableMapOf<String, String>()
        val writeOffsets = mutableListOf<Long>()
        val createdFileModes = mutableListOf<Int>()
        val removed = mutableListOf<String>()
        var opened = false
        var closed = false
        var handleClosed = false
        var failWriteAt = -1
        var failRemove = false
        var afterWrite: suspend () -> Unit = {}

        override suspend fun realpath(path: String): String = realpathOverrides[path] ?: path
        override suspend fun lstatMode(path: String): Int? = modes[path]
        override suspend fun mkdir(path: String, mode: Int) {
            modes[path] = 0x4000 or mode
        }

        override suspend fun openExclusive(path: String, mode: Int): BridgeSshAttachmentRemoteFile {
            if (files.containsKey(path)) throw IOException("already exists")
            val file = ByteArrayOutputStream()
            files[path] = file
            createdFileModes.add(mode)
            return object : BridgeSshAttachmentRemoteFile {
                override suspend fun write(offset: Long, data: ByteArray) {
                    if (writeOffsets.size + 1 == failWriteAt) throw IOException("write failed")
                    assertEquals(file.size().toLong(), offset)
                    writeOffsets.add(offset)
                    file.write(data)
                    afterWrite()
                }

                override suspend fun close() {
                    handleClosed = true
                }
            }
        }

        override suspend fun remove(path: String) {
            if (failRemove) throw IOException("remove failed")
            removed.add(path)
            files.remove(path)
        }

        override fun close() {
            closed = true
        }
    }
}
