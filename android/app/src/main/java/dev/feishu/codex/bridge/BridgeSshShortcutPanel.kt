package dev.feishu.codex.bridge

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Draws the same configured toolbar in the native page and UI fixture. */
@Composable
internal fun BridgeSshComposerToolbar(
    catalog: BridgeSshShortcutCatalog?,
    expanded: Boolean,
    category: String,
    enabled: Boolean,
    diagnosticsRecording: Boolean,
    onShortcut: (BridgeSshShortcut) -> Unit,
    onKeyboardFallback: () -> Unit,
) {
    val toolbar = catalog?.toolbar(expanded).orEmpty().filter { it.actionKey != "attachment" }
    val fallback = toolbar.none { it.actionKey == "keyboard-panel" }
    val entries = toolbar + if (fallback) listOf(BridgeSshShortcut(
        id = "native-keyboard-fallback", groupId = "composer", title = "键盘", detail = "快捷键面板",
        kind = "insert", value = "", actionKey = "keyboard-panel", displayMode = "both", sortOrder = Int.MAX_VALUE,
        operationCount = 0, enabled = true, dangerous = false,
    )) else emptyList()
    fun allowed(shortcut: BridgeSshShortcut): Boolean = enabled || shortcut.actionKey in setOf("close-panel", "debug-log", "scroll-export")
    fun activate(shortcut: BridgeSshShortcut) {
        if (shortcut.id == "native-keyboard-fallback") onKeyboardFallback() else onShortcut(shortcut)
    }
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
    entries.forEach { shortcut ->
        val action = shortcut.actionKey
        val panel = when (action) { "keyboard-panel" -> "keyboard"; "codex-panel" -> "codex-tui"; "ctrl-panel" -> "ctrl"; else -> null }
        val label = when (action) {
            "skill-picker" -> "$"; "scroll-top" -> "⤒"; "scroll-bottom" -> "⤓"; "session-files" -> "▱"
            "debug-log" -> if (diagnosticsRecording) "■" else "●"; "scroll-export" -> "⇩"
            "keyboard-panel" -> "⌨"; "close-panel" -> "×"; "terminal-enter" -> "↵"
            "terminal-up" -> "↑"; "terminal-down" -> "↓"; "ctrl-panel" -> "⌃"; else -> shortcut.title
        }
        BridgeSshComposerShortcut(
            label = label, description = if (action == "debug-log") {
                if (diagnosticsRecording) "停止并复制调试日志" else "开始记录调试日志"
            } else shortcut.detail.ifBlank { shortcut.title }, icon = action,
            active = expanded && panel == category,
            enabled = allowed(shortcut),
            onClick = { activate(shortcut) },
        )
    }
    }
}

/** Compact native equivalent of the Web shortcut categories and paged keyboard. */
@Composable
internal fun BridgeSshShortcutPanel(
    catalog: BridgeSshShortcutCatalog,
    category: String,
    usage: Map<String, Long>,
    enabled: Boolean,
    onCategory: (String) -> Unit,
    onDismiss: () -> Unit,
    onSelect: (BridgeSshShortcut) -> Unit,
    modifier: Modifier = Modifier,
) {
    val groups = catalog.paletteGroups()
    val selected = groups.firstOrNull { it.id == category } ?: groups.firstOrNull()
    val cards = selected?.let { catalog.paletteItems(it.id, usage) }.orEmpty()
    val columns = if (selected?.layout == "keyboard") 5 else 4
    val pageSize = if (selected?.layout == "keyboard") 20 else 8
    val totalPages = maxOf(1, (cards.size + pageSize - 1) / pageSize)
    var page by remember(selected?.id, cards.size) { mutableIntStateOf(0) }
    val currentPage = page.coerceIn(0, totalPages - 1)
    val shape = RoundedCornerShape(18.dp)
    Column(
        modifier = modifier.fillMaxWidth().heightIn(max = 340.dp).clip(shape)
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .border(1.dp, MaterialTheme.colorScheme.outline, shape)
            .verticalScroll(rememberScrollState())
            .padding(6.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                groups.forEach { group ->
                    BridgeSshComposerShortcut(
                        label = group.icon.ifBlank { group.title.take(3) },
                        description = group.title,
                        active = selected?.id == group.id,
                        onClick = { onCategory(group.id) },
                    )
                }
            }
            BridgeSshComposerShortcut("×", onDismiss, description = "关闭快捷键")
        }
        Column(Modifier.padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            repeat(pageSize / columns) { row ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    repeat(columns) { column ->
                        val index = currentPage * pageSize + row * columns + column
                        val shortcut = cards.getOrNull(index)
                        Box(
                            modifier = Modifier.weight(1f).height(if (selected?.layout == "keyboard") 38.dp else 52.dp)
                                .clip(RoundedCornerShape(9.dp))
                                .background(MaterialTheme.colorScheme.surface)
                                .semantics(mergeDescendants = true) {
                                    contentDescription = shortcut?.let { "${it.title} ${it.detail}" } ?: "空快捷键"
                                    role = Role.Button
                                }
                                .clickable(enabled = enabled && shortcut != null) { shortcut?.let(onSelect) }
                                .padding(horizontal = 3.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            if (shortcut != null) Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Text(shortcut.title, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    color = if (!enabled) MaterialTheme.colorScheme.onSurface.copy(alpha = .38f)
                                        else if (shortcut.dangerous) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                                    fontSize = if (selected?.layout == "keyboard" && shortcut.title.length > 7) 10.sp
                                        else if (selected?.layout == "keyboard") 14.sp else 13.sp)
                                if (selected?.layout != "keyboard" && shortcut.detail.isNotBlank()) {
                                    Text(shortcut.detail, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 10.sp)
                                }
                            }
                        }
                    }
                }
            }
        }
        if (totalPages > 1) {
            Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                BridgeSshComposerShortcut("‹", { page = currentPage - 1 }, enabled = currentPage > 0, description = "上一页快捷键")
                Text("${currentPage + 1} / $totalPages", Modifier.padding(horizontal = 10.dp), fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                BridgeSshComposerShortcut("›", { page = currentPage + 1 }, enabled = currentPage + 1 < totalPages, description = "下一页快捷键")
            }
        }
    }
}
