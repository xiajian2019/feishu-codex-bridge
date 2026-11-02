/*
 * Thin native transport boundary around ConnectBot's cbssh library.
 *
 * This file deliberately does not know about Capacitor, React, or the current
 * sshj-based plugin. It is an adapter that can be wired into the native plugin
 * after the cbssh capability probe is accepted.
 */
package dev.feishu.codex.bridge

import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.connectbot.sshlib.AuthResult
import org.connectbot.sshlib.ConnectResult
import org.connectbot.sshlib.ConnectionInfo
import org.connectbot.sshlib.HostKeyVerifier
import org.connectbot.sshlib.SessionExit
import org.connectbot.sshlib.SftpClient
import org.connectbot.sshlib.SshClient
import org.connectbot.sshlib.SshClientConfig
import org.connectbot.sshlib.PingResult
import org.connectbot.sshlib.SshSession
import org.connectbot.sshlib.getOrThrow
import java.io.ByteArrayOutputStream

/**
 * A coroutine-friendly SSH/PTY adapter backed by ConnectBot cbssh 0.5.0.
 *
 * The caller owns the host-key policy. [HostKeyVerifier] is passed directly to
 * cbssh so an interactive verifier or a known-hosts implementation can be
 * added without changing this transport boundary.
 */
class BridgeCbSshTransport(
    val host: String,
    val port: Int = DEFAULT_PORT,
    hostKeyVerifier: HostKeyVerifier,
    clientVersion: String = DEFAULT_CLIENT_VERSION,
) {
    init {
        BridgeSshCrypto.install()
    }

    private val client = SshClient(bridgeSshClientConfig(host, port, hostKeyVerifier, clientVersion))

    private val shellLock = Any()
    private var activeShell: BridgeCbSshShell? = null

    /** cbssh's connection state is exposed without duplicating it here. */
    val isAuthenticated: Boolean
        get() = client.isAuthenticated

    /** Negotiated algorithms, or null before connect/after disconnect. */
    val connectionInfo: ConnectionInfo?
        get() = client.connectionInfo

    /** Unexpected transport disconnects from the underlying cbssh client. */
    val disconnectedFlow: SharedFlow<Throwable?>
        get() = client.disconnectedFlow

    suspend fun connect(): ConnectResult = client.connect()

    /** Send SSH traffic without writing input or commands into the user's shell. */
    suspend fun keepAlive(shell: BridgeCbSshShell): Boolean = keepAlive(shell) { _, _ -> }

    internal suspend fun keepAlive(
        shell: BridgeCbSshShell,
        onMethod: (BridgeSshTraceDetail, Throwable?) -> Unit,
    ): Boolean = when (val result = client.ping()) {
        is PingResult.Success -> { runCatching { onMethod(BridgeSshTraceDetail.PING, null) }; true }
        // Older OpenSSH servers do not advertise ping@openssh.com. A window
        // change with the current dimensions keeps that SSH channel active.
        PingResult.NotSupported -> { runCatching { onMethod(BridgeSshTraceDetail.PTY_WINDOW, null) }; shell.keepAlive() }
        PingResult.NotAuthenticated -> { runCatching { onMethod(BridgeSshTraceDetail.NOT_AUTHENTICATED, null) }; false }
        is PingResult.Failure -> { runCatching { onMethod(BridgeSshTraceDetail.PING, result.cause) }; false }
    }

    /** Open a separate SFTP channel on this authenticated SSH connection. */
    suspend fun openSftp(): SftpClient {
        check(client.isAuthenticated) { "SSH client is not authenticated" }
        return client.openSftp().getOrThrow()
    }

    suspend fun authenticatePassword(username: String, password: String): AuthResult =
        client.authenticatePassword(username, password)

    /** Authenticate with PEM/OpenSSH private-key bytes. */
    suspend fun authenticatePublicKey(
        username: String,
        privateKeyData: ByteArray,
        passphrase: String? = null,
    ): AuthResult = client.authenticatePublicKey(username, privateKeyData, passphrase)

    /**
     * Char-array overload for the existing native key-picker boundary. cbssh
     * accepts UTF-8 key bytes, so temporary encoded copies are cleared after
     * the call returns; no key is persisted by this adapter.
     */
    suspend fun authenticatePublicKey(
        username: String,
        privateKeyData: CharArray,
        passphrase: CharArray? = null,
    ): AuthResult {
        val keyBytes = privateKeyData.concatToString().toByteArray(Charsets.UTF_8)
        val passphraseValue = passphrase?.concatToString()
        return try {
            client.authenticatePublicKey(username, keyBytes, passphraseValue)
        } finally {
            keyBytes.fill(0)
        }
    }

    /**
     * Execute one non-PTY command and collect its bounded combined output.
     *
     * This is intentionally separate from [openShell]. It uses a fresh
     * session, so interactive shell behavior and its PTY data plane remain
     * unchanged. The command boundary rejects shell control/injection syntax;
     * ordinary quoting is retained for fixed tmux format arguments.
     */
    suspend fun exec(
        command: String,
        maxOutputBytes: Int = DEFAULT_MAX_OUTPUT_BYTES,
    ): BridgeCbSshExecResult {
        requireExecCommand(command)
        require(maxOutputBytes in 0..MAX_EXEC_OUTPUT_BYTES) {
            "maxOutputBytes must be between 0 and $MAX_EXEC_OUTPUT_BYTES"
        }
        check(client.isAuthenticated) { "SSH client is not authenticated" }

        val session = client.openSession()
            ?: error("cbssh did not open an SSH session")
        try {
            check(session.requestExec(command)) { "SSH server rejected the exec request" }

            val budget = BridgeCbSshOutputBudget(maxOutputBytes)
            val (stdout, stderr) = coroutineScope {
                val stdoutJob = async { collectExecOutput(session.stdout, budget) }
                val stderrJob = async { collectExecOutput(session.stderr, budget) }
                stdoutJob.await() to stderrJob.await()
            }
            return BridgeCbSshExecResult(
                stdout = stdout,
                stderr = stderr,
                exitInfo = session.exitInfo.await()
                    ?: error("SSH exec completed without an exit status"),
            )
        } finally {
            session.close()
        }
    }

    /**
     * Opens one interactive PTY shell. The returned shell owns the cbssh
     * session and must be closed before opening another one on this adapter.
     */
    suspend fun openShell(
        terminalType: String = DEFAULT_TERMINAL_TYPE,
        widthChars: Int = DEFAULT_WIDTH_CHARS,
        heightRows: Int = DEFAULT_HEIGHT_ROWS,
        widthPixels: Int = 0,
        heightPixels: Int = 0,
    ): BridgeCbSshShell {
        requireTerminalSize(widthChars, heightRows, widthPixels, heightPixels)
        check(client.isAuthenticated) { "SSH client is not authenticated" }

        synchronized(shellLock) {
            check(activeShell == null) { "An SSH PTY shell is already open" }
        }

        val session = client.openSession()
            ?: error("cbssh did not open an SSH session")

        try {
            check(
                session.requestPty(
                    terminalType = terminalType,
                    widthChars = widthChars,
                    heightRows = heightRows,
                    widthPixels = widthPixels,
                    heightPixels = heightPixels,
                ),
            ) { "SSH server rejected the PTY request" }

            // Force the user's interactive login zsh so .zprofile/.zshrc and
            // aliases are loaded even when sshd starts the session without a
            // login-shell argv[0].
            check(session.requestExec(DEFAULT_INTERACTIVE_SHELL_COMMAND)) {
                "SSH server rejected the zsh shell request"
            }

            val shell = BridgeCbSshShell(
                session, BridgeCbSshTerminalSize(widthChars, heightRows, widthPixels, heightPixels),
            ) { clearActiveShell(session) }
            synchronized(shellLock) {
                if (activeShell != null) {
                    shell.close()
                    error("An SSH PTY shell was opened concurrently")
                }
                activeShell = shell
            }
            return shell
        } catch (error: Throwable) {
            session.close()
            throw error
        }
    }

    /** Close the active PTY and disconnect the underlying SSH client. */
    suspend fun disconnect() {
        synchronized(shellLock) {
            activeShell?.close()
            activeShell = null
        }
        client.disconnect()
    }

    private fun clearActiveShell(session: SshSession) {
        synchronized(shellLock) {
            if (activeShell?.session === session) activeShell = null
        }
    }

    companion object {
        const val DEFAULT_PORT = 22
        const val DEFAULT_CLIENT_VERSION = "SSH-2.0-FEISHU_CODEX_BRIDGE_CBSH_1.0"
        const val DEFAULT_TERMINAL_TYPE = "xterm-256color"
        const val DEFAULT_INTERACTIVE_SHELL_COMMAND = "exec /bin/zsh -il"
        const val DEFAULT_WIDTH_CHARS = 80
        const val DEFAULT_HEIGHT_ROWS = 24

        internal fun requireTerminalSize(
            widthChars: Int,
            heightRows: Int,
            widthPixels: Int,
            heightPixels: Int,
        ) {
            require(widthChars > 0) { "widthChars must be positive" }
            require(heightRows > 0) { "heightRows must be positive" }
            require(widthPixels >= 0) { "widthPixels cannot be negative" }
            require(heightPixels >= 0) { "heightPixels cannot be negative" }
        }

        internal fun requireExecCommand(command: String) {
            require(command.isNotBlank()) { "command must not be blank" }

            val commandBytes = command.toByteArray(Charsets.UTF_8)
            require(commandBytes.size <= MAX_EXEC_COMMAND_BYTES) {
                "command exceeds $MAX_EXEC_COMMAND_BYTES UTF-8 bytes"
            }

            // Commands are sent to the SSH server's exec request and may be
            // interpreted by the remote login shell.  The tmux builders use
            // POSIX single quotes for values such as the normal "$0" session
            // id, so validate shell syntax rather than rejecting every '$'.
            var inSingleQuotes = false
            var inDoubleQuotes = false
            command.forEach { character ->
                require(!character.isISOControl()) {
                    "command must not contain control characters"
                }

                when {
                    inSingleQuotes -> {
                        if (character == '\'') inSingleQuotes = false
                    }

                    inDoubleQuotes -> {
                        if (character == '"') {
                            inDoubleQuotes = false
                        } else {
                            require(character !in DOUBLE_QUOTE_INJECTION_CHARACTERS) {
                                "command contains shell control or injection characters"
                            }
                        }
                    }

                    character == '\'' -> inSingleQuotes = true
                    character == '"' -> inDoubleQuotes = true
                    character in SHELL_INJECTION_CHARACTERS -> {
                        throw IllegalArgumentException(
                            "command contains shell control or injection characters",
                        )
                    }
                }
            }
            require(!inSingleQuotes && !inDoubleQuotes) {
                "command contains an unterminated shell quote"
            }
        }

        private val SHELL_INJECTION_CHARACTERS = setOf(
            ';',
            '&',
            '|',
            '`',
            '$',
            '<',
            '>',
            '(',
            ')',
            '#',
            '\\',
        )

        private val DOUBLE_QUOTE_INJECTION_CHARACTERS = setOf('$', '`', '\\')

        const val DEFAULT_MAX_OUTPUT_BYTES = 1 * 1024 * 1024
        const val MAX_EXEC_COMMAND_BYTES = 32 * 1024
        const val MAX_EXEC_OUTPUT_BYTES = 1 * 1024 * 1024
    }
}

