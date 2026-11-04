package dev.feishu.codex.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeAutoVpnPolicyTest {
    @Test
    fun probesOnlyTheConfiguredDefaultHostAndUsesItsSavedPort() {
        val target = BridgeAutoVpnPolicy.target(" 192.0.2.10 ", 22, listOf("192.0.2.20" to 2222, "192.0.2.10" to 2200))
        assertEquals(BridgeVpnTarget("192.0.2.10", 2200), target)
        assertEquals(BridgeVpnTarget("192.0.2.10", 22), BridgeAutoVpnPolicy.target("192.0.2.10", 22, listOf("192.0.2.20" to 2222)))
        assertEquals(BridgeVpnTarget("2001:db8::10", 7310), BridgeAutoVpnPolicy.explicitTarget("[2001:db8::10]", 7310))
        assertEquals(
            BridgeVpnTarget("192.0.2.10", 7310, listOf("Office WiFi")),
            BridgeAutoVpnPolicy.explicitTarget("192.0.2.10", 7310, listOf("Office WiFi", "Office WiFi")),
        )
        assertNull(BridgeAutoVpnPolicy.explicitTarget("10.0.0.1", 0))
        assertNull(BridgeAutoVpnPolicy.explicitTarget("10.0.0.1:7310", 7310))
        assertNull(BridgeAutoVpnPolicy.target(" ", 22, emptyList()))
        assertNull(BridgeAutoVpnPolicy.target("bad host", 22, emptyList()))
    }

    @Test
    fun skipsOnlyTheConfiguredCurrentWifi() {
        assertTrue(BridgeAutoVpnPolicy.shouldSkipForWifi("\"Office WiFi\"", listOf("Office WiFi")))
        assertFalse(BridgeAutoVpnPolicy.shouldSkipForWifi("Guest WiFi", listOf("Office WiFi")))
        assertFalse(BridgeAutoVpnPolicy.shouldSkipForWifi("<unknown ssid>", listOf("Office WiFi")))
    }

    @Test
    fun globalChecksUseNetworkAndWifiExemptionsRatherThanTargetReachability() {
        val decide = BridgeAutoVpnPolicy::networkDecision
        val bypass = listOf("Office WiFi")
        assertEquals(BridgeVpnNetworkDecision.NO_NETWORK, decide(false, false, null, bypass, true))
        assertEquals(BridgeVpnNetworkDecision.CHECK, decide(true, false, null, bypass, false))
        assertEquals(BridgeVpnNetworkDecision.CHECK, decide(true, true, "Guest", bypass, true))
        assertEquals(BridgeVpnNetworkDecision.SKIP_WIFI, decide(true, true, "\"Office WiFi\"", bypass, true))
        assertEquals(BridgeVpnNetworkDecision.CHECK, decide(true, true, null, emptyList(), false))
        assertEquals(BridgeVpnNetworkDecision.REQUEST_LOCATION, decide(true, true, null, bypass, false))
        assertEquals(BridgeVpnNetworkDecision.UNKNOWN_WIFI, decide(true, true, "<unknown ssid>", bypass, true))
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
        assertEquals(BridgeVpnStartDecision.AUTH_FAILED, decide("chosen", BridgeVpnStatus("chosen", "LEVEL_AUTH_FAILED"), false))
        assertEquals(BridgeVpnStartDecision.AUTH_FAILED, decide("chosen", BridgeVpnStatus(null, "LEVEL_AUTH_FAILED"), false))
        assertEquals(BridgeVpnStartDecision.START, decide("chosen", BridgeVpnStatus("other", "LEVEL_AUTH_FAILED"), false))
    }

    @Test
    fun manualRetryCanRecoverAnAuthFailureWithoutReplacingAnotherVpn() {
        val status = BridgeVpnStatus("chosen", "LEVEL_AUTH_FAILED")
        assertEquals(BridgeVpnStartDecision.AUTH_FAILED, BridgeAutoVpnPolicy.decide("chosen", status, false))
        assertEquals(BridgeVpnStartDecision.START, BridgeAutoVpnPolicy.decideForManualCheck("chosen", status, false))
        assertEquals(BridgeVpnStartDecision.OTHER_VPN, BridgeAutoVpnPolicy.decideForManualCheck("chosen", status, true))
        assertEquals(BridgeVpnStartDecision.WAIT, BridgeAutoVpnPolicy.decideForManualCheck(
            "chosen", BridgeVpnStatus("chosen", "LEVEL_CONNECTED"), true,
        ))
    }

    @Test
    fun repeatedNetworkEventsDoNotRepeatedlyStartTheSameProfile() {
        val throttle = BridgeAutoVpnStartThrottle(30_000)
        assertEquals(0L, throttle.remainingDelay("chosen", 1_000))
        throttle.requested("chosen", 1_000)
        assertEquals(29_000L, throttle.remainingDelay("chosen", 2_000))
        assertEquals(0L, throttle.remainingDelay("other", 2_000))
        assertEquals(0L, throttle.remainingDelay("chosen", 31_000))
    }
}
