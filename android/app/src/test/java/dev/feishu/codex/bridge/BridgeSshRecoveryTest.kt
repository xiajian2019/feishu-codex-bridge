package dev.feishu.codex.bridge

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeSshRecoveryTest {
    @Test
    fun retriesWithBackoffUntilConnectedAndDoesNotRepeatAfterSuccess() = runBlocking {
        val waits = mutableListOf<Long>()
        val messages = mutableListOf<String>()
        val loop = BridgeSshRecoveryLoop(listOf(1, 2, 4), pause = { waits += it })
        var attempts = 0
        val result = loop.run(attempt = {
            attempts += 1
            if (attempts < 4) BridgeSshRecoveryResult.Retry("offline") else BridgeSshRecoveryResult.Connected
        }, onRetry = { message, _ -> messages += message })
        assertEquals(BridgeSshRecoveryResult.Connected, result)
        assertEquals(4, attempts)
        assertEquals(listOf(1L, 2L, 4L), waits)
        assertEquals(3, messages.size)
    }

    @Test
    fun permanentFailureAndCancellationStopAutomaticAttempts() = runBlocking {
        var attempts = 0
        val blocked = CompletableDeferred<Unit>()
        val loop = BridgeSshRecoveryLoop(listOf(1), pause = { blocked.await() })
        val stopped = loop.run(attempt = {
            attempts += 1
            BridgeSshRecoveryResult.Stop("host key changed")
        }, onRetry = { _, _ -> throw AssertionError("must not retry") })
        assertTrue(stopped is BridgeSshRecoveryResult.Stop)
        assertEquals(1, attempts)
        val job = launch {
            loop.run(attempt = { attempts += 1; BridgeSshRecoveryResult.Retry("offline") }, onRetry = { _, _ -> })
        }
        kotlinx.coroutines.yield()
        job.cancelAndJoin()
        assertEquals(2, attempts)
    }

    @Test
    fun swappingTransportPreservesListenerAndSizeAndClosesOnlyOldChannel() {
        val first = FakeTransport()
        val second = FakeTransport()
        val bridge = BridgeSshSwitchingTerminalTransport(first)
        val output = mutableListOf<Byte>()
        val states = mutableListOf<BridgeSshConnectionState>()
        val listener = object : BridgeSshTerminalTransport.Listener {
            override fun onSshOutput(bytes: ByteArray, offset: Int, length: Int) { output.addAll(bytes.slice(offset until offset + length)) }
            override fun onStateChanged(state: BridgeSshConnectionState, message: String?) { states += state }
            override fun onClosed(message: String?) = Unit
        }
        bridge.attach(listener)
        val size = BridgeSshTerminalSize(32, 100)
        bridge.requestResize(size)
        first.emit(byteArrayOf(1))
        bridge.setState(BridgeSshConnectionState.CONNECTING, "retrying")
        bridge.replace(second)
        assertTrue(first.closed)
        assertFalse(second.closed)
        assertEquals(size, second.size)
        first.emit(byteArrayOf(9))
        second.emit(byteArrayOf(2))
        bridge.writeToSsh(byteArrayOf(3), 0, 1)
        bridge.setState(BridgeSshConnectionState.CONNECTED, null)
        assertEquals(listOf<Byte>(1, 2), output)
        assertArrayEquals(byteArrayOf(3), second.written)
        assertEquals(listOf(BridgeSshConnectionState.CONNECTING, BridgeSshConnectionState.CONNECTED), states)
        bridge.close()
        assertTrue(second.closed)
        assertEquals(null, second.listener)
    }

    private class FakeTransport : BridgeSshTerminalTransport {
        override val initialState = BridgeSshConnectionState.CONNECTED
        var listener: BridgeSshTerminalTransport.Listener? = null
        var size: BridgeSshTerminalSize? = null
        var written: ByteArray? = null
        var closed = false
        override fun attach(listener: BridgeSshTerminalTransport.Listener?) { this.listener = listener }
        override fun requestResize(size: BridgeSshTerminalSize) { this.size = size }
        override fun writeToSsh(bytes: ByteArray, offset: Int, length: Int) { written = bytes.copyOfRange(offset, offset + length) }
        override fun close() { closed = true }
        fun emit(bytes: ByteArray) { listener?.onSshOutput(bytes, 0, bytes.size) }
    }
}
