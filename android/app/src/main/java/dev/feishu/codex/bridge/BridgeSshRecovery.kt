package dev.feishu.codex.bridge

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive

internal sealed interface BridgeSshRecoveryResult {
    data object Connected : BridgeSshRecoveryResult
    data class Retry(val message: String) : BridgeSshRecoveryResult
    data class Stop(val message: String) : BridgeSshRecoveryResult
}

/** A single, cancellable retry loop. Successful recovery never replays terminal input. */
internal class BridgeSshRecoveryLoop(
    private val pausesMs: List<Long> = listOf(1_000, 3_000, 10_000, 30_000),
    private val pause: suspend (Long) -> Unit = { delay(it) },
) {
    init { require(pausesMs.isNotEmpty() && pausesMs.all { it > 0 }) }

    suspend fun run(
        attempt: suspend () -> BridgeSshRecoveryResult,
        onRetry: (String, Long) -> Unit,
    ): BridgeSshRecoveryResult {
        var failures = 0
        while (true) {
            currentCoroutineContext().ensureActive()
            when (val result = attempt()) {
                BridgeSshRecoveryResult.Connected -> return result
                is BridgeSshRecoveryResult.Stop -> return result
                is BridgeSshRecoveryResult.Retry -> {
                    val wait = pausesMs[failures.coerceAtMost(pausesMs.lastIndex)]
                    failures += 1
                    onRetry(result.message, wait)
                    pause(wait)
                }
            }
        }
    }
}

/** Keeps the emulator and its scrollback while replacing a failed physical SSH channel. */
internal class BridgeSshSwitchingTerminalTransport(initial: BridgeSshTerminalTransport) : BridgeSshTerminalTransport {
    private val lock = Any()
    private var current = initial
    private var listener: BridgeSshTerminalTransport.Listener? = null
    private var lastSize: BridgeSshTerminalSize? = null
    private var closed = false

    override val initialState: BridgeSshConnectionState = initial.initialState

    override fun attach(listener: BridgeSshTerminalTransport.Listener?) {
        synchronized(lock) {
            this.listener = listener
            current.attach(listener)
        }
    }

    fun setState(state: BridgeSshConnectionState, message: String?) {
        val target = synchronized(lock) { if (closed) null else listener }
        target?.onStateChanged(state, message)
    }

    fun replace(next: BridgeSshTerminalTransport) {
        val previous: BridgeSshTerminalTransport
        val size: BridgeSshTerminalSize?
        synchronized(lock) {
            check(!closed) { "SSH session is closed" }
            previous = current
            previous.attach(null)
            current = next
            next.attach(listener)
            size = lastSize
        }
        previous.close()
        if (size != null) next.requestResize(size)
    }

    override fun writeToSsh(bytes: ByteArray, offset: Int, length: Int) {
        val target = synchronized(lock) { if (closed) null else current }
        target?.writeToSsh(bytes, offset, length)
    }

    override fun requestResize(size: BridgeSshTerminalSize) {
        val target = synchronized(lock) {
            if (closed) null else { lastSize = size; current }
        }
        target?.requestResize(size)
    }

    override fun close() {
        val target = synchronized(lock) {
            if (closed) null else { closed = true; listener = null; current }
        }
        target?.attach(null)
        target?.close()
    }
}
