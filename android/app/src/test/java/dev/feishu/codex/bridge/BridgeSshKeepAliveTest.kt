package dev.feishu.codex.bridge

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.connectbot.sshlib.SshSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Proxy

class BridgeSshKeepAliveTest {
    @Test
    fun recurringProbesStopWhenTheirOwnerCancels() = runBlocking {
        var probes = 0
        var failures = 0
        val monitor = BridgeSshKeepAlive(probe = { probes += 1; true }, intervalMs = 5, timeoutMs = 100)
        val job = launch { monitor.run { failures += 1 } }
        withTimeout(1_000) { while (probes < 3) delay(1) }
        job.cancelAndJoin()
        val stoppedAt = probes
        delay(30)
        assertEquals(stoppedAt, probes)
        assertEquals(0, failures)
    }

    @Test
    fun isolatedFailuresRecoverButRepeatedTimeoutsReportFailure() = runBlocking {
        var probes = 0
        var failures = 0
        val observations = mutableListOf<BridgeSshKeepAliveObservation>()
        val monitor = BridgeSshKeepAlive(probe = {
            probes += 1
            when (probes) {
                3 -> true
                6 -> { delay(500); true }
                else -> false
            }
        }, intervalMs = 5, timeoutMs = 15, maxFailures = 3, onProbe = { observations.add(it) })
        withTimeout(1_000) { monitor.run { failures += 1 } }
        assertEquals(6, probes)
        assertEquals(1, failures)
        assertEquals(listOf(1, 2, 0, 1, 2, 3), observations.map { it.failures })
        assertEquals(BridgeSshTraceDetail.HEALTHY, observations[2].detail)
        assertEquals(BridgeSshTraceDetail.TIMEOUT, observations.last().detail)
    }

    @Test
    fun fallbackKeepAliveUsesLatestPtySizeWithoutWritingShellInput() = runBlocking {
        val requests = mutableListOf<List<Int>>()
        val session = Proxy.newProxyInstance(SshSession::class.java.classLoader, arrayOf(SshSession::class.java)) { _, method, args ->
            when (method.name) {
                "resizeTerminal" -> { requests += args!!.take(4).map { it as Int }; true }
                "isOpen" -> true
                "getExitInfo" -> CompletableDeferred<org.connectbot.sshlib.SessionExit?>()
                else -> throw AssertionError("Unexpected SSH call: ${method.name}")
            }
        } as SshSession
        val shell = BridgeCbSshShell(session, BridgeCbSshTerminalSize(80, 24, 0, 0)) {}
        assertTrue(shell.keepAlive())
        assertTrue(shell.resize(101, 33, 500, 700))
        assertTrue(shell.keepAlive())
        assertEquals(listOf(listOf(80, 24, 0, 0), listOf(101, 33, 500, 700), listOf(101, 33, 500, 700)), requests)
    }
}
