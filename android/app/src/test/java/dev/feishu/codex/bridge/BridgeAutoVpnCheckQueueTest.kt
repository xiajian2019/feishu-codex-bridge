package dev.feishu.codex.bridge

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Test

class BridgeAutoVpnCheckQueueTest {
    @Test
    fun networkChangesDuringACheckCauseOneFollowupWithoutOverlappingChecks() = runBlocking {
        val firstStarted = CompletableDeferred<Unit>()
        val releaseFirst = CompletableDeferred<Unit>()
        var checks = 0
        var active = 0
        var maximumActive = 0
        val queue = BridgeAutoVpnCheckQueue(this) {
            checks += 1
            active += 1
            maximumActive = maxOf(maximumActive, active)
            if (checks == 1) {
                firstStarted.complete(Unit)
                releaseFirst.await()
            }
            active -= 1
        }
        queue.request()
        firstStarted.await()
        repeat(10) { queue.request() }
        assertEquals(1, checks)
        releaseFirst.complete(Unit)
        withTimeout(2_000) { while (checks < 2) yield() }
        yield()
        assertEquals(2, checks)
        assertEquals(1, maximumActive)
        queue.request()
        withTimeout(2_000) { while (checks < 3) yield() }
        assertEquals(3, checks)
    }
}
