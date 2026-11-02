package dev.feishu.codex.bridge

import android.content.Intent
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Opens the native ConnectBot-based SSH workspace.
 *
 * The WebView sends only connection metadata. Private-key material is picked
 * and retained by [BridgeConnectBotSshActivity] on the native side.
 */
@CapacitorPlugin(name = "BridgeConnectBotSSH")
class BridgeConnectBotSSHPlugin : Plugin() {
    /** Return metadata only; private keys remain in the native vault. */
    @PluginMethod
    fun listOptions(call: PluginCall) {
        try {
            val profiles = JSArray()
            BridgeSshProfileStore(context).list().forEach { profile ->
                profiles.put(JSObject().apply {
                    put("id", profile.id)
                    put("label", profile.label)
                    put("host", profile.host)
                    put("port", profile.port)
                    put("username", profile.username)
                    put("keyId", profile.keyId)
                    put("startupCommand", profile.startupCommand)
                })
            }
            val keys = JSArray()
            BridgeSshKeyStore.list(context).forEach { key ->
                keys.put(JSObject().apply {
                    put("id", key.id)
                    put("nickname", key.nickname)
                    put("algorithm", key.algorithm)
                })
            }
            call.resolve(JSObject().apply { put("profiles", profiles); put("keys", keys) })
        } catch (_: Exception) {
            call.reject("无法读取 SSH 主机或密钥列表，原有数据已保留。", "SSH_OPTIONS_UNAVAILABLE")
        }
    }

    /** Open the existing native manager without leaving the current Activity. */
    @PluginMethod
    fun openWorkspace(call: PluginCall) {
        val serverOrigin = bridgeServerOrigin(call)
        if (serverOrigin == null && !call.getString("bridgeServerOrigin").isNullOrBlank()) return
        val defaultHost = call.getString("defaultHost")?.trim().orEmpty()
        if (defaultHost.length > BridgeSshProtocol.MAX_HOST_LENGTH || containsControl(defaultHost)) {
            call.reject("Invalid default SSH host.", "INVALID_ARGUMENTS")
            return
        }
        val request = Intent(activity, BridgeConnectBotSshActivity::class.java)
            .apply {
                serverOrigin?.let { putExtra(BridgeConnectBotSshActivity.EXTRA_BRIDGE_SERVER_ORIGIN, it) }
                if (defaultHost.isNotBlank()) putExtra(BridgeConnectBotSshActivity.EXTRA_DEFAULT_HOST, defaultHost)
                if (call.getString("mode") == "manage") {
                    putExtra(BridgeConnectBotSshActivity.EXTRA_MANAGE, true)
                }
            }
        openInHost(call, request)
    }

    internal fun workspaceClosed(returnToWorkbench: Boolean) {
        notifyListeners("workspaceClosed", JSObject().apply { put("returnToWorkbench", returnToWorkbench) })
        if (returnToWorkbench) {
            // Keep this navigation request until its dedicated Web listener is
            // registered; the ordinary close listener only refreshes hosts.
            notifyListeners("returnToWorkbench", JSObject(), true)
        }
    }

    @PluginMethod
    fun setWorkspaceVisible(call: PluginCall) {
        val visible = call.getBoolean("visible", true) ?: true
        activity.runOnUiThread {
            val changed = (activity as? MainActivity)?.setEmbeddedSshWorkspaceVisible(visible) == true
            call.resolve(JSObject().put("workspaceOpen", changed))
        }
    }

    @PluginMethod
    fun closeWorkspace(call: PluginCall) {
        activity.runOnUiThread {
            (activity as? MainActivity)?.closeEmbeddedSshWorkspace()
            call.resolve()
        }
    }

    @PluginMethod
    fun setUpdateBanner(call: PluginCall) {
        val visible = call.getBoolean("visible", false) ?: false
        val state = if (visible) BridgeAppUpdateBannerState(
            detail = call.getString("detail").orEmpty().take(200),
            status = call.getString("status").orEmpty().take(240),
            error = call.getString("error").orEmpty().take(300),
            busy = call.getBoolean("busy", false) ?: false,
            downloaded = call.getBoolean("downloaded", false) ?: false,
        ) else null
        activity.runOnUiThread {
            (activity as? MainActivity)?.setAppUpdateBanner(state)
            call.resolve()
        }
    }

