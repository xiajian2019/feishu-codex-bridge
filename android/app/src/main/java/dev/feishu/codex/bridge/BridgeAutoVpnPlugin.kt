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
        val bypassWifiSsids = call.getArray("bypassWifiSsids")?.let { values ->
            (0 until values.length()).mapNotNull { index -> values.opt(index)?.toString() }
        } ?: emptyList()
        val target = BridgeAutoVpnPolicy.explicitTarget(host, port, bypassWifiSsids)
        if (target == null) {
            call.reject("Invalid Bridge network target.", "INVALID_TARGET")
            return
        }
        val main = activity as? MainActivity
        if (main == null) {
            call.reject("Bridge auto VPN is unavailable.", "AUTO_VPN_UNAVAILABLE")
            return
        }
        main.runOnUiThread {
            main.requestAutoVpn(target)
            call.resolve(JSObject().put("accepted", true))
        }
    }

    @PluginMethod
    fun configure(call: PluginCall) {
        val main = activity as? MainActivity
        if (main == null) {
            call.reject("Bridge auto VPN is unavailable.", "AUTO_VPN_UNAVAILABLE")
            return
        }
        val values = call.getArray("bypassWifiSsids")
        val bypass = if (values == null) emptyList() else (0 until values.length()).mapNotNull { index ->
            values.opt(index) as? String
        }
        main.runOnUiThread {
            main.configureAutoVpn(bypass)
            call.resolve(JSObject().put("accepted", true))
        }
    }

    @PluginMethod
    fun checkAndConnect(call: PluginCall) {
        val main = activity as? MainActivity
        if (main == null) {
            call.reject("VPN 控制器不可用，请重新打开 App。", "AUTO_VPN_UNAVAILABLE")
            return
        }
        val values = call.getArray("bypassWifiSsids")
        val bypass = if (values == null) emptyList() else (0 until values.length()).mapNotNull { index ->
            values.opt(index) as? String
        }
        main.runOnUiThread {
            main.checkAutoVpn(bypass).whenComplete { message, error ->
                main.runOnUiThread {
                    if (error != null) call.reject("VPN 检查失败，请检查 OpenVPN 配置后重试。", "AUTO_VPN_CHECK_FAILED")
                    else call.resolve(JSObject().put("message", message))
                }
            }
        }
    }

    @PluginMethod
    fun getCurrentWifi(call: PluginCall) {
        val main = activity as? MainActivity
        if (main == null) {
            call.reject("Bridge Wi-Fi information is unavailable.", "WIFI_UNAVAILABLE")
            return
        }
        main.requestCurrentWifi(call)
    }
}
