package dev.feishu.codex.bridge

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/** One SSH identity in this Android app process; never holds an Activity or credentials. */
internal data class BridgeSshAppConnectionKey(val host: String, val port: Int, val username: String) {
    companion object {
        fun of(host: String, port: Int, username: String) =
            BridgeSshAppConnectionKey(host.trim().lowercase(Locale.ROOT), port, username.trim())
    }
}

/** Owns a live SSH transport, terminal and jobs independently of native screens. */
internal class BridgeSshAppSession(
    val key: BridgeSshAppConnectionKey,
    val transport: BridgeCbSshTransport,
    shell: BridgeCbSshShell,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val diagnostics = BridgeSshDiagnostics()
    val diagnosticId = BridgeSshActivityDiagnostics.nextSessionId()
    val uploadedPaths = mutableMapOf<String, String>()
    var selectedTmuxSession: BridgeSshTmuxSession? = null
    val shellTransport = BridgeSshAppTerminalTransport(
        transport, shell, scope, onFailure = { BridgeSshAppState.onSessionChanged() }, traceSessionId = diagnosticId,
    ) { kind, count ->
        diagnostics.record(kind, count)
    }
    val terminalSession = BridgeSshTerminalSession(shellTransport)
    val tmuxClient = BridgeSshTmuxClient(transport)

    init {
        if (BridgeSshActivityDiagnostics.recording) diagnostics.start()
        shellTransport.startReaders()
    }

    fun close() {
        try { terminalSession.close() } finally { scope.cancel() }
    }
}

/** App-process state. All registry operations are called on the main thread. */
internal object BridgeSshAppState {
    private val active = mutableStateListOf<BridgeSshAppSession>()
    private val cleanupScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mainHandler = Handler(Looper.getMainLooper())
    private var lastViewed: BridgeSshAppSession? = null
    private var applicationContext: Context? = null
    private var pendingConnections = 0
    private var backgroundServiceRequested = false
    private var backgroundServiceRunning = false
    var backgroundProtectionWarning by mutableStateOf<String?>(null)
        private set

    val sessions: List<BridgeSshAppSession> get() = active.toList()

    /** Start while the user is connecting, before an Activity can be backgrounded. */
    fun beginConnection(context: Context) {
        applicationContext = context.applicationContext
        pendingConnections += 1
        updateBackgroundProtection()
    }

    fun finishConnection() {
        check(pendingConnections > 0) { "SSH connection attempt is not registered" }
        pendingConnections -= 1
        updateBackgroundProtection()
    }

    /** Retry a previously rejected service start only when an Activity is visible. */
    fun ensureBackgroundProtection(context: Context) {
        applicationContext = context.applicationContext
        updateBackgroundProtection()
    }

    internal fun onSessionChanged() {
        mainHandler.post { updateBackgroundProtection() }
    }

    internal fun onBackgroundServiceStarted() {
        backgroundServiceRunning = true
        traceService(BridgeSshTraceEvent.SERVICE_STARTED)
        if (backgroundServiceRequested) backgroundProtectionWarning = null
    }

    internal fun onBackgroundServiceFailed(error: Throwable? = null) {
        backgroundServiceRunning = false
        backgroundServiceRequested = false
        traceService(BridgeSshTraceEvent.SERVICE_FAILED, error)
        if (needsBackgroundProtection()) backgroundProtectionWarning = BACKGROUND_WARNING
    }

    internal fun onBackgroundServiceStopped() {
        backgroundServiceRunning = false
        traceService(BridgeSshTraceEvent.SERVICE_STOPPED)
        if (!backgroundServiceRequested) return
        backgroundServiceRequested = false
        if (needsBackgroundProtection()) backgroundProtectionWarning = BACKGROUND_WARNING
    }

    internal fun traceService(event: BridgeSshTraceEvent, error: Throwable? = null) {
        BridgeSshActivityDiagnostics.record(event,
            BridgeSshTraceField.ACTIVE_SESSIONS to active.size,
            BridgeSshTraceField.PENDING_CONNECTIONS to pendingConnections,
            BridgeSshTraceField.FOREGROUND_REQUESTED to backgroundServiceRequested,
            BridgeSshTraceField.FOREGROUND_RUNNING to backgroundServiceRunning,
            BridgeSshTraceField.ERROR to error)
    }