    internal fun updateAction(action: String) {
        if (action in setOf("install", "download", "dismiss")) {
            notifyListeners("updateAction", JSObject().put("action", action))
        }
    }

    @PluginMethod
    fun openTerminal(call: PluginCall) {
        val host = call.getString("host")?.trim()
        val username = call.getString("username")?.trim()
        val port = call.getInt("port", BridgeSshProtocol.DEFAULT_PORT)
        val password = call.getString("password")
        val startupCommand = call.getString("startupCommand")
        val profileId = call.getString("profileId")
        val keyId = call.getString("keyId")
        val serverOrigin = bridgeServerOrigin(call)
        if (serverOrigin == null && !call.getString("bridgeServerOrigin").isNullOrBlank()) return

        if (host.isNullOrEmpty() || host.length > BridgeSshProtocol.MAX_HOST_LENGTH || containsControl(host)) {
            call.reject("Invalid SSH host.", "INVALID_ARGUMENTS")
            return
        }
        if (username.isNullOrEmpty() || username.length > BridgeSshProtocol.MAX_USERNAME_LENGTH
            || username.any { it.isWhitespace() || it.code < 0x20 || it.code == 0x7f }) {
            call.reject("Invalid SSH username.", "INVALID_ARGUMENTS")
            return
        }
        if (port !in 1..65535) {
            call.reject("Invalid SSH port.", "INVALID_ARGUMENTS")
            return
        }
        if (password != null && (password.length > BridgeSshProtocol.MAX_PASSWORD_LENGTH
            || password.any { it.code == 0 })) {
            call.reject("Invalid SSH password.", "INVALID_ARGUMENTS")
            return
        }
        if (startupCommand != null && (startupCommand.length > BridgeSshProtocol.MAX_STARTUP_COMMAND_LENGTH
            || startupCommand.any { it.code == 0 })) {
            call.reject("Invalid SSH startup command.", "INVALID_ARGUMENTS")
            return
        }

        val intent = Intent(activity, BridgeConnectBotSshActivity::class.java)
            .putExtra(BridgeConnectBotSshActivity.EXTRA_HOST, host)
            .putExtra(BridgeConnectBotSshActivity.EXTRA_PORT, port)
            .putExtra(BridgeConnectBotSshActivity.EXTRA_USERNAME, username)
            .putExtra(BridgeConnectBotSshActivity.EXTRA_PASSWORD, password)
            .putExtra(BridgeConnectBotSshActivity.EXTRA_STARTUP_COMMAND, startupCommand)
            .putExtra(BridgeConnectBotSshActivity.EXTRA_PROFILE_ID, profileId)
            .putExtra(BridgeConnectBotSshActivity.EXTRA_KEY_ID, keyId)
            .apply { serverOrigin?.let { putExtra(BridgeConnectBotSshActivity.EXTRA_BRIDGE_SERVER_ORIGIN, it) } }
        openInHost(call, intent)
    }

    private fun bridgeServerOrigin(call: PluginCall): String? {
        val value = call.getString("bridgeServerOrigin")
        if (value.isNullOrBlank()) return null
        return try {
            BridgeSecureCredentialStore.normalizeServerOrigin(value)
        } catch (_: Exception) {
            call.reject("当前 Bridge 地址无效，请重新连接后再打开 SSH。", "BRIDGE_ORIGIN_REQUIRED")
            null
        }
    }

    private fun openInHost(call: PluginCall, request: Intent?) {
        activity.runOnUiThread {
            try {
                val hostActivity = activity
                if (hostActivity is MainActivity) {
                    hostActivity.openEmbeddedSshWorkspace(request)
                } else {
                    hostActivity.startActivity(request ?: Intent(hostActivity, BridgeConnectBotSshActivity::class.java))
                }
                call.resolve()
            } catch (_: RuntimeException) {
                call.reject("无法打开 SSH 工作区。", "NATIVE_TERMINAL_UNAVAILABLE")
            }
        }
    }

    private fun containsControl(value: String): Boolean = value.any {
        it.code < 0x20 || it.code == 0x7f
    }
}
