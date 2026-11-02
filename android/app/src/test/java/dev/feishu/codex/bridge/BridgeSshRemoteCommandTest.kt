package dev.feishu.codex.bridge

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.connectbot.sshlib.AuthResult
import org.connectbot.sshlib.ConnectResult
import org.connectbot.sshlib.HostKeyVerifier
import org.connectbot.sshlib.PublicKey
import org.connectbot.sshlib.SessionExit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

class BridgeSshRemoteCommandTest {
    @Test
    fun aStoppedTmuxServerIsAnEmptyListButPermissionErrorsRemainErrors() = runBlocking {
        val absent = BridgeSshTmuxClient(BridgeSshTmuxExecutor { _, _ ->
            BridgeCbSshExecResult(ByteArray(0), "no server running on /tmp/test".toByteArray(), SessionExit.Status(1))
        })
        assertEquals(emptyList<BridgeSshTmuxSession>(), absent.listSessions())
        val denied = BridgeSshTmuxClient(BridgeSshTmuxExecutor { _, _ ->
            BridgeCbSshExecResult(ByteArray(0), "permission denied".toByteArray(), SessionExit.Status(1))
        })
        assertTrue(runCatching { denied.listSessions() }.isFailure)
    }

    @Test
    fun diffLineNumbersFollowAddedDeletedAndContextLines() {
        val lines = parseBridgeSshDiff("diff --git a/a b/a\n@@ -3,3 +3,4 @@\n context\n-old\n+new\n+more\n end", false)
        assertEquals(3, lines[2].oldLine)
        assertEquals(3, lines[2].newLine)
        assertEquals(4, lines[3].oldLine)
        assertEquals(null, lines[3].newLine)
        assertEquals(null, lines[4].oldLine)
        assertEquals(4, lines[4].newLine)
        assertEquals(6, lines[6].newLine)
        assertEquals(5, lines[6].oldLine)
    }

    @Test
    fun commandUsesBridgeCliAndEncodesUntrustedArguments() {
        val injection = "file'; touch /tmp/bridge-must-not-run; #"
        val request = JSONObject().put("action", "git_diff").put("id", "\$12")
            .put("createdAt", 1234).put("root", "/tmp/repo with spaces").put("path", injection)
        val command = BridgeSshRemoteCommand.build(request)
        BridgeCbSshTransport.requireExecCommand(command)
        assertTrue(command.contains("ssh-session --offline --request"))
        assertTrue(command.contains("[ -n \"\$FEISHU_CODEX_BRIDGE_SSH_CLI\" ]"))
        assertTrue(command.contains("[ -x \"\$FEISHU_CODEX_BRIDGE_SSH_CLI\" ]"))
        assertTrue(command.contains("BRIDGE_SSH_DIAG:"))
        assertTrue(command.contains("exit 127"))
        assertTrue(command.toByteArray(Charsets.UTF_8).size <= BridgeCbSshTransport.MAX_EXEC_COMMAND_BYTES)
        assertFalse(command.contains(injection))
        assertFalse(command.contains("python"))
        assertFalse(command.contains('\n'))
    }

    @Test
    fun resultLineMayBeOnStderrAndStillRequiresSuccessfulExit() {
        val result = BridgeCbSshExecResult(
            stdout = ByteArray(0),
            stderr = ("BRIDGE_SSH_DIAG:shell=/bin/zsh;executable=/tmp/bridge\n" +
                "BRIDGE_SSH_RESULT:{\"ok\":true,\"result\":{\"selected\":\"codex-second\"}}\n")
                .toByteArray(),
            exitInfo = SessionExit.Status(0),
        )
        assertEquals("codex-second", parseBridgeSshRemoteResult(result).getString("selected"))

        val failed = result.copy(exitInfo = SessionExit.Status(127))
        val message = runCatching { parseBridgeSshRemoteResult(failed) }.exceptionOrNull()?.message.orEmpty()
        assertTrue(message.contains("exitCode=127"))
        assertTrue(message.contains("resultLineFound=true"))
        assertTrue(message.contains("executable=/tmp/bridge"))
    }

