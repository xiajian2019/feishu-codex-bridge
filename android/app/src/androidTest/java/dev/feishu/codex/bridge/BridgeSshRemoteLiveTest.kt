package dev.feishu.codex.bridge

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withContext
import org.connectbot.sshlib.AuthResult
import org.connectbot.sshlib.ConnectResult
import org.connectbot.sshlib.HostKeyVerifier
import org.connectbot.sshlib.PublicKey
import org.connectbot.sshlib.SessionExit
import org.connectbot.sshlib.getOrThrow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Optional isolated SSH fixture; skipped unless all fixture arguments are supplied. */
@RunWith(AndroidJUnit4::class)
class BridgeSshRemoteLiveTest {
    @Test
    fun interactiveShellSurvivesCommandsKeepAlivesAndTemporaryChannels() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        val keyPath = args.getString("fixtureKey")
        val root = args.getString("fixtureRoot")
        val username = args.getString("fixtureUser")
        assumeTrue(!keyPath.isNullOrBlank() && !root.isNullOrBlank() && !username.isNullOrBlank())
        require(root!!.startsWith("/private/tmp/bridge-native-composer-qa."))
        require(keyPath!!.startsWith("/data/local/tmp/bridge-composer-"))
        val key = File(keyPath).readBytes()
        val verifier = object : HostKeyVerifier { override suspend fun verify(key: PublicKey): Boolean = true }
        val transport = BridgeCbSshTransport("10.0.2.2", 22339, verifier)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        var terminal: BridgeSshAppTerminalTransport? = null
        var emulatorSession: BridgeSshTerminalSession? = null
        val output = StringBuilder()
        val state = AtomicReference(BridgeSshConnectionState.CONNECTED)
        try {
            assertTrue(transport.connect() is ConnectResult.Success)
            assertTrue(transport.authenticatePublicKey(username!!, key) is AuthResult.Success)
            val shell = transport.openShell()
            val io = BridgeSshAppTerminalTransport(transport, shell, scope)
            terminal = io
            val observedTransport = object : BridgeSshTerminalTransport {
                override val initialState = io.initialState
                override fun attach(listener: BridgeSshTerminalTransport.Listener?) {
                    io.attach(if (listener == null) null else object : BridgeSshTerminalTransport.Listener {
                        override fun onSshOutput(bytes: ByteArray, offset: Int, length: Int) {
                            synchronized(output) { output.append(String(bytes, offset, length, Charsets.UTF_8)) }
                            listener.onSshOutput(bytes, offset, length)
                        }
                        override fun onStateChanged(next: BridgeSshConnectionState, message: String?) {
                            state.set(next)
                            listener.onStateChanged(next, message)
                        }
                        override fun onClosed(message: String?) {
                            state.set(BridgeSshConnectionState.CLOSED)
                            listener.onClosed(message)
                        }
                    })
                }
                override fun writeToSsh(bytes: ByteArray, offset: Int, length: Int) = io.writeToSsh(bytes, offset, length)
                override fun requestResize(size: BridgeSshTerminalSize) = io.requestResize(size)
                override fun close() = io.close()
            }
            emulatorSession = withContext(Dispatchers.Main) { BridgeSshTerminalSession(observedTransport) }
            io.startReaders()
            suspend fun awaitOutput(marker: String) = withTimeout(10_000) {
                while (!synchronized(output) { output.contains(marker) }) delay(20)
            }
            // Install the common ll alias in this isolated shell; the marker is
            // assembled remotely so terminal echo cannot satisfy the assertion.
            shell.write("alias ll='ls -la'; printf 'bridge-%s\\n' 'ready'\r".toByteArray())
            awaitOutput("bridge-ready")
            assertEquals(BridgeSshCommandSendResult.Written,
                io.writeComposerPaste(BridgeSshCommandEncoding.bracketedPaste("ll; printf 'bridge-%s\\n' 'first'")))
            awaitOutput("bridge-first")
            assertEquals(BridgeSshConnectionState.CONNECTED, state.get())
            assertTrue(transport.exec("printenv HOME").stdout.toString(Charsets.UTF_8).contains(root))
            transport.openSftp().use { assertEquals(root, it.realpath(root).getOrThrow()) }
            val skills = BridgeSshRemoteSkills(
                exec = transport::exec, openSftp = transport::openSftp,
                target = null, tmux = null, systemSkillRoot = null,
            ).discover()
            assertTrue(skills.any { it.name == "fixture-global" })
            val probes = AtomicInteger()
            val failures = AtomicInteger()
            val keepAlive = scope.launch {
                BridgeSshKeepAlive(probe = { transport.keepAlive(shell).also { if (it) probes.incrementAndGet() } },
                    intervalMs = 100, timeoutMs = 2_000).run { failures.incrementAndGet() }
            }
            try {
                withTimeout(10_000) { while (probes.get() < 3) delay(20) }
            } finally { keepAlive.cancelAndJoin() }
            assertEquals(0, failures.get())
            assertEquals(BridgeSshCommandSendResult.Written,
                io.writeComposerPaste(BridgeSshCommandEncoding.bracketedPaste("printf 'bridge-%s\\n' 'second'")))
            awaitOutput("bridge-second")
            assertEquals(BridgeSshConnectionState.CONNECTED, state.get())
            withContext(Dispatchers.Main) { assertEquals(BridgeSshConnectionState.CONNECTED, emulatorSession?.status?.state) }
            assertTrue(transport.isAuthenticated)
            assertTrue(shell.isOpen)
            shell.write("exit\r".toByteArray())
            withTimeout(10_000) { while (state.get() == BridgeSshConnectionState.CONNECTED) delay(20) }
            assertEquals(BridgeSshConnectionState.FAILED, state.get())
            // A closed PTY or auxiliary channel must not silently tear down
            // the authenticated SSH client owned by the app.
            assertTrue(transport.isAuthenticated)
            assertTrue(transport.exec("printenv HOME").stdout.toString(Charsets.UTF_8).contains(root))
        } finally {
            withContext(Dispatchers.Main) { emulatorSession?.close() ?: terminal?.close() }
            scope.cancel()
            key.fill(0)
            transport.disconnect()
        }
    }

    @Test
    fun sftpBrowsePreviewUploadAndDownloadUseOnlyFixtureRoot() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        val keyPath = args.getString("fixtureKey")
        val root = args.getString("fixtureRoot")
        val username = args.getString("fixtureUser")
        assumeTrue(!keyPath.isNullOrBlank() && !root.isNullOrBlank() && !username.isNullOrBlank())
        require(root!!.startsWith("/private/tmp/bridge-native-composer-qa."))
        require(keyPath!!.startsWith("/data/local/tmp/bridge-composer-"))
        val key = File(keyPath).readBytes()
        val verifier = object : HostKeyVerifier { override suspend fun verify(key: PublicKey): Boolean = true }
        val transport = BridgeCbSshTransport("10.0.2.2", 22339, verifier)
        try {
            assertTrue(transport.connect() is ConnectResult.Success)
            assertTrue(transport.authenticatePublicKey(username!!, key) is AuthResult.Success)
            val projectRoot = "$root/project"
            val browser = BridgeSshRemoteFiles({ projectRoot }, { transport.openSftp() })
            val (_, entries) = browser.list("")
            assertTrue(entries.any { it.name == "sub" && it.directory })
            assertFalse(entries.any { it.name == "outside-link" })
            assertEquals("测试 SSH 文件\n", browser.preview("sub/sample.txt").first)
            assertTrue(runCatching { browser.absolutePath("../outside") }.isFailure)
            assertTrue(runCatching { browser.absolutePath("outside-link") }.isFailure)
            val content = "native composer SFTP fixture".toByteArray()
            browser.upload("", "upload-test.txt", ByteArrayInputStream(content))
            val output = ByteArrayOutputStream()
            browser.download("upload-test.txt", output)
            assertEquals(content.toString(Charsets.UTF_8), output.toString("UTF-8"))
            assertTrue(runCatching { browser.upload("", "upload-test.txt", ByteArrayInputStream(content)) }.isFailure)
            transport.openSftp().use { it.remove("$projectRoot/upload-test.txt").getOrThrow() }

            // Keep all skill roots in the disposable fixture while exercising real SFTP.
            val target = BridgeSshTmuxSession("\$0", "fixture", 1, false, "$root/project", 42)
            val delimiter = BridgeSshTmuxCommandBuilder.SESSION_FIELD_DELIMITER
            fun result(text: String, code: Long = 0) = BridgeCbSshExecResult(
                text.toByteArray(), ByteArray(0), SessionExit.Status(code),
            )
            val tmux = BridgeSshTmuxClient(BridgeSshTmuxExecutor { command, _ ->
                when {
                    command.contains("list-sessions") -> result("\$0${delimiter}fixture${delimiter}1${delimiter}0${delimiter}$root/project${delimiter}42\n")
                    command.contains("show-environment") -> result("CODEX_HOME=$root/account\n")
                    else -> result("", 1)
                }
            })
            val skills = BridgeSshRemoteSkills(
                exec = { command, _ ->
                    when (command) {
                        "printenv HOME" -> result("$root/home\n")
                        "printenv CODEX_HOME" -> result("$root/decoy\n")
                        else -> result("", 1)
                    }
                },
                openSftp = { transport.openSftp() }, target = target, tmux = tmux, systemSkillRoot = null,
            ).discover().map { it.name }.toSet()
            assertTrue(skills.containsAll(setOf("fixture-project", "fixture-account", "fixture-global")))
            assertFalse(skills.contains("fixture-decoy"))
        } finally {
            key.fill(0)
            transport.disconnect()
        }
    }
}
