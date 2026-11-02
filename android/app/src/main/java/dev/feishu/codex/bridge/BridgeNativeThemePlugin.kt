package dev.feishu.codex.bridge

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "BridgeNativeTheme")
class BridgeNativeThemePlugin : Plugin() {
    @PluginMethod
    fun setTheme(call: PluginCall) {
        val theme = call.getString("theme")?.trim()?.lowercase()
        if (theme != BridgeNativeTheme.LIGHT && theme != BridgeNativeTheme.DARK) {
            call.reject("Invalid native theme.", "INVALID_ARGUMENTS")
            return
        }
        BridgeNativeTheme.write(activity, theme)
        call.resolve()
    }

    @PluginMethod
    fun getTheme(call: PluginCall) {
        call.resolve(JSObject().put("theme", BridgeNativeTheme.read(activity)))
    }
}
