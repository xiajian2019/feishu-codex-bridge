package dev.feishu.codex.bridge

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

class BridgeAutoVpnRecoverySignalTest {
    @Test
    fun sshFailureRequestsTheAttachedGlobalCheck() = runBlocking {
        val checked = CompletableDeferred<Unit>()
        val queue = BridgeAutoVpnCheckQueue(this) { checked.complete(Unit) }
        val listener = Runnable { queue.request() }
        BridgeAutoVpnRecoverySignal.attach(listener)
        try {
            BridgeAutoVpnRecoverySignal.request()
            withTimeout(2_000) { checked.await() }
        } finally {
            BridgeAutoVpnRecoverySignal.detach(listener)
        }
    }

    @Test
    fun destroyingAnOldActivityDoesNotDetachTheNewActivity() {
        var oldChecks = 0
        var newChecks = 0
        val old = Runnable { oldChecks += 1 }
        val current = Runnable { newChecks += 1 }
        BridgeAutoVpnRecoverySignal.attach(old)
        BridgeAutoVpnRecoverySignal.attach(current)
        try {
            BridgeAutoVpnRecoverySignal.detach(old)
            BridgeAutoVpnRecoverySignal.request()
            assertEquals(0, oldChecks)
            assertEquals(1, newChecks)
            BridgeAutoVpnRecoverySignal.detach(current)
            BridgeAutoVpnRecoverySignal.request()
            assertEquals(1, newChecks)
        } finally {
            BridgeAutoVpnRecoverySignal.detach(current)
        }
    }
}
