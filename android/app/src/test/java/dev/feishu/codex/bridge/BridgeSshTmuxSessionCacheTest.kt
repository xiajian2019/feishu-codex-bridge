package dev.feishu.codex.bridge

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class BridgeSshTmuxSessionCacheTest {
    private fun session(name: String) = BridgeSshTmuxSession("\$1", name, 1, false, "/repo", 1)

    @Test
    fun openingReusesTheFirstResultAndExplicitRefreshLoadsAgain() = runBlocking {
        val cache = BridgeSshTmuxSessionCache()
        var requests = 0
        suspend fun fetch(): List<BridgeSshTmuxSession> {
            requests += 1
            return listOf(session("session-$requests"))
        }

        assertEquals(BridgeSshTmuxLoadResult.Loaded, cache.load(force = false, ::fetch))
        assertEquals(BridgeSshTmuxLoadResult.Skipped, cache.load(force = false, ::fetch))
        assertEquals(1, requests)
        assertEquals("session-1", cache.sessions!!.single().name)
        assertEquals(BridgeSshTmuxLoadResult.Loaded, cache.load(force = true, ::fetch))
        assertEquals(2, requests)
        assertEquals("session-2", cache.sessions!!.single().name)
        assertFalse(cache.refreshing)
    }

    @Test
    fun emptyResultsAreCachedAndARefreshFailureKeepsLastSuccessfulList() = runBlocking {
        val cache = BridgeSshTmuxSessionCache()
        var requests = 0
        cache.load(force = false) { requests += 1; emptyList() }
        cache.load(force = false) { requests += 1; listOf(session("unexpected")) }
        assertEquals(1, requests)
        assertEquals(emptyList<BridgeSshTmuxSession>(), cache.sessions)

        val result = cache.load(force = true) { throw IOException("offline") }
        assertTrue(result is BridgeSshTmuxLoadResult.Failed)
        assertEquals(emptyList<BridgeSshTmuxSession>(), cache.sessions)
        assertFalse(cache.refreshing)
    }

    @Test
    fun resetPreventsAnOldConnectionFromOverwritingTheNewSessionList() = runBlocking {
        val cache = BridgeSshTmuxSessionCache()
        val oldResponse = CompletableDeferred<List<BridgeSshTmuxSession>>()
        val oldRequest = async(start = CoroutineStart.UNDISPATCHED) { cache.load(force = false) { oldResponse.await() } }
        assertTrue(cache.refreshing)
        cache.reset()
        assertNull(cache.sessions)
        assertFalse(cache.refreshing)
        cache.load(force = false) { listOf(session("new-host")) }
        oldResponse.complete(listOf(session("old-host")))
        assertEquals(BridgeSshTmuxLoadResult.Skipped, oldRequest.await())
        assertEquals("new-host", cache.sessions!!.single().name)
        assertFalse(cache.refreshing)
    }
}
