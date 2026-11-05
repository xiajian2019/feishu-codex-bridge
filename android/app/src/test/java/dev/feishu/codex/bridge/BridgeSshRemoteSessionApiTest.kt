package dev.feishu.codex.bridge

import java.io.IOException
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.connectbot.sshlib.SessionExit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeSshRemoteSessionApiTest {
    private val target = BridgeSshTmuxSession(
        id = "\$7",
        name = "alpha",
        windows = 1,
        attached = true,
        cwd = "/fixture",
        createdAt = 42L,
    )

    @Test
    fun accountAndUsageOperationsUseBridgeApiWithTokenAndSessionGuard() = runBlocking {
        val transport = RecordingApiTransport { method, path, body ->
            when {
                path == "https://bridge.example/api/session" -> response(200, "{\"actionToken\":\"action-token\"}")
                path.endsWith("/sessions/%247/identity") -> response(200, "{\"session\":{\"id\":\"\$7\",\"codexHomeId\":\"second\"}}")
                path.endsWith("/api/codex-homes") -> response(200, "{\"codexHomes\":[{\"id\":\"second\",\"label\":\"Second\",\"available\":true}]}" )
                path == "https://bridge.example/api/codex/homes" -> response(200, "{\"homes\":[{\"id\":\"second\",\"path\":\"/home/.codex/accounts/second\",\"label\":\"Second\"}]}" )
                path == "https://bridge.example/api/codex/usage?home=second" -> response(200, "{\"accounts\":[{\"homeId\":\"second\",\"quota\":{\"planType\":\"plus\",\"buckets\":[{\"limitId\":\"codex\",\"primary\":{\"usedPercent\":16}}]}}]}" )
                method == "POST" && path.endsWith("/codex-account") -> response(200, "{\"session\":{\"codexHomeId\":\"second\"}}")
                method == "POST" && path.endsWith("/codex-account/check") -> response(200, "{\"status\":\"matched\",\"home\":{\"id\":\"second\"}}")
                else -> error("unexpected request: $method $path body=$body")
            }
        }
        val client = BridgeSshApiClient("https://bridge.example", "bridge-token", transport)

        assertEquals("second", client.call("accounts", target).getString("selected"))
        assertEquals("second", client.call("mark_account", target, mapOf("home" to "second")).getString("selected"))
        assertEquals("second", client.call("refresh_account", target).getString("selected"))
        assertEquals(16, client.call("usage", target, mapOf("home" to "second"))
            .getJSONObject("rateLimitsByLimitId").getJSONObject("codex")
            .getJSONObject("primary").getInt("usedPercent"))

        assertTrue(transport.requests.isNotEmpty())
        transport.requests.forEach { request ->
            assertEquals("Bearer bridge-token", request.headers["Authorization"])
            assertEquals("capacitor://localhost", request.headers["Origin"])
            if (request.path != "https://bridge.example/api/session") {
                assertEquals("action-token", request.headers["X-Bridge-Action-Token"])
            }
        }
        val sessionRequests = transport.requests.filter { it.path.endsWith("/sessions/%247/identity") }
        assertTrue(sessionRequests.isNotEmpty())
        assertTrue(sessionRequests.all { it.headers["X-Bridge-Session-Created-At"] == "42" })
        val mark = transport.requests.first { it.method == "POST" && it.path.endsWith("/codex-account") }
        assertEquals("{\"homeId\":\"second\"}", mark.body)
        assertEquals("42", mark.headers["X-Bridge-Session-Created-At"])
    }

    @Test
    fun networkAuthMissingAndServerErrorsAreFallbackSignals() = runBlocking {
        listOf(401, 403, 404, 500).forEach { status ->
            val client = BridgeSshApiClient(
                "https://bridge.example",
                "bridge-token",
                RecordingApiTransport { _, _, _ -> response(status, "{}") },
            )
            val failure = runCatching { client.call("accounts", target) }.exceptionOrNull()
            assertTrue(failure is BridgeSshApiFallbackException)
            assertEquals("HTTP $status", (failure as BridgeSshApiFallbackException).diagnostic)
        }

        val network = BridgeSshApiClient(
            "https://bridge.example",
            "bridge-token",
            object : BridgeSshApiTransport {
                override suspend fun request(method: String, url: String, headers: Map<String, String>, body: String?) =
                    throw IOException("untrusted network detail")
            },
        )
        val networkFailure = runCatching { network.call("accounts", target) }.exceptionOrNull()
        assertTrue(networkFailure is BridgeSshApiFallbackException)
        assertEquals("网络不可达", (networkFailure as BridgeSshApiFallbackException).diagnostic)

        val malformed = BridgeSshApiClient(
            "https://bridge.example",
            "bridge-token",
            RecordingApiTransport { _, _, _ -> response(200, "not-json") },
        )
        assertTrue(runCatching { malformed.call("accounts", target) }.exceptionOrNull() is BridgeSshApiFallbackException)
    }

    @Test
    fun gitListDiffAndPreviewUseSessionGuardAndPreserveTheRequestedFile() = runBlocking {
        val transport = RecordingApiTransport { _, path, _ ->
            when {
                path.endsWith("/api/session") -> response(200, """{"actionToken":"action-token"}""")
                path.endsWith("/git-changes") -> response(200, """{"gitRoot":"/repo with spaces","branch":"feature/test","patchTruncated":false,"files":[{"path":"one file.txt","status":"modified","sizeBytes":4},{"path":"new.txt","status":"untracked","sizeBytes":2}],"patch":"diff --git a/one file.txt b/one file.txt\n--- a/one file.txt\n+++ b/one file.txt\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/new.txt b/new.txt\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+other\n"}""")
                path.contains("/git-changes/content?") -> response(200, """{"kind":"text","text":"new\n","truncated":false}""")
                else -> error("unexpected path: $path")
            }
        }
        val client = BridgeSshApiClient("https://bridge.example", "bridge-token", transport)
        val list = client.call("git_list", target)
        assertEquals("/repo with spaces", list.getString("root"))
        assertEquals(" M", list.getJSONArray("files").getJSONObject(0).getString("status"))
        assertEquals("??", list.getJSONArray("files").getJSONObject(1).getString("status"))
        val args = mapOf("root" to "/repo with spaces", "path" to "one file.txt")
        val diff = client.call("git_diff", target, args).getString("text")
        assertTrue(diff.contains("+new"))
        assertFalse(diff.contains("+other"))
        assertEquals("new\n", client.call("git_preview", target, args).getString("text"))
        assertTrue(transport.requests.filter { it.path.contains("/git-changes") }
            .all { it.headers["X-Bridge-Session-Created-At"] == "42" })
        assertTrue(transport.requests.any { it.path.contains("path=one%20file.txt&expectedGitRoot=%2Frepo%20with%20spaces") })
        assertTrue(runCatching { client.call("git_diff", target, args + ("root" to "/other")) }.isFailure)
        assertTrue(runCatching { client.call("git_preview", target, args + ("path" to "../secret")) }.isFailure)
    }

    @Test
    fun sessionActionsUseExistingApiAndRequireTheOriginalSessionIdentity() = runBlocking {
        val transport = RecordingApiTransport { method, path, _ ->
            when {
                path.endsWith("/api/session") -> response(200, """{"actionToken":"action-token"}""")
                path.endsWith("/identity") -> response(200, """{"session":{"name":"alpha"}}""")
                path.endsWith("/sessions/suspended") -> response(200, """{"sessions":[{"id":"${'$'}7","createdAt":42,"name":"alpha"}]}""")
                path.endsWith("/resume") -> response(200, """{"session":{"name":"alpha"}}""")
                method == "DELETE" -> response(204, "")
                method == "POST" -> response(200, """{"ok":true}""")
                else -> error("unexpected request: $method $path")
            }
        }
        val client = BridgeSshApiClient("https://bridge.example", "bridge-token", transport)
        for (action in listOf("save", "suspend", "end")) {
            assertEquals("alpha", client.call(action, target).getString("name"))
        }
        assertEquals(1, client.call("list_suspended").getJSONArray("sessions").length())
        assertEquals("alpha", client.call("restore", identity = BridgeSshTmuxIdentity("\$7", 42)).getString("name"))
        val writes = transport.requests.filter { it.method != "GET" }
        assertEquals(4, writes.size)
        assertTrue(writes.all { it.headers["X-Bridge-Session-Created-At"] == "42" })
        assertTrue(runCatching { client.call("restore", identity = BridgeSshTmuxIdentity("\$7", 43)) }.isFailure)
        assertEquals(4, transport.requests.count { it.method != "GET" })
    }

    @Test
    fun readFailureFallsBackButAnUncertainWriteIsNeverRepeatedViaSsh() = runBlocking {
        var sshCalls = 0
        val ssh: suspend (String, Int) -> BridgeCbSshExecResult = { _, _ ->
            sshCalls += 1
            BridgeCbSshExecResult("BRIDGE_SSH_RESULT:{\"ok\":true,\"result\":{\"name\":\"fallback\"}}\n".toByteArray(), ByteArray(0), SessionExit.Status(0))
        }
        val offline = BridgeSshApiClient("https://bridge.example", "bridge-token", RecordingApiTransport { _, _, _ ->
            throw IOException("offline")
        })
        assertEquals("fallback", BridgeSshRemoteSession(ssh, offline).call("git_list", target).getString("name"))
        assertEquals(1, sshCalls)

        val interruptedWrite = BridgeSshApiClient("https://bridge.example", "bridge-token", RecordingApiTransport { method, path, _ ->
            when {
                path.endsWith("/api/session") -> response(200, """{"actionToken":"action-token"}""")
                path.endsWith("/identity") -> response(200, """{"session":{"name":"alpha"}}""")
                method == "POST" -> throw IOException("connection dropped after request")
                else -> error("unexpected request")
            }
        })
        val failure = runCatching { BridgeSshRemoteSession(ssh, interruptedWrite).call("suspend", target) }.exceptionOrNull()
        assertTrue(failure?.message.orEmpty().contains("结果未知"))
        assertEquals("a possibly completed API write must not be retried through SSH", 1, sshCalls)
    }

    @Test
    fun tmuxAndSkillsPreferApiAndRetainSshFallback() = runBlocking {
        val transport = RecordingApiTransport { _, path, _ ->
            when {
                path.endsWith("/api/session") -> response(200, """{"actionToken":"action-token"}""")
                path.endsWith("/sessions?includeHomes=0") -> response(200, """{"sessions":[{"id":"${'$'}7","name":"alpha","cwd":"/fixture","windows":1,"createdAt":42,"attachedClients":1,"endedAt":null,"suspendedAt":null},{"id":"${'$'}8","name":"old","cwd":"/fixture","windows":0,"createdAt":40,"endedAt":"done"}]}""")
                path.endsWith("/identity") -> response(200, """{"session":{"name":"alpha"}}""")
                path.endsWith("/skills?all=1") -> response(200, """{"skills":[{"skillName":"project-skill","descriptionZh":"项目"}]}""")
                else -> error("unexpected path: $path")
            }
        }
        val client = BridgeSshApiClient("https://bridge.example", "bridge-token", transport)
        var fallbacks = 0
        val ssh: suspend (String, Int) -> BridgeCbSshExecResult = { _, _ -> error("not used") }
        val remote = BridgeSshRemoteSession(ssh, client)
        val sessions = remote.listSessions { fallbacks += 1; emptyList() }
        assertEquals(listOf(target.copy(attached = true)), sessions)
        assertEquals("project-skill", remote.listSkills(target) { fallbacks += 1; emptyList() }.single().name)
        assertEquals("ssh-global", remote.listSkills(null) { listOf(BridgeSshSkill("ssh-global", "")) }.single().name)
        assertEquals(0, fallbacks)
        val skillsRequest = transport.requests.first { it.path.endsWith("/skills?all=1") }
        assertEquals("42", skillsRequest.headers["X-Bridge-Session-Created-At"])

        val offline = BridgeSshApiClient("https://bridge.example", "bridge-token", RecordingApiTransport { _, _, _ -> throw IOException("offline") })
        val fallback = BridgeSshRemoteSession(ssh, offline)
        assertEquals(listOf(target), fallback.listSessions { listOf(target) })
        assertEquals("ssh-skill", fallback.listSkills(target) { listOf(BridgeSshSkill("ssh-skill", "")) }.single().name)
        val malformed = BridgeSshApiClient("https://bridge.example", "bridge-token", RecordingApiTransport { _, path, _ ->
            if (path.endsWith("/api/session")) response(200, """{"actionToken":"a"}""")
            else response(200, """{"sessions":[{"id":"${'$'}7","name":"alpha","windows":1,"createdAt":42}]}""")
        })
        assertEquals(listOf(target), BridgeSshRemoteSession(ssh, malformed).listSessions { listOf(target) })
    }

    @Test
    fun composerAttachmentUsesChunksAndFallsBackOnlyBeforeUploadStarts() = runBlocking {
        val file = File.createTempFile("bridge-attachment-test-", ".bin")
        try {
            val content = ByteArray(2 * 1024 * 1024 + 17) { (it % 127).toByte() }
            file.writeBytes(content)
            val received = ByteArrayOutputStream()
            val progress = mutableListOf<Long>()
            val transport = RecordingApiTransport { method, path, _ ->
                when {
                    path.endsWith("/api/session") -> response(200, """{"actionToken":"action-token"}""")
                    path.endsWith("/identity") -> response(200, """{"session":{"name":"alpha"}}""")
                    method == "POST" && path.endsWith("/attachments/uploads") -> response(201, """{"id":"abcdef-123","offset":0,"chunkBytes":8388608}""")
                    path.endsWith("/complete") -> response(200, """{"filePath":"/remote/attachment.bin","sizeBytes":${content.size}}""")
                    else -> error("unexpected path: $path")
                }
            }
            val fileTransport = object : BridgeSshApiFileTransport {
                override suspend fun download(url: String, headers: Map<String, String>, output: OutputStream, maxBytes: Long?) = error("not used")
                override suspend fun upload(url: String, headers: Map<String, String>, input: InputStream) = error("not used")
                override suspend fun uploadChunk(url: String, headers: Map<String, String>, data: ByteArray, length: Int): String {
                    assertTrue(url.endsWith("?offset=${received.size()}"))
                    assertEquals("42", headers["X-Bridge-Session-Created-At"])
                    assertEquals("android-native-ssh", headers["X-Bridge-Client"])
                    received.write(data, 0, length)
                    return """{"offset":${received.size()}}"""
                }
            }
            val client = BridgeSshApiClient("https://bridge.example", "bridge-token", transport, fileTransport)
            val ssh: suspend (String, Int) -> BridgeCbSshExecResult = { _, _ -> error("not used") }
            var fallbacks = 0
            val remote = BridgeSshRemoteSession(ssh, client)
            val result = remote.uploadComposerAttachment(target, "test.bin", "application/octet-stream", file,
                onProgress = progress::add, canReadRemote = { it == "/remote/attachment.bin" },
                fallback = { fallbacks += 1; error("must use API") })
            assertEquals("/remote/attachment.bin", result.remotePath)
            assertArrayEquals(content, received.toByteArray())
            assertEquals(listOf(1_048_576L, 2_097_152L, content.size.toLong()), progress)
            assertEquals(0, fallbacks)

            val offline = BridgeSshApiClient("https://bridge.example", "bridge-token", RecordingApiTransport { _, _, _ -> throw IOException("offline") })
            val fallback = BridgeSshRemoteSession(ssh, offline).uploadComposerAttachment(target, "test.bin", "application/octet-stream", file,
                onProgress = {}, canReadRemote = { true }, fallback = { fallbacks += 1; BridgeSshUploadedAttachment("test.bin", "/ssh/file", 1) })
            assertEquals("/ssh/file", fallback.remotePath)
            assertEquals(1, fallbacks)

            val interrupted = BridgeSshApiClient("https://bridge.example", "bridge-token", RecordingApiTransport { method, path, _ ->
                when {
                    path.endsWith("/api/session") -> response(200, """{"actionToken":"action-token"}""")
                    path.endsWith("/identity") -> response(200, """{"session":{"name":"alpha"}}""")
                    method == "POST" -> throw IOException("response lost")
                    else -> error("unexpected path")
                }
            })
            val error = runCatching { BridgeSshRemoteSession(ssh, interrupted).uploadComposerAttachment(target, "test.bin", "application/octet-stream", file,
                onProgress = {}, canReadRemote = { true }, fallback = { fallbacks += 1; error("must not retry") }) }.exceptionOrNull()
            assertTrue(error?.message.orEmpty().contains("结果未知"))
            assertEquals(1, fallbacks)
        } finally { file.delete() }
    }

    @Test
    fun localSuspendedSnapshotsRemainVisibleAndPreferApiRestoreWhenSupported() = runBlocking {
        val api = BridgeSshApiClient("https://bridge.example", "bridge-token", RecordingApiTransport { method, path, _ ->
            when {
                path.endsWith("/api/session") -> response(200, """{"actionToken":"a"}""")
                path.endsWith("/sessions/suspended") -> response(200, """{"sessions":[{"id":"${'$'}7","createdAt":42,"name":"web"},{"id":"${'$'}8","createdAt":43,"name":"local","source":"ssh-fallback"}]}""")
                method == "POST" && path.endsWith("/resume?source=ssh-fallback") -> response(200, """{"session":{"name":"local"}}""")
                else -> error("unexpected path: $path")
            }
        })
        var sshCalls = 0
        val remote = BridgeSshRemoteSession({ _, _ ->
            sshCalls += 1
            BridgeCbSshExecResult("""BRIDGE_SSH_RESULT:{"ok":true,"result":{"sessions":[{"id":"${'$'}8","createdAt":43,"name":"local","source":"ssh-fallback"}]}}""".toByteArray(), ByteArray(0), SessionExit.Status(0))
        }, api)
        val list = remote.call("list_suspended").getJSONArray("sessions")
        assertEquals(2, list.length())
        assertEquals(1, sshCalls)
        assertEquals("local", remote.call("restore", arguments = mapOf("source" to "ssh-fallback"),
            identity = BridgeSshTmuxIdentity("\$8", 43)).getString("name"))
        assertEquals("API restore should not repeat over SSH", 1, sshCalls)

        val oldApi = BridgeSshApiClient("https://bridge.example", "bridge-token", RecordingApiTransport { _, path, _ ->
            if (path.endsWith("/api/session")) response(200, """{"actionToken":"a"}""") else response(200, """{"sessions":[]}""")
        })
        val older = BridgeSshRemoteSession({ _, _ ->
            sshCalls += 1
            BridgeCbSshExecResult("""BRIDGE_SSH_RESULT:{"ok":true,"result":{"name":"local","source":"ssh-fallback"}}""".toByteArray(), ByteArray(0), SessionExit.Status(0))
        }, oldApi)
        assertEquals("ssh-fallback", older.call("restore", arguments = mapOf("source" to "ssh-fallback"),
            identity = BridgeSshTmuxIdentity("\$8", 43)).getString("source"))
        assertEquals(2, sshCalls)
    }

    private fun response(status: Int, body: String) = BridgeSshHttpResponse(status, body)

    private data class Request(
        val method: String,
        val path: String,
        val headers: Map<String, String>,
        val body: String?,
    )

    private class RecordingApiTransport(
        private val handler: suspend (method: String, path: String, body: String?) -> BridgeSshHttpResponse,
    ) : BridgeSshApiTransport {
        val requests = mutableListOf<Request>()

        override suspend fun request(
            method: String,
            url: String,
            headers: Map<String, String>,
            body: String?,
        ): BridgeSshHttpResponse {
            requests += Request(method, url, headers.toMap(), body)
            return handler(method, url, body)
        }
    }
}