    private fun needsBackgroundProtection(): Boolean =
        pendingConnections > 0 || active.any { it.shellTransport.isLive }

    private fun updateBackgroundProtection() {
        val context = applicationContext ?: return
        val needed = needsBackgroundProtection()
        if (needed && !backgroundServiceRequested) {
            backgroundServiceRequested = true
            traceService(BridgeSshTraceEvent.SERVICE_REQUESTED)
            try {
                checkNotNull(ContextCompat.startForegroundService(context, Intent(context, BridgeSshConnectionService::class.java)))
            } catch (error: RuntimeException) {
                traceService(BridgeSshTraceEvent.SERVICE_FAILED, error)
                backgroundServiceRequested = false
                backgroundProtectionWarning = BACKGROUND_WARNING
            }
        } else if (!needed) {
            backgroundProtectionWarning = null
            if (backgroundServiceRequested) {
                backgroundServiceRequested = false
                context.stopService(Intent(context, BridgeSshConnectionService::class.java))
            }
        }
    }

    private const val BACKGROUND_WARNING = "SSH 后台保活未能启动；切换页面或应用时连接可能中断。"
    fun find(key: BridgeSshAppConnectionKey): BridgeSshAppSession? = active.firstOrNull { it.key == key }
    fun mostRecent(): BridgeSshAppSession? = lastViewed?.takeIf { it in active } ?: active.lastOrNull()

    fun view(session: BridgeSshAppSession) {
        check(session in active) { "SSH session is no longer active" }
        lastViewed = session
    }

    /** A concurrent connection for the same identity reuses the existing session. */
    fun register(key: BridgeSshAppConnectionKey, transport: BridgeCbSshTransport, shell: BridgeCbSshShell): Pair<BridgeSshAppSession, Boolean> {
        val existing = find(key)
        if (existing != null) {
            closeUnregistered(transport)
            view(existing)
            BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.SESSION_REUSED, BridgeSshTraceField.SESSION to existing.diagnosticId)
            return existing to false
        }
        val session = BridgeSshAppSession(key, transport, shell)
        active.add(session)
        view(session)
        BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.SESSION_CREATED, BridgeSshTraceField.SESSION to session.diagnosticId)
        updateBackgroundProtection()
        return session to true
    }

    fun disconnect(session: BridgeSshAppSession, reason: BridgeSshTraceDetail = BridgeSshTraceDetail.UNKNOWN) {
        if (!active.remove(session)) return
        BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.SESSION_CLOSED,
            BridgeSshTraceField.SESSION to session.diagnosticId, BridgeSshTraceField.DETAIL to reason)
        if (lastViewed === session) lastViewed = active.lastOrNull()
        try { session.close() } finally {
            closeUnregistered(session.transport)
            updateBackgroundProtection()
        }
    }

    /** Completes even when an Activity cancels its own coroutine scope. */
    fun closeUnregistered(transport: BridgeCbSshTransport) {
        cleanupScope.launch { runCatching { transport.disconnect() } }
    }
}

