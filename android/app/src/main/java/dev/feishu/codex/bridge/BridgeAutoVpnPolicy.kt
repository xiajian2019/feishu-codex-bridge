package dev.feishu.codex.bridge

internal data class BridgeVpnTarget(val host: String, val port: Int)
internal data class BridgeVpnProfile(val id: String, val label: String)
internal data class BridgeVpnStatus(val profileId: String?, val level: String?)

internal enum class BridgeVpnStartDecision { START, RESUME, WAIT, OTHER_VPN }

/** Decisions are separate from Android/IPC so the automatic action stays testable. */
internal object BridgeAutoVpnPolicy {
    fun target(defaultHost: String, defaultPort: Int, savedHosts: List<Pair<String, Int>>): BridgeVpnTarget? {
        val host = defaultHost.trim()
        val savedPort = savedHosts.firstOrNull { it.first.equals(host, ignoreCase = true) }?.second
        val port = savedPort?.takeIf { it in 1..65535 } ?: defaultPort
        return explicitTarget(host, port)
    }

    /** Build a probe target received from the current Bridge URL, including IPv6 URLs. */
    fun explicitTarget(rawHost: String?, port: Int): BridgeVpnTarget? {
        val host = rawHost?.trim().orEmpty().let { value ->
            if (value.startsWith("[") && value.endsWith("]")) value.substring(1, value.length - 1) else value
        }
        if (host.isEmpty() || host.any { it.isWhitespace() || it.isISOControl() }) return null
        // A single colon is a host:port string, not an IPv6 literal. The Web
        // layer passes the URL hostname and the port as separate fields.
        if (host.contains(':') && host.count { it == ':' } < 2) return null
        if (port !in 1..65535) return null
        return BridgeVpnTarget(host, port)
    }

    /** Reuse the explicit choice, or select the sole profile; never guess between profiles. */
    fun selectedProfile(profiles: List<BridgeVpnProfile>, savedId: String?): BridgeVpnProfile? {
        if (!savedId.isNullOrBlank()) profiles.firstOrNull { it.id == savedId }?.let { return it }
        return profiles.singleOrNull()
    }

    fun decide(profileId: String, status: BridgeVpnStatus?, systemVpnActive: Boolean): BridgeVpnStartDecision {
        val level = status?.level
        val active = level in ACTIVE_LEVELS
        if (active && status?.profileId == profileId) {
            if (level == "LEVEL_VPNPAUSED") return if (systemVpnActive) BridgeVpnStartDecision.OTHER_VPN else BridgeVpnStartDecision.RESUME
            return BridgeVpnStartDecision.WAIT
        }
        if (active || systemVpnActive) return BridgeVpnStartDecision.OTHER_VPN
        return BridgeVpnStartDecision.START
    }

    private val ACTIVE_LEVELS = setOf(
        "LEVEL_CONNECTED", "LEVEL_VPNPAUSED", "LEVEL_CONNECTING_SERVER_REPLIED",
        "LEVEL_CONNECTING_NO_SERVER_REPLY_YET", "LEVEL_NONETWORK", "LEVEL_START",
        "LEVEL_WAITING_FOR_USER_INPUT",
    )
}
