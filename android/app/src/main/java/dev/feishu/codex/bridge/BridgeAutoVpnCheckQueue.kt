package dev.feishu.codex.bridge

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** Coalesce simultaneous lifecycle, network and timer triggers without missing a later check. */
internal class BridgeAutoVpnCheckQueue(
    private val scope: CoroutineScope,
    private val check: suspend () -> Unit,
) {
    private var job: Job? = null
    private var pending = false

    fun request() {
        if (job?.isActive == true) {
            pending = true
            return
        }
        val next = scope.launch(start = CoroutineStart.LAZY) {
            do {
                pending = false
                check()
            } while (pending && isActive)
        }
        job = next
        next.invokeOnCompletion { if (job === next) job = null }
        next.start()
    }
}
