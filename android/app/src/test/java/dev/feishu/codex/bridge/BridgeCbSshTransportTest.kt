package dev.feishu.codex.bridge

import org.connectbot.sshlib.HostKeyVerifier
import org.connectbot.sshlib.PublicKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class BridgeCbSshTransportTest {
    @Test
    fun createsDisconnectedTransportWithoutTouchingTheNetwork() {
        val transport = BridgeCbSshTransport(
            host = "example.test",
            port = 2222,
            hostKeyVerifier = RejectingHostKeyVerifier,
        )

        assertEquals("example.test", transport.host)
        assertEquals(2222, transport.port)
        assertFalse(transport.isAuthenticated)
        assertNull(transport.connectionInfo)
    }

    @Test
    fun temporaryChannelsCannotAutomaticallyDisconnectTheClient() {
        val config = bridgeSshClientConfig("example.test", 2222, RejectingHostKeyVerifier, "SSH-2.0-test")
        assertFalse(config.autoDisconnectOnLastChannelClose)
        assertSame(RejectingHostKeyVerifier, config.hostKeyVerifier)
        assertEquals("SSH-2.0-test", config.clientVersion)
    }

    @Test
    fun validatesTerminalDimensions() {
        BridgeCbSshTransport.requireTerminalSize(120, 40, 0, 0)

        val invalidWidths = runCatching {
            BridgeCbSshTransport.requireTerminalSize(0, 40, 0, 0)
        }.exceptionOrNull()
        assertEquals("widthChars must be positive", invalidWidths?.message)

        val invalidPixels = runCatching {
            BridgeCbSshTransport.requireTerminalSize(120, 40, -1, 0)
        }.exceptionOrNull()
        assertEquals("widthPixels cannot be negative", invalidPixels?.message)
    }

    private object RejectingHostKeyVerifier : HostKeyVerifier {
        override suspend fun verify(key: PublicKey): Boolean = false
    }
}
