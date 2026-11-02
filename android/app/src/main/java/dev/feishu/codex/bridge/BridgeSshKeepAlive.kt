package dev.feishu.codex.bridge

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withTimeoutOrNull

internal data class BridgeSshKeepAliveObservation(
    val detail: BridgeSshTraceDetail,
    val failures: Int,
    val durationMs: Long,
    val error: Throwable? = null,
)

/** Poll an active SSH connection; isolated failures do not discard a session. */
internal class BridgeSshKeepAlive(
    private val probe: suspend () -> Boolean,
    private val intervalMs: Long = 30_000,
    private val timeoutMs: Long = 15_000,
    private val maxFailures: Int = 3,
    private val onProbe: (BridgeSshKeepAliveObservation) -> Unit = {},
) {
    init {
        require(intervalMs > 0 && timeoutMs > 0 && maxFailures > 0)
    }

    suspend fun run(onFailure: () -> Unit) {
        var failures = 0
        while (currentCoroutineContext().isActive) {
            delay(intervalMs)
            val started = System.nanoTime()
            var error: Throwable? = null
            val detail = try {
                when (withTimeoutOrNull(timeoutMs) { probe() }) {
                    true -> BridgeSshTraceDetail.HEALTHY
                    false -> BridgeSshTraceDetail.FAILED
                    null -> BridgeSshTraceDetail.TIMEOUT
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (cause: Exception) {
                error = cause
                BridgeSshTraceDetail.EXCEPTION
            }
            failures = if (detail == BridgeSshTraceDetail.HEALTHY) 0 else failures + 1
            val durationMs = (System.nanoTime() - started) / 1_000_000
            runCatching { onProbe(BridgeSshKeepAliveObservation(detail, failures, durationMs, error)) }
            if (failures >= maxFailures) {
                onFailure()
                return
            }
        }
    }
}
