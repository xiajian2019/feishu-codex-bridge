package dev.feishu.codex.bridge

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/** Narrow bridge for authenticated configuration snapshots, not credentials. */
@CapacitorPlugin(name = "BridgeComposerData")
class BridgeComposerDataPlugin : Plugin() {
    private val database by lazy { BridgeComposerDatabase(context) }

    @PluginMethod
    fun activate(call: PluginCall) {
        val scope = call.getString("scope")
        if (scope.isNullOrBlank()) {
            call.reject("Composer source is missing.", "INVALID_ARGUMENTS")
            return
        }
        try {
            database.activate(scope)
            call.resolve()
        } catch (_: Exception) {
            call.reject("Could not activate Composer data.", "COMPOSER_STORAGE_ERROR")
        }
    }

    @PluginMethod
    fun deactivate(call: PluginCall) {
        try {
            database.deactivate(call.getString("scope"), call.getString("keepScope"))
            call.resolve()
        } catch (_: Exception) {
            call.reject("Could not deactivate Composer data.", "COMPOSER_STORAGE_ERROR")
        }
    }

    @PluginMethod
    fun save(call: PluginCall) {
        val scope = call.getString("scope")
        val values = call.getArray("snapshots")
        if (scope.isNullOrBlank() || values == null || values.length() == 0) {
            call.reject("Composer snapshots are missing.", "INVALID_ARGUMENTS")
            return
        }
        try {
            val snapshots = (0 until values.length()).map { index ->
                val value = values.getJSONObject(index)
                BridgeComposerSnapshot(
                    dataset = value.getString("dataset"),
                    key = value.optString("key", ""),
                    payload = value.getJSONObject("payload"),
                )
            }
            database.saveActive(scope, snapshots)
            call.resolve()
        } catch (_: Exception) {
            call.reject("Could not save Composer data for the active source.", "COMPOSER_STORAGE_ERROR")
        }
    }

    @PluginMethod
    fun read(call: PluginCall) {
        val dataset = call.getString("dataset")
        if (dataset.isNullOrBlank()) {
            call.reject("Composer dataset is missing.", "INVALID_ARGUMENTS")
            return
        }
        try {
            val snapshot = database.readActive(dataset, call.getString("key", "") ?: "")
            val result = JSObject().put("found", snapshot != null)
            if (snapshot != null) {
                result.put("payload", snapshot.payload)
                result.put("updatedAt", snapshot.updatedAt)
            }
            call.resolve(result)
        } catch (_: Exception) {
            call.reject("Could not read Composer data.", "COMPOSER_STORAGE_ERROR")
        }
    }

    @PluginMethod
    fun clearScope(call: PluginCall) {
        val scope = call.getString("scope")
        if (scope.isNullOrBlank()) {
            call.reject("Composer source is missing.", "INVALID_ARGUMENTS")
            return
        }
        try {
            database.clearScope(scope)
            call.resolve()
        } catch (_: Exception) {
            call.reject("Could not clear Composer data.", "COMPOSER_STORAGE_ERROR")
        }
    }
}
