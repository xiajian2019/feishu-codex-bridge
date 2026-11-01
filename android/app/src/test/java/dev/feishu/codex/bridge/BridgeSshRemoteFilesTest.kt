package dev.feishu.codex.bridge

import kotlinx.coroutines.runBlocking
import org.connectbot.sshlib.SftpAttributes
import org.connectbot.sshlib.SftpClient
import org.connectbot.sshlib.SftpDirectoryEntry
import org.connectbot.sshlib.SftpFileHandle
import org.connectbot.sshlib.SftpOpenFlag
import org.connectbot.sshlib.SftpResult
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException

class BridgeSshRemoteFilesTest {
    @Test
    fun browseAndDownloadStayInsideLiveRootAndSkipSymlinks() = runBlocking {
        val fake = FakeSftp()
        fake.directories.addAll(listOf("/repo", "/repo/sub"))
        fake.files["/repo/sub/hello.txt"] = "hello".toByteArray()
        fake.links["/repo/escape"] = "/outside"
        var root = "/repo"
        val browser = BridgeSshRemoteFiles({ root }, { fake })
        val (_, entries) = browser.list("")
        assertEquals(listOf("sub"), entries.map { it.name })
        assertEquals("hello", browser.preview("sub/hello.txt").first)
        val output = ByteArrayOutputStream()
        browser.download("sub/hello.txt", output)
        assertEquals("hello", output.toString("UTF-8"))
        assertTrue(runCatching { browser.absolutePath("../secret") }.isFailure)
        assertTrue(runCatching { browser.absolutePath("escape") }.isFailure)
        root = "/other"
        fake.directories.add("/other")
        assertTrue(runCatching { browser.list("") }.isFailure)
    }

    @Test
    fun uploadsAreExclusiveAndFailedWritesCleanOnlyTheirOwnPartialFile() = runBlocking {
        val fake = FakeSftp()
        fake.directories.add("/repo")
        fake.files["/repo/existing.txt"] = "keep".toByteArray()
        val browser = BridgeSshRemoteFiles({ "/repo" }, { fake })
        assertTrue(runCatching { browser.upload("", "existing.txt", ByteArrayInputStream("new".toByteArray())) }.isFailure)
        assertEquals("keep", fake.files["/repo/existing.txt"]!!.toString(Charsets.UTF_8))
        val content = ByteArray(70_000) { (it % 127).toByte() }
        browser.upload("", "new.bin", ByteArrayInputStream(content))
        assertArrayEquals(content, fake.files["/repo/new.bin"])
        fake.failWrite = true
        assertTrue(runCatching { browser.upload("", "partial.bin", ByteArrayInputStream(content)) }.isFailure)
        assertFalse(fake.files.containsKey("/repo/partial.bin"))
        assertTrue(fake.files.containsKey("/repo/existing.txt"))
    }

    private class FakeSftp : SftpClient {
        val directories = mutableSetOf<String>()
        val files = mutableMapOf<String, ByteArray>()
        val links = mutableMapOf<String, String>()
        private val handles = mutableMapOf<SftpFileHandle, String>()
        var failWrite = false
        override val protocolVersion: Int = 3
        override val isOpen: Boolean = true

        override suspend fun realpath(path: String): SftpResult<String> {
            if (path !in directories && path !in files && path !in links) throw IOException("missing")
            return SftpResult.Success(links[path] ?: path)
        }
        override suspend fun lstat(path: String): SftpResult<SftpAttributes> = SftpResult.Success(attributes(path))
        override suspend fun stat(path: String): SftpResult<SftpAttributes> = SftpResult.Success(attributes(links[path] ?: path))
        private fun attributes(path: String): SftpAttributes = when {
            path in links -> SftpAttributes(permissions = 0xA000 or 511)
            path in directories -> SftpAttributes(permissions = 0x4000 or 448)
            path in files -> SftpAttributes(size = files[path]!!.size.toLong(), permissions = 0x8000 or 384)
            else -> throw IOException("missing")
        }
        override suspend fun listdir(path: String): SftpResult<List<SftpDirectoryEntry>> {
            val prefix = path.trimEnd('/') + "/"
            val children = (directories + files.keys + links.keys).filter { it.startsWith(prefix) && '/' !in it.removePrefix(prefix) }
            return SftpResult.Success(children.map { SftpDirectoryEntry(it.removePrefix(prefix), "", attributes(it)) })
        }
        override suspend fun open(path: String, flags: Set<SftpOpenFlag>, attrs: SftpAttributes): SftpResult<SftpFileHandle> {
            if (SftpOpenFlag.EXCLUDE in flags && path in files) throw IOException("exists")
            if (SftpOpenFlag.CREATE in flags) files[path] = byteArrayOf()
            if (path !in files) throw IOException("missing")
            val handle = SftpFileHandle::class.java.getDeclaredConstructor(ByteArray::class.java).newInstance(path.toByteArray())
            handles[handle] = path
            return SftpResult.Success(handle)
        }
        override suspend fun read(handle: SftpFileHandle, offset: Long, length: Int): SftpResult<ByteArray?> {
            val data = files.getValue(handles.getValue(handle))
            val start = offset.toInt()
            return SftpResult.Success(if (start >= data.size) null else data.copyOfRange(start, minOf(data.size, start + length)))
        }
        override suspend fun write(handle: SftpFileHandle, offset: Long, data: ByteArray): SftpResult<Unit> {
            if (failWrite) throw IOException("write failed")
            val path = handles.getValue(handle)
            val old = files.getValue(path)
            val next = old.copyOf(maxOf(old.size, offset.toInt() + data.size))
            data.copyInto(next, offset.toInt())
            files[path] = next
            return SftpResult.Success(Unit)
        }
        override suspend fun close(handle: SftpFileHandle): SftpResult<Unit> { handles.remove(handle); return SftpResult.Success(Unit) }
        override suspend fun remove(path: String): SftpResult<Unit> { files.remove(path); return SftpResult.Success(Unit) }
        override fun close() = Unit
        override suspend fun fstat(handle: SftpFileHandle): SftpResult<SftpAttributes> = stat(handles.getValue(handle))
        override suspend fun setstat(path: String, attrs: SftpAttributes): SftpResult<Unit> = throw UnsupportedOperationException()
        override suspend fun fsetstat(handle: SftpFileHandle, attrs: SftpAttributes): SftpResult<Unit> = throw UnsupportedOperationException()
        override suspend fun opendir(path: String): SftpResult<SftpFileHandle> = throw UnsupportedOperationException()
        override suspend fun readdir(handle: SftpFileHandle): SftpResult<List<SftpDirectoryEntry>> = throw UnsupportedOperationException()
        override suspend fun mkdir(path: String, attrs: SftpAttributes): SftpResult<Unit> = throw UnsupportedOperationException()
        override suspend fun rmdir(path: String): SftpResult<Unit> = throw UnsupportedOperationException()
        override suspend fun rename(oldPath: String, newPath: String): SftpResult<Unit> = throw UnsupportedOperationException()
        override suspend fun readlink(path: String): SftpResult<String> = throw UnsupportedOperationException()
        override suspend fun symlink(targetPath: String, linkPath: String): SftpResult<Unit> = throw UnsupportedOperationException()
    }
}