    @Test
    fun missingResultReportsSignalAndDoesNotExposeRawOutput() {
        val result = BridgeCbSshExecResult(
            stdout = "shell startup output password=should-not-appear".toByteArray(),
            stderr = "BRIDGE_SSH_DIAG:shell=/bin/zsh;executable=none\nsecret-token=should-not-appear".toByteArray(),
            exitInfo = SessionExit.Signal("TERM", false, "terminated"),
        )
        val message = runCatching { parseBridgeSshRemoteResult(result) }.exceptionOrNull()?.message.orEmpty()
        assertTrue(message.contains("signal=TERM"))
        assertTrue(message.contains("resultLineFound=false"))
        assertTrue(message.contains("executable=none"))
        assertFalse(message.contains("should-not-appear"))
    }

    /** Caller supplies an isolated loopback sshd, Bridge DB, and tmux server. */
    @Test
    fun bridgeCliRunsGitAndSingleSessionLifecycleThroughDisposableSsh() = runBlocking {
        val directory = System.getenv("BRIDGE_SSH_PROBE_DIR").orEmpty()
        val port = System.getenv("BRIDGE_SSH_PROBE_PORT")?.toIntOrNull()
        val username = System.getenv("BRIDGE_SSH_PROBE_USER").orEmpty()
        val sessionId = System.getenv("BRIDGE_SSH_PROBE_SESSION_ID").orEmpty()
        val createdAt = System.getenv("BRIDGE_SSH_PROBE_SESSION_CREATED")?.toLongOrNull()
        assumeTrue(directory.startsWith("/private/tmp/bridge-ssh-probe-") && port != null &&
            username.isNotBlank() && sessionId.startsWith("$") && createdAt != null)
        val key = File(directory, "client").readText().toCharArray()
        val transport = BridgeCbSshTransport("127.0.0.1", checkNotNull(port), object : HostKeyVerifier {
            override suspend fun verify(key: PublicKey): Boolean = true // Disposable loopback server only.
        })
        suspend fun call(action: String, target: Boolean = true, home: String? = null): JSONObject {
            val request = JSONObject().put("action", action)
            if (target) request.put("id", sessionId).put("createdAt", createdAt)
            home?.let { request.put("home", it) }
            val result = transport.exec(BridgeSshRemoteCommand.build(request), 1024 * 1024)
            assertEquals(0L, (result.exitInfo as SessionExit.Status).code)
            val line = result.stdout.toString(Charsets.UTF_8).lineSequence()
                .last { it.startsWith("BRIDGE_SSH_RESULT:") }
            val response = JSONObject(line.removePrefix("BRIDGE_SSH_RESULT:"))
            assertTrue(response.optString("error"), response.optBoolean("ok"))
            return response.getJSONObject("result")
        }
        try {
            withTimeout(90_000) {
                assertTrue(transport.connect() is ConnectResult.Success)
                assertTrue(transport.authenticatePublicKey(username, key) is AuthResult.Success)
                val files = call("git_list").getJSONArray("files")
                assertEquals("fixture.txt", files.getJSONObject(0).getString("path"))
                val homes = call("accounts").getJSONArray("homes")
                val account = (0 until homes.length()).map { homes.getJSONObject(it) }.first { it.getString("label") == "second" }
                val homeId = account.getString("id")
                assertEquals(homeId, call("mark_account", home = homeId).getString("selected"))
                assertEquals(homeId, call("accounts").getString("selected"))
                val quota = call("usage", home = homeId).getJSONObject("rateLimitsByLimitId").getJSONObject("codex")
                assertEquals(16, quota.getJSONObject("primary").getInt("usedPercent"))
                assertEquals("ssh-fixture", call("save").getString("name"))
                assertEquals("ssh-fixture", call("suspend").getString("name"))
                assertEquals("ssh-fixture", call("list_suspended", target = false).getJSONArray("sessions").getJSONObject(0).getString("name"))
                assertEquals("ssh-fixture", call("restore").getString("name"))
            }
        } finally {
            key.fill('\u0000')
            transport.disconnect()
        }
    }
}
