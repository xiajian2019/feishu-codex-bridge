package dev.feishu.codex.bridge

import android.content.Intent
import android.net.Uri
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.regex.Pattern

@CapacitorPlugin(name = "BridgeRemoteDesktop")
class BridgeRemoteDesktopPlugin : Plugin() {
    override fun load() {
        super.load()
        loaded = this
    }

    @PluginMethod
    fun open(call: PluginCall) {
        val raw = call.getString("url")
        if (raw.isNullOrBlank()) {
            call.reject("Android 原生 VNC 地址无效，请检查 Bridge 主机网络地址。", "INVALID_VNC_TARGET")
            return
        }
        val uri = Uri.parse(raw)
        val host = uri.host
        val port = if (uri.port == -1) 5900 else uri.port
        if (uri.scheme?.lowercase() != "vnc" || host.isNullOrBlank()
            || uri.encodedPath.orEmpty().isNotEmpty() && uri.encodedPath != "/"
            || uri.queryParameterNames.isNotEmpty()
            || uri.encodedAuthority?.contains('@') == true
            || port !in 1..65_535
            || !VNC_HOST_PATTERN.matcher(host).matches()) {
            call.reject("Android 原生 VNC 地址无效，请检查 Bridge 主机网络地址。", "INVALID_VNC_TARGET")
            return
        }
        val title = call.getString("title")?.take(120).orEmpty().ifBlank { "远程桌面" }
        activity.runOnUiThread {
            try {
                val active = BridgeRemoteDesktopActivity.activeInstance()
                if (active != null) {
                    active.reconnect(host, port, title)
                } else {
                    activity.startActivity(Intent(activity, BridgeRemoteDesktopActivity::class.java).apply {
                        putExtra(BridgeRemoteDesktopActivity.EXTRA_HOST, host)
                        putExtra(BridgeRemoteDesktopActivity.EXTRA_PORT, port)
                        putExtra(BridgeRemoteDesktopActivity.EXTRA_TITLE, title)
                    })
                }
                call.resolve()
            } catch (error: RuntimeException) {
                call.reject(error.message ?: "无法打开 Android 原生 VNC。", "NATIVE_VNC_UNAVAILABLE")
            }
        }
    }

    @PluginMethod
    fun close(call: PluginCall) {
        activity.runOnUiThread {
            BridgeRemoteDesktopActivity.activeInstance()?.finishWorkspace()
            call.resolve()
        }
    }

    internal fun workspaceClosed() {
        notifyListeners("workspaceClosed", JSObject())
    }

    internal fun requestReconnect(reason: String) {
        notifyListeners("reconnectRequested", JSObject().put("reason", reason), true)
    }

    companion object {
        @Volatile
        private var loaded: BridgeRemoteDesktopPlugin? = null

        internal fun notifyWorkspaceClosed() {
            loaded?.workspaceClosed()
        }

        internal fun notifyReconnectRequested(reason: String) {
            loaded?.requestReconnect(reason)
        }

        val VNC_HOST_PATTERN: Pattern = Pattern.compile("^[A-Za-z0-9._:-]{1,253}$")
    }
}