/** Temporary exec/SFTP channels do not own the Activity's SSH connection. */
internal fun bridgeSshClientConfig(
    remoteHost: String,
    remotePort: Int,
    verifier: HostKeyVerifier,
    version: String,
): SshClientConfig = SshClientConfig {
    host = remoteHost
    port = remotePort
    hostKeyVerifier = verifier
    clientVersion = version
    autoDisconnectOnLastChannelClose = false
}

/** The bounded result of one non-PTY SSH exec request. */
data class BridgeCbSshExecResult(
    val stdout: ByteArray,
    val stderr: ByteArray,
    val exitInfo: SessionExit,
)

private suspend fun collectExecOutput(
    channel: ReceiveChannel<ByteArray>,
    budget: BridgeCbSshOutputBudget,
): ByteArray {
    val output = ByteArrayOutputStream()
    for (chunk in channel) {
        budget.append(output, chunk)
    }
    return output.toByteArray()
}

private class BridgeCbSshOutputBudget(private val maximumBytes: Int) {
    private var usedBytes = 0

    @Synchronized
    fun append(output: ByteArrayOutputStream, chunk: ByteArray) {
        require(chunk.size <= maximumBytes - usedBytes) {
            "SSH exec output exceeds $maximumBytes bytes"
        }
        output.write(chunk, 0, chunk.size)
        usedBytes += chunk.size
    }
}