internal class BridgeSshAppTerminalTransport(
    private val transport: BridgeCbSshTransport,
    private val shell: BridgeCbSshShell,
    private val scope: CoroutineScope,
    private val onFailure: () -> Unit = {},
    private val traceSessionId: Int? = null,
    private val onDiagnostic: (String, Int) -> Unit = { _, _ -> },
) : BridgeSshTerminalTransport {
    @Volatile private var listener: BridgeSshTerminalTransport.Listener? = null
    private val closed = AtomicBoolean(false)
    private val failed = AtomicBoolean(false)
    private val jobs = mutableListOf<Job>()
    private val writeMutex = Mutex()

    override val initialState: BridgeSshConnectionState = BridgeSshConnectionState.CONNECTED
    val isLive: Boolean get() = !closed.get() && !failed.get()

    override fun attach(listener: BridgeSshTerminalTransport.Listener?) {
        this.listener = listener
    }

    fun startReaders() {
        // Subscribe before starting the other jobs so a transport drop is not
        // missed between the initial state check and the first heartbeat.
        jobs += scope.launch(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) {
            transport.disconnectedFlow.collect { error ->
                trace(BridgeSshTraceEvent.TRANSPORT_DISCONNECTED, BridgeSshTraceDetail.TRANSPORT, error)
                fail("SSH 连接已中断", BridgeSshTraceDetail.TRANSPORT, error)
            }
        }
        jobs += scope.launch(Dispatchers.IO) { read(shell.stdout, isStdout = true) }
        jobs += scope.launch(Dispatchers.IO) { read(shell.stderr, isStdout = false) }
        jobs += scope.launch(Dispatchers.IO) {
            BridgeSshKeepAlive(
                probe = { transport.keepAlive(shell) { method, error -> trace(BridgeSshTraceEvent.KEEPALIVE_METHOD, method, error) } },
                onProbe = { observation ->
                    BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.KEEPALIVE_RESULT,
                        BridgeSshTraceField.SESSION to traceSessionId, BridgeSshTraceField.DETAIL to observation.detail,
                        BridgeSshTraceField.FAILURE_COUNT to observation.failures, BridgeSshTraceField.DURATION_MS to observation.durationMs,
                        BridgeSshTraceField.ERROR to observation.error)
                },
            ).run { fail("SSH 连接无响应", BridgeSshTraceDetail.KEEPALIVE) }
        }
        if (!transport.isAuthenticated || !shell.isOpen) fail("SSH 连接已中断", BridgeSshTraceDetail.TRANSPORT)
    }

    private fun trace(event: BridgeSshTraceEvent, detail: BridgeSshTraceDetail, error: Throwable? = null) {
        BridgeSshActivityDiagnostics.record(event,
            BridgeSshTraceField.SESSION to traceSessionId, BridgeSshTraceField.DETAIL to detail,
            BridgeSshTraceField.AUTHENTICATED to transport.isAuthenticated, BridgeSshTraceField.SHELL_OPEN to shell.isOpen,
            BridgeSshTraceField.ERROR to error)
    }

    private fun fail(message: String, detail: BridgeSshTraceDetail, error: Throwable? = null) {
        if (!closed.get() && failed.compareAndSet(false, true)) {
            trace(BridgeSshTraceEvent.SESSION_FAILED, detail, error)
            listener?.onStateChanged(BridgeSshConnectionState.FAILED, message)
            onFailure()
        }
    }

    private suspend fun read(channel: kotlinx.coroutines.channels.ReceiveChannel<ByteArray>, isStdout: Boolean) {
        try {
            for (chunk in channel) {
                if (closed.get()) return
                onDiagnostic("output", chunk.size)
                listener?.onSshOutput(chunk, 0, chunk.size)
            }
            if (isStdout) {
                trace(BridgeSshTraceEvent.TERMINAL_EOF, BridgeSshTraceDetail.STDOUT)
                fail(if (transport.isAuthenticated) "SSH 终端已结束" else "SSH 连接已中断", BridgeSshTraceDetail.STDOUT)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            val detail = if (isStdout) BridgeSshTraceDetail.STDOUT else BridgeSshTraceDetail.STDERR
            trace(BridgeSshTraceEvent.TERMINAL_READ_FAILED, detail, error)
            fail("SSH 终端输出中断", detail, error)
        }
    }

    override fun writeToSsh(bytes: ByteArray, offset: Int, length: Int) {
        if (closed.get() || failed.get() || length == 0) return
        val copy = bytes.copyOfRange(offset, offset + length)
        onDiagnostic("input", length)
        scope.launch(Dispatchers.IO) {
            try {
                writeSerialized(copy)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                trace(BridgeSshTraceEvent.TERMINAL_WRITE_FAILED, BridgeSshTraceDetail.WRITE, error)
                fail("SSH 终端输入中断", BridgeSshTraceDetail.WRITE, error)
            } finally {
                copy.fill(0)
            }
        }
    }

    fun sendBracketedPaste(bytes: ByteArray) {
        if (closed.get() || failed.get() || bytes.isEmpty()) return
        val copy = bytes.copyOf()
        scope.launch(Dispatchers.IO) {
            try {
                writeComposerPaste(copy)
            } finally {
                copy.fill(0)
            }
        }
    }

    /** Serialize the complete paste and Enter with all other terminal input. */
    suspend fun writeComposerPaste(bytes: ByteArray): BridgeSshCommandSendResult = withContext(Dispatchers.IO) {
        if (closed.get() || failed.get() || bytes.isEmpty()) return@withContext BridgeSshCommandSendResult.NotSent
        var started = false
        try {
            writeMutex.withLock {
                if (closed.get() || failed.get()) return@withLock BridgeSshCommandSendResult.NotSent
                started = true
                shell.write(bytes)
                delay(180)
                shell.write(BridgeSshCommandEncoding.enter())
                BridgeSshCommandSendResult.Written
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            trace(BridgeSshTraceEvent.TERMINAL_WRITE_FAILED, BridgeSshTraceDetail.WRITE, error)
            fail("SSH 终端输入中断", BridgeSshTraceDetail.WRITE, error)
            if (started) BridgeSshCommandSendResult.Unknown else BridgeSshCommandSendResult.NotSent
        }
    }

    /**
     * Leave the current tmux client and attach another session as one serialized
     * terminal operation.  The detach sequence is terminal input (Ctrl-b, d by
     * default). The mutex prevents composer input between writes, but it does
     * not confirm that tmux accepted detach. A custom prefix or failed detach
     * can therefore send the subsequent attach command to the current pane.
     */
    suspend fun detachAndAttachTmux(
        detachSequence: ByteArray,
        attachCommand: String,
    ): BridgeSshCommandSendResult = withContext(Dispatchers.IO) {
        if (closed.get() || failed.get() || detachSequence.isEmpty() || attachCommand.isBlank()) {
            return@withContext BridgeSshCommandSendResult.NotSent
        }
        var started = false
        val attachBytes = BridgeSshCommandEncoding.bracketedPaste(attachCommand)
        try {
            writeMutex.withLock {
                if (closed.get() || failed.get()) return@withLock BridgeSshCommandSendResult.NotSent
                started = true
                shell.write(detachSequence)
                // Give tmux time to restore the login shell prompt before the
                // next command is pasted into it.
                delay(180)
                shell.write(attachBytes)
                delay(180)
                shell.write(BridgeSshCommandEncoding.enter())
                BridgeSshCommandSendResult.Written
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            trace(BridgeSshTraceEvent.TERMINAL_WRITE_FAILED, BridgeSshTraceDetail.WRITE, error)
            fail("SSH 终端输入中断", BridgeSshTraceDetail.WRITE, error)
            if (started) BridgeSshCommandSendResult.Unknown else BridgeSshCommandSendResult.NotSent
        } finally {
            attachBytes.fill(0)
        }
    }

    private suspend fun writeSerialized(bytes: ByteArray) {
        writeMutex.withLock { shell.write(bytes) }
    }

    override fun requestResize(size: BridgeSshTerminalSize) {
        scope.launch(Dispatchers.IO) {
            try {
                shell.resize(size.columns, size.rows, size.widthPixels, size.heightPixels)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                // A rejected window adjustment alone does not prove that the
                // SSH transport or interactive shell has disconnected.
                onDiagnostic("resize-error", 0)
                trace(BridgeSshTraceEvent.TERMINAL_RESIZE_FAILED, BridgeSshTraceDetail.RESIZE, error)
                if (!transport.isAuthenticated || !shell.isOpen) fail("SSH 连接已中断", BridgeSshTraceDetail.RESIZE, error)
            }
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        jobs.forEach { it.cancel() }
        shell.close()
        listener?.onClosed("SSH closed")
    }
}
