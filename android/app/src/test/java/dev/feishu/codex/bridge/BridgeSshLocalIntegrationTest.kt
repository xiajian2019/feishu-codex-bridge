package dev.feishu.codex.bridge

import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.connectbot.sshlib.AuthResult
import org.connectbot.sshlib.ConnectResult
import org.connectbot.sshlib.HostKeyVerifier
import org.connectbot.sshlib.PublicKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Optional loopback-only integration test; the caller supplies a disposable sshd fixture. */
class BridgeSshLocalIntegrationTest {
    @Test
    fun sftpDirectoryNavigationKeepsTheInteractiveShellAndTransportAlive() = runBlocking {
        val directory = System.getenv("BRIDGE_SSH_PROBE_DIR").orEmpty()
        val port = System.getenv("BRIDGE_SSH_PROBE_PORT")?.toIntOrNull()
        val username = System.getenv("BRIDGE_SSH_PROBE_USER").orEmpty()
        assumeTrue(directory.startsWith("/private/tmp/bridge-ssh-probe-") && port != null && username.isNotBlank())
        val root = File(directory, "home").canonicalPath
        val privateKey = File(directory, "client_key").readText().toCharArray()
        val transport = BridgeCbSshTransport("127.0.0.1", checkNotNull(port), object : HostKeyVerifier {
            override suspend fun verify(key: PublicKey): Boolean = true // Disposable loopback server only.
        })
        try {
            withTimeout(60_000) {
                assertTrue(transport.connect() is ConnectResult.Success)
                assertTrue(transport.authenticatePublicKey(username, privateKey) is AuthResult.Success)
                val shell = transport.openShell()
                val output = StringBuilder()
                val before = CompletableDeferred<Unit>()
                val after = CompletableDeferred<Unit>()
                val reader = launch {
                    for (chunk in shell.stdout) {
                        output.append(chunk.toString(Charsets.UTF_8))
                        if ("BRIDGE_BEFORE_DONE" in output) before.complete(Unit)
                        if ("BRIDGE_AFTER_DONE" in output) after.complete(Unit)
                    }
                }
                try {
                    shell.write("printf 'BRIDGE_%s_DONE\\n' BEFORE\n".toByteArray())
                    withTimeout(10_000) { before.await() }
                    val browser = BridgeSshRemoteFiles({ root }, { transport.openSftp() })
                    repeat(5) {
                        assertTrue(browser.list("").second.any { it.name == "child" && it.directory })
                        assertTrue(browser.list("child").second.any { it.name == "fixture.txt" })
                        assertEquals("isolated ssh fixture\n", browser.preview("child/fixture.txt").first)
                        assertTrue(transport.isAuthenticated)
                        assertTrue(shell.isOpen)
                    }
                    val home = transport.exec("printenv HOME")
                    assertEquals(root, home.stdout.toString(Charsets.UTF_8).trim())
                    shell.write("printf 'BRIDGE_%s_DONE\\n' AFTER\n".toByteArray())
                    withTimeout(10_000) { after.await() }
                    assertTrue(transport.isAuthenticated)
                    assertTrue(shell.isOpen)
                } finally {
                    reader.cancelAndJoin()
                    shell.close()
                }
            }
        } finally {
            privateKey.fill('\u0000')
            transport.disconnect()
        }
    }

    @Test
    fun reconnectResolvesAndReattachesOnlyTheRememberedTmuxIdentity() = runBlocking {
        val directory = System.getenv("BRIDGE_SSH_PROBE_DIR").orEmpty()
        val port = System.getenv("BRIDGE_SSH_PROBE_PORT")?.toIntOrNull()
        val username = System.getenv("BRIDGE_SSH_PROBE_USER").orEmpty()
        assumeTrue(directory.startsWith("/private/tmp/bridge-ssh-probe-") && port != null && username.isNotBlank())
        val root = File(directory, "home").canonicalFile
        val bin = File(root, "bin").apply { mkdirs() }
        val delimiter = BridgeSshTmuxCommandBuilder.SESSION_FIELD_DELIMITER
        val row = "\$77${delimiter}fixture${delimiter}1${delimiter}0${delimiter}${root.path}${delimiter}12345"
        File(bin, "tmux").apply {
            writeText("#!/bin/sh\ncase \"\$1\" in\n" +
                "list-sessions) printf '%s\\n' '$row' ;;\n" +
                "attach-session) printf 'BRIDGE_TMUX_REATTACHED\\n' ;;\n" +
                "*) exit 1 ;;\nesac\n")
            check(setExecutable(true))
        }
        File(root, ".zshrc").appendText("\nexport PATH='${bin.path}':\$PATH\n")
        val privateKey = File(directory, "client_key").readText().toCharArray()
        fun transport() = BridgeCbSshTransport("127.0.0.1", checkNotNull(port), object : HostKeyVerifier {
            override suspend fun verify(key: PublicKey): Boolean = true
        })
        val first = transport()
        val second = transport()
        try {
            withTimeout(60_000) {
                assertTrue(first.connect() is ConnectResult.Success)
                assertTrue(first.authenticatePublicKey(username, privateKey) is AuthResult.Success)
                val firstShell = first.openShell()
                val original = BridgeSshTmuxClient(first).listSessions().single()
                val identity = BridgeSshTmuxIdentity.of(original)
                firstShell.close()
                first.disconnect()

                assertTrue(second.connect() is ConnectResult.Success)
                assertTrue(second.authenticatePublicKey(username, privateKey) is AuthResult.Success)
                val secondShell = second.openShell()
                val client = BridgeSshTmuxClient(second)
                assertNull(client.findResumeTarget(identity.copy(createdAt = identity.createdAt + 1)))
                val restored = checkNotNull(client.findResumeTarget(identity))
                val attached = CompletableDeferred<Unit>()
                val output = StringBuilder()
                val channel = BridgeSshAppTerminalTransport(second, secondShell, this)
                channel.attach(object : BridgeSshTerminalTransport.Listener {
                    override fun onSshOutput(bytes: ByteArray, offset: Int, length: Int) {
                        output.append(bytes.copyOfRange(offset, offset + length).toString(Charsets.UTF_8))
                        if ("BRIDGE_TMUX_REATTACHED" in output) attached.complete(Unit)
                    }
                    override fun onStateChanged(state: BridgeSshConnectionState, message: String?) = Unit
                    override fun onClosed(message: String?) = Unit
                })
                try {
                    channel.startReaders()
                    assertEquals(BridgeSshCommandSendResult.Written, channel.attachResumeTarget(restored))
                    withTimeout(10_000) { attached.await() }
                    assertTrue(second.isAuthenticated)
                    assertTrue(secondShell.isOpen)
                } finally { channel.close() }
            }
        } finally {
            privateKey.fill('\u0000')
            first.disconnect()
            second.disconnect()
        }
    }
}
