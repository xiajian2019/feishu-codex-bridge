package dev.feishu.codex.bridge

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/** Global Web connection hook for the already installed OpenVPN for Android client. */
@CapacitorPlugin(name = "BridgeAutoVpn")
class BridgeAutoVpnPlugin : Plugin() {
    @PluginMethod
    fun requestRecovery(call: PluginCall) {
        val host = call.getString("host")
        val port = call.getInt("port", 0) ?: 0
        val target = BridgeAutoVpnPolicy.explicitTarget(host, port)
        if (target == null) {
            call.reject("Invalid Bridge network target.", "INVALID_TARGET")
            return
        }
        val main = activity as? MainActivity
        if (main == null) {
            call.reject("Bridge auto VPN is unavailable.", "AUTO_VPN_UNAVAILABLE")
            return
        }
        main.requestAutoVpn(target)
        call.resolve(JSObject().put("accepted", true))
    }
}