/**
 * The PTY data plane. Reads and writes are suspendable so cbssh's flow-control
 * and transport backpressure remain intact instead of imposing an app-level
 * input-size limit.
 */
internal data class BridgeCbSshTerminalSize(
    val widthChars: Int,
    val heightRows: Int,
    val widthPixels: Int,
    val heightPixels: Int,
)

class BridgeCbSshShell internal constructor(
    internal val session: SshSession,
    initialSize: BridgeCbSshTerminalSize,
    private val onClose: () -> Unit,
) : AutoCloseable {
    private val resizeMutex = Mutex()
    private var lastSize = initialSize
    val isOpen: Boolean
        get() = session.isOpen

    val stdout: ReceiveChannel<ByteArray>
        get() = session.stdout

    val stderr: ReceiveChannel<ByteArray>
        get() = session.stderr

    val exitInfo = session.exitInfo

    suspend fun read(): ByteArray? = session.read()

    suspend fun readStderr(): ByteArray? = stderr.receiveCatching().getOrNull()

    suspend fun write(data: ByteArray) {
        session.write(data.copyOf())
    }

    suspend fun resize(
        widthChars: Int,
        heightRows: Int,
        widthPixels: Int = 0,
        heightPixels: Int = 0,
    ): Boolean {
        BridgeCbSshTransport.requireTerminalSize(widthChars, heightRows, widthPixels, heightPixels)
        return resizeMutex.withLock {
            val sent = session.resizeTerminal(widthChars, heightRows, widthPixels, heightPixels)
            if (sent) lastSize = BridgeCbSshTerminalSize(widthChars, heightRows, widthPixels, heightPixels)
            sent
        }
    }

    internal suspend fun keepAlive(): Boolean = resizeMutex.withLock {
        val size = lastSize
        session.resizeTerminal(size.widthChars, size.heightRows, size.widthPixels, size.heightPixels)
    }

    suspend fun sendEof() = session.sendEof()

    override fun close() {
        if (session.isOpen) session.close()
        onClose()
    }
}
