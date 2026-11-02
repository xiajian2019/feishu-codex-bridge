package dev.feishu.codex.bridge

import org.json.JSONObject

internal data class BridgeSshShortcutGroup(
    val id: String,
    val title: String,
    val icon: String,
    val surface: String,
    val layout: String,
    val sortOrder: Int,
    val enabled: Boolean,
)

internal data class BridgeSshShortcut(
    val id: String,
    val groupId: String,
    val title: String,
    val detail: String,
    val kind: String,
    val value: String,
    val actionKey: String?,
    val displayMode: String,
    val sortOrder: Int,
    val operationCount: Long,
    val enabled: Boolean,
    val dangerous: Boolean,
)

internal data class BridgeSshShortcutCatalog(
    val groups: List<BridgeSshShortcutGroup>,
    val shortcuts: List<BridgeSshShortcut>,
    val terminalSequences: Map<String, String>,
) {
    fun toolbar(expanded: Boolean): List<BridgeSshShortcut> {
        val enabledGroups = groups.filter { it.enabled && it.surface == "composer" }.map { it.id }.toSet()
        val mode = if (expanded) "expanded" else "closed"
        return shortcuts.filter {
            it.enabled && it.groupId in enabledGroups && (it.displayMode == mode || it.displayMode == "both")
        }.sortedWith(compareBy<BridgeSshShortcut> { it.sortOrder }.thenBy { it.id })
    }

    fun paletteGroups(): List<BridgeSshShortcutGroup> = groups
        .filter { it.enabled && it.surface == "palette" }
        .sortedWith(compareBy<BridgeSshShortcutGroup> { it.sortOrder }.thenBy { it.id })

    fun paletteItems(groupId: String, usage: Map<String, Long> = emptyMap()): List<BridgeSshShortcut> {
        val enabledGroups = paletteGroups().map { it.id }.toSet()
        val enabled = shortcuts.filter { it.enabled && it.groupId in enabledGroups }
        if (groupId == "favorites") {
            return enabled.sortedWith(
                compareByDescending<BridgeSshShortcut> { it.operationCount + (usage[it.id] ?: 0L) }
                    .thenByDescending { it.groupId == "favorites" }
                    .thenBy { it.sortOrder }.thenBy { it.title },
            ).take(8)
        }
        return enabled.filter { it.groupId == groupId }.sortedWith(compareBy<BridgeSshShortcut> { it.sortOrder }.thenBy { it.id })
    }

    companion object {
        fun fromJson(payload: JSONObject, sequences: Map<String, String>): BridgeSshShortcutCatalog {
            val groups = payload.optJSONArray("groups") ?: error("Missing shortcut groups")
            val shortcuts = payload.optJSONArray("shortcuts") ?: error("Missing shortcuts")
            return BridgeSshShortcutCatalog(
                groups = (0 until groups.length()).map { index ->
                    val group = groups.getJSONObject(index)
                    BridgeSshShortcutGroup(
                        id = group.getString("id"), title = group.optString("title", ""),
                        icon = group.optString("icon", ""), surface = group.optString("surface", "palette"),
                        layout = group.optString("layout", "grid"), sortOrder = group.optInt("sortOrder", index),
                        enabled = group.optBoolean("enabled", true),
                    )
                },
                shortcuts = (0 until shortcuts.length()).map { index ->
                    val shortcut = shortcuts.getJSONObject(index)
                    BridgeSshShortcut(
                        id = shortcut.getString("id"), groupId = shortcut.getString("groupId"),
                        title = shortcut.optString("title", ""), detail = shortcut.optString("detail", ""),
                        kind = shortcut.optString("kind", ""), value = shortcut.optString("value", ""),
                        actionKey = if (shortcut.isNull("actionKey")) null else shortcut.optString("actionKey").ifBlank { null },
                        displayMode = shortcut.optString("displayMode", "closed"), sortOrder = shortcut.optInt("sortOrder", index),
                        operationCount = shortcut.optLong("operationCount", 0L).coerceAtLeast(0L),
                        enabled = shortcut.optBoolean("enabled", true), dangerous = shortcut.optBoolean("dangerous", false),
                    )
                },
                terminalSequences = sequences,
            )
        }

        fun sequences(payload: JSONObject): Map<String, String> {
            val values = payload.getJSONObject("terminalSequences")
            return values.keys().asSequence().associateWith { values.getString(it) }
        }
    }
}
