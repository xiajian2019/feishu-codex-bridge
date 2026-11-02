package dev.feishu.codex.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BridgeAutoVpnPolicyTest {
    @Test
    fun probesOnlyTheConfiguredDefaultHostAndUsesItsSavedPort() {
        val target = BridgeAutoVpnPolicy.target(" 192.0.2.10 ", 22, listOf("192.0.2.20" to 2222, "192.0.2.10" to 2200))
        assertEquals(BridgeVpnTarget("192.0.2.10", 2200), target)
        assertEquals(BridgeVpnTarget("192.0.2.10", 22), BridgeAutoVpnPolicy.target("192.0.2.10", 22, listOf("192.0.2.20" to 2222)))
        assertEquals(BridgeVpnTarget("2001:db8::10", 7310), BridgeAutoVpnPolicy.explicitTarget("[2001:db8::10]", 7310))
        assertNull(BridgeAutoVpnPolicy.explicitTarget("10.0.0.1", 0))
        assertNull(BridgeAutoVpnPolicy.explicitTarget("10.0.0.1:7310", 7310))
        assertNull(BridgeAutoVpnPolicy.target(" ", 22, emptyList()))
        assertNull(BridgeAutoVpnPolicy.target("bad host", 22, emptyList()))
    }

    @Test
    fun neverSelectsAnArbitraryProfileWhenSeveralExist() {
        val first = BridgeVpnProfile("first", "First")
        val second = BridgeVpnProfile("second", "Second")
        assertEquals(first, BridgeAutoVpnPolicy.selectedProfile(listOf(first), null))
        assertEquals(second, BridgeAutoVpnPolicy.selectedProfile(listOf(first, second), "second"))
        assertNull(BridgeAutoVpnPolicy.selectedProfile(listOf(first, second), null))
        assertNull(BridgeAutoVpnPolicy.selectedProfile(listOf(first, second), "deleted"))
        assertNull(BridgeAutoVpnPolicy.selectedProfile(emptyList(), "first"))
    }

    @Test
    fun avoidsRestartingTheSelectedVpnOrReplacingAnotherVpn() {
        val decide = BridgeAutoVpnPolicy::decide
        assertEquals(BridgeVpnStartDecision.START, decide("chosen", null, false))
        assertEquals(BridgeVpnStartDecision.START, decide("chosen", BridgeVpnStatus("chosen", "LEVEL_NOTCONNECTED"), false))
        assertEquals(BridgeVpnStartDecision.WAIT, decide("chosen", BridgeVpnStatus("chosen", "LEVEL_CONNECTED"), true))
        assertEquals(BridgeVpnStartDecision.WAIT, decide("chosen", BridgeVpnStatus("chosen", "LEVEL_CONNECTING_NO_SERVER_REPLY_YET"), false))
        assertEquals(BridgeVpnStartDecision.RESUME, decide("chosen", BridgeVpnStatus("chosen", "LEVEL_VPNPAUSED"), false))
        assertEquals(BridgeVpnStartDecision.OTHER_VPN, decide("chosen", BridgeVpnStatus("chosen", "LEVEL_VPNPAUSED"), true))
        assertEquals(BridgeVpnStartDecision.OTHER_VPN, decide("chosen", BridgeVpnStatus("other", "LEVEL_CONNECTED"), true))
        assertEquals(BridgeVpnStartDecision.OTHER_VPN, decide("chosen", null, true))
    }
}
