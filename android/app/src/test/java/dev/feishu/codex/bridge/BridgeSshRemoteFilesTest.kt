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
import java.io.InputStream
import java.io.OutputStream

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
    fun listingIncludesOptionalUnsignedSftpModificationTimes() = runBlocking {
        val fake = FakeSftp()
        fake.directories.addAll(listOf("/repo", "/repo/sub"))
        fake.files["/repo/readme.md"] = byteArrayOf()
        fake.files["/repo/unknown.txt"] = byteArrayOf()
        fake.modifiedTimes["/repo/sub"] = -1
        fake.modifiedTimes["/repo/readme.md"] = 1_730_000_000
        val browser = BridgeSshRemoteFiles({ "/repo" }, { fake })

        val (_, entries) = browser.list("")
        assertEquals(listOf("sub", "readme.md", "unknown.txt"), entries.map { it.name })
        assertEquals(4_294_967_295L, entries[0].modifiedAtSeconds)
        assertEquals(1_730_000_000L, entries[1].modifiedAtSeconds)
        assertEquals(null, entries[2].modifiedAtSeconds)
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

    @Test
    fun sessionFilesPreferApiAndKeepTheSessionAndRootBoundForTransfers() = runBlocking {
        val target = BridgeSshTmuxSession("\$7", "alpha", 1, false, "/repo", 42)
        val requests = mutableListOf<String>()
        val transport = BridgeSshApiTransport { _, url, _, _ ->
            requests.add(url)
            if (url.endsWith("/api/session")) BridgeSshHttpResponse(200, """{"actionToken":"action-token"}""")
            else BridgeSshHttpResponse(200, """{"root":"/repo","path":"","truncated":false,"entries":[{"name":"hello.txt","type":"file","size":5,"modifiedAt":1730000000000}]}""")
        }
        val downloads = mutableListOf<Pair<String, Map<String, String>>>()
        val uploads = mutableListOf<Pair<String, ByteArray>>()
        val files = object : BridgeSshApiFileTransport {
            override suspend fun download(url: String, headers: Map<String, String>, output: OutputStream, maxBytes: Long?): Boolean {
                downloads.add(url to headers)
                output.write("hello".toByteArray())
                return false
            }
            override suspend fun upload(url: String, headers: Map<String, String>, input: InputStream) {
                assertEquals("42", headers["X-Bridge-Session-Created-At"])
                assertEquals("new%20file.txt", headers["X-File-Name"])
                uploads.add(url to input.readBytes())
            }
        }
        val api = BridgeSshApiClient("https://bridge.example", "bridge-token", transport, files)
        val browser = BridgeSshRemoteFiles({ error("SFTP root should not be used") }, { error("SFTP should not be used") }, api, target)
        val (root, entries) = browser.list("")
        assertEquals("/repo", root)
        assertEquals("hello.txt", entries.single().relativePath)
        assertEquals(1_730_000_000L, entries.single().modifiedAtSeconds)
        assertEquals("hello", browser.preview("hello.txt").first)
        assertEquals("/repo/hello.txt", browser.absolutePath("hello.txt"))
        val output = ByteArrayOutputStream()
        browser.download("hello.txt", output)
        assertEquals("hello", output.toString("UTF-8"))
        browser.upload("", "new file.txt", ByteArrayInputStream("new".toByteArray()))
        assertEquals("new", uploads.single().second.toString(Charsets.UTF_8))
        assertTrue(uploads.single().first.contains("expectedRoot=%2Frepo"))
        assertTrue(downloads.all { it.first.contains("expectedRoot=%2Frepo") && it.second["X-Bridge-Session-Created-At"] == "42" })
        assertTrue(runCatching { browser.download("../secret", ByteArrayOutputStream()) }.isFailure)
        assertTrue(requests.any { it.contains("/sessions/%247/files") })
    }

    @Test
    fun unavailableOrTruncatedApiListingRetainsSftpFallback() = runBlocking {
        val fake = FakeSftp().apply { directories.add("/repo"); files["/repo/hello.txt"] = "hello".toByteArray() }
        val target = BridgeSshTmuxSession("\$7", "alpha", 1, false, "/repo", 42)
        for (payload in listOf("""{"root":"/repo","entries":[],"truncated":true}""", """{"root":"/repo","entries":[]}""", """{"root":"/repo","entries":[],"truncated":null}""")) {
            val api = BridgeSshApiClient("https://bridge.example", "bridge-token", BridgeSshApiTransport { _, url, _, _ ->
                if (url.endsWith("/api/session")) BridgeSshHttpResponse(200, """{"actionToken":"a"}""") else BridgeSshHttpResponse(200, payload)
            })
            val browser = BridgeSshRemoteFiles({ "/repo" }, { fake }, api, target)
            assertEquals("hello.txt", browser.list("").second.single().name)
            assertEquals("hello", browser.preview("hello.txt").first)
        }
    }

    @Test
    fun uncertainApiTransfersDoNotRepeatOrAppendViaSftp() = runBlocking {
        val target = BridgeSshTmuxSession("\$7", "alpha", 1, false, "/repo", 42)
        val api = BridgeSshApiClient("https://bridge.example", "bridge-token", BridgeSshApiTransport { _, url, _, _ ->
            if (url.endsWith("/api/session")) BridgeSshHttpResponse(200, """{"actionToken":"a"}""")
            else BridgeSshHttpResponse(200, """{"root":"/repo","entries":[],"truncated":false}""")
        }, object : BridgeSshApiFileTransport {
            override suspend fun download(url: String, headers: Map<String, String>, output: OutputStream, maxBytes: Long?): Boolean {
                output.write("partial".toByteArray())
                throw BridgeSshApiRequestException("下载中断")
            }
            override suspend fun upload(url: String, headers: Map<String, String>, input: InputStream) {
                throw BridgeSshApiRequestException("上传结果未知")
            }
        })
        var sftpCalls = 0
        val browser = BridgeSshRemoteFiles({ "/repo" }, { sftpCalls += 1; error("must not retry") }, api, target)
        val output = ByteArrayOutputStream()
        assertTrue(runCatching { browser.download("hello.txt", output) }.isFailure)
        assertEquals("partial", output.toString("UTF-8"))
        assertTrue(runCatching { browser.upload("", "new.txt", ByteArrayInputStream("new".toByteArray())) }.isFailure)
        assertEquals(0, sftpCalls)
    }

    @Test
    fun forwardingApiFileRequiresTheSshHostToReadTheSamePath() = runBlocking {
        val target = BridgeSshTmuxSession("\$7", "alpha", 1, false, "/repo", 42)
        val api = BridgeSshApiClient("https://bridge.example", "bridge-token", BridgeSshApiTransport { _, url, _, _ ->
            if (url.endsWith("/api/session")) BridgeSshHttpResponse(200, """{"actionToken":"a"}""")
            else BridgeSshHttpResponse(200, """{"root":"/repo","entries":[{"name":"hello.txt","type":"file"}],"truncated":false}""")
        })
        val browser = BridgeSshRemoteFiles({ error("not used") }, { error("not used") }, api, target, { false })
        val error = runCatching { browser.absolutePath("hello.txt") }.exceptionOrNull()
        assertTrue(error?.message.orEmpty().contains("SSH 主机无法读取"))
    }

    @Test
    fun literalBackslashesKeepTheirSftpFilenameInsteadOfBecomingApiSeparators() = runBlocking {
        val fake = FakeSftp().apply {
            directories.addAll(listOf("/repo", "/repo/folder\\name"))
            files["/repo/a\\b.txt"] = "original".toByteArray()
            files["/repo/folder\\name/inside.txt"] = "inside".toByteArray()
        }
        val target = BridgeSshTmuxSession("\$7", "alpha", 1, false, "/repo", 42)
        val requests = mutableListOf<String>()
        val api = BridgeSshApiClient("https://bridge.example", "bridge-token", BridgeSshApiTransport { _, url, _, _ ->
            requests.add(url)
            if (url.endsWith("/api/session")) BridgeSshHttpResponse(200, """{"actionToken":"a"}""")
            else BridgeSshHttpResponse(200, """{"root":"/repo","entries":[],"truncated":false}""")
        })
        val browser = BridgeSshRemoteFiles({ "/repo" }, { fake }, api, target)
        assertEquals("inside.txt", browser.list("folder\\name").second.single().name)
        val output = ByteArrayOutputStream()
        browser.download("a\\b.txt", output)
        assertEquals("original", output.toString("UTF-8"))
        browser.upload("", "new\\file.txt", ByteArrayInputStream("new".toByteArray()))
        assertEquals("new", fake.files["/repo/new\\file.txt"]!!.toString(Charsets.UTF_8))
        assertTrue(requests.none { it.contains("folder%5Cname") || it.contains("a%5Cb.txt") })
    }

    private class FakeSftp : SftpClient {
        val directories = mutableSetOf<String>()
        val files = mutableMapOf<String, ByteArray>()
        val links = mutableMapOf<String, String>()
        val modifiedTimes = mutableMapOf<String, Int>()
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
            path in directories -> SftpAttributes(permissions = 0x4000 or 448, mtime = modifiedTimes[path])
            path in files -> SftpAttributes(size = files[path]!!.size.toLong(), permissions = 0x8000 or 384, mtime = modifiedTimes[path])
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
