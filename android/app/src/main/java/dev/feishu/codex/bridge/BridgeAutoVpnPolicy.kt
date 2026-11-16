package dev.feishu.codex.bridge

internal data class BridgeVpnTarget(val host: String, val port: Int, val bypassWifiSsids: List<String> = emptyList())
internal data class BridgeVpnProfile(val id: String, val label: String)
internal data class BridgeVpnStatus(val profileId: String?, val level: String?)

internal enum class BridgeVpnStartDecision { START, RESUME, WAIT, OTHER_VPN, AUTH_FAILED }
internal enum class BridgeVpnNetworkDecision { CHECK, NO_NETWORK, REQUEST_LOCATION, UNKNOWN_WIFI, SKIP_WIFI }

/** Rate-limit repeated start requests while the provider updates its status. */
internal class BridgeAutoVpnStartThrottle(private val intervalMs: Long) {
    private var lastProfileId: String? = null
    private var lastRequestedAt: Long? = null

    fun remainingDelay(profileId: String, now: Long): Long {
        val last = lastRequestedAt ?: return 0
        if (lastProfileId != profileId) return 0
        return (intervalMs - (now - last)).coerceAtLeast(0)
    }

    fun requested(profileId: String, now: Long) {
        lastProfileId = profileId
        lastRequestedAt = now
    }
}

/** Decisions are separate from Android/IPC so the automatic action stays testable. */
internal object BridgeAutoVpnPolicy {
    fun target(defaultHost: String, defaultPort: Int, savedHosts: List<Pair<String, Int>>): BridgeVpnTarget? {
        val host = defaultHost.trim()
        val savedPort = savedHosts.firstOrNull { it.first.equals(host, ignoreCase = true) }?.second
        val port = savedPort?.takeIf { it in 1..65535 } ?: defaultPort
        return explicitTarget(host, port)
    }

    /** Build a probe target received from the current Bridge URL, including IPv6 URLs. */
    fun explicitTarget(rawHost: String?, port: Int, bypassWifiSsids: List<String> = emptyList()): BridgeVpnTarget? {
        val host = rawHost?.trim().orEmpty().let { value ->
            if (value.startsWith("[") && value.endsWith("]")) value.substring(1, value.length - 1) else value
        }
        if (host.isEmpty() || host.any { it.isWhitespace() || it.isISOControl() }) return null
        // A single colon is a host:port string, not an IPv6 literal. The Web
        // layer passes the URL hostname and the port as separate fields.
        if (host.contains(':') && host.count { it == ':' } < 2) return null
        if (port !in 1..65535) return null
        return BridgeVpnTarget(host, port, normalizeWifiSsids(bypassWifiSsids))
    }

    /** Decide from the actual network, independent of Bridge or SSH target reachability. */
    fun networkDecision(
        hasNetwork: Boolean,
        wifiConnected: Boolean,
        currentSsid: String?,
        bypassWifiSsids: List<String>,
        locationGranted: Boolean,
    ): BridgeVpnNetworkDecision {
        if (!hasNetwork) return BridgeVpnNetworkDecision.NO_NETWORK
        if (!wifiConnected || bypassWifiSsids.isEmpty()) return BridgeVpnNetworkDecision.CHECK
        if (normalizeWifiSsid(currentSsid) == null) {
            return if (locationGranted) BridgeVpnNetworkDecision.UNKNOWN_WIFI else BridgeVpnNetworkDecision.REQUEST_LOCATION
        }
        return if (shouldSkipForWifi(currentSsid, bypassWifiSsids)) BridgeVpnNetworkDecision.SKIP_WIFI
        else BridgeVpnNetworkDecision.CHECK
    }

    fun shouldSkipForWifi(currentSsid: String?, bypassWifiSsids: List<String>): Boolean {
        val normalized = normalizeWifiSsid(currentSsid) ?: return false
        return normalizeWifiSsids(bypassWifiSsids).any { it == normalized }
    }

    fun normalizeWifiSsid(value: String?): String? {
        val normalized = value?.trim()?.removeSurrounding("\"")?.trim().orEmpty()
        return normalized.takeUnless { it.isEmpty() || it == "<unknown ssid>" || it == "unknown ssid" }
    }

    /** Reuse the explicit choice, or select the sole profile; never guess between profiles. */
    fun selectedProfile(profiles: List<BridgeVpnProfile>, savedId: String?): BridgeVpnProfile? {
        if (!savedId.isNullOrBlank()) profiles.firstOrNull { it.id == savedId }?.let { return it }
        return profiles.singleOrNull()
    }

    fun decide(profileId: String, status: BridgeVpnStatus?, systemVpnActive: Boolean): BridgeVpnStartDecision {
        val level = status?.level
        if (level == "LEVEL_AUTH_FAILED" && (status.profileId.isNullOrBlank() || status.profileId == profileId)) {
            return BridgeVpnStartDecision.AUTH_FAILED
        }
        val active = level in ACTIVE_LEVELS
        if (active && status?.profileId == profileId) {
            if (level == "LEVEL_VPNPAUSED") return if (systemVpnActive) BridgeVpnStartDecision.OTHER_VPN else BridgeVpnStartDecision.RESUME
            return BridgeVpnStartDecision.WAIT
        }
        if (active || systemVpnActive) return BridgeVpnStartDecision.OTHER_VPN
        return BridgeVpnStartDecision.START
    }

    /** A deliberate user action may retry authentication once without replacing another VPN. */
    fun decideForManualCheck(profileId: String, status: BridgeVpnStatus?, systemVpnActive: Boolean): BridgeVpnStartDecision {
        val automatic = decide(profileId, status, systemVpnActive)
        if (automatic != BridgeVpnStartDecision.AUTH_FAILED) return automatic
        return if (systemVpnActive) BridgeVpnStartDecision.OTHER_VPN else BridgeVpnStartDecision.START
    }

    private val ACTIVE_LEVELS = setOf(
        "LEVEL_CONNECTED", "LEVEL_VPNPAUSED", "LEVEL_CONNECTING_SERVER_REPLIED",
        "LEVEL_CONNECTING_NO_SERVER_REPLY_YET", "LEVEL_NONETWORK", "LEVEL_START",
        "LEVEL_WAITING_FOR_USER_INPUT",
    )

    fun normalizeWifiSsids(values: List<String>): List<String> = values.asSequence()
        .mapNotNull(::normalizeWifiSsid)
        .distinct()
        .take(32)
        .toList()
}
