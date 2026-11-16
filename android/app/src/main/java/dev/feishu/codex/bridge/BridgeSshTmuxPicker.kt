package dev.feishu.codex.bridge

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

/** Displays sessions from the currently connected SSH host. */
@Composable
internal fun BridgeSshTmuxPicker(
    target: String,
    sessions: List<BridgeSshTmuxSession>?,
    refreshing: Boolean,
    canRefresh: Boolean,
    message: String?,
    errorDetails: String?,
    onRefresh: () -> Unit,
    onDismiss: () -> Unit,
    onSelect: (BridgeSshTmuxSession) -> Unit,
    onCopyError: (String) -> Unit,
    suspendedSessions: List<BridgeSshSuspendedSession> = emptyList(),
    suspendedError: String? = null,
    onRestore: (BridgeSshSuspendedSession) -> Unit = {},
) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        BoxWithConstraints(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
            val dialogMaxHeight = maxHeight * 0.9f
            Surface(
                modifier = Modifier.fillMaxWidth().heightIn(max = dialogMaxHeight),
                shape = MaterialTheme.shapes.medium,
                color = MaterialTheme.colorScheme.surface,
                tonalElevation = 3.dp,
            ) {
                var search by remember { mutableStateOf("") }
                val normalizedSearch = search.trim()
                val visibleSessions = remember(sessions, normalizedSearch) {
                    sessions.orEmpty().filter { session ->
                        normalizedSearch.isBlank() ||
                            session.name.contains(normalizedSearch, ignoreCase = true) ||
                            session.cwd.contains(normalizedSearch, ignoreCase = true) ||
                            session.id.contains(normalizedSearch, ignoreCase = true)
                    }
                }
                Column {
                    Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("tmux 会话", style = MaterialTheme.typography.titleMedium, maxLines = 1)
                            Text(target, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        TextButton(onClick = onRefresh, enabled = canRefresh && !refreshing,
                            contentPadding = PaddingValues(horizontal = 8.dp)) { Text("刷新") }
                        TextButton(onClick = onDismiss, contentPadding = PaddingValues(horizontal = 8.dp)) { Text("关闭") }
                    }
                    BridgeSshCompactSearch(search, { search = it }, "按名称、目录或 ID 筛选",
                        Modifier.padding(start = 12.dp, end = 12.dp, bottom = 8.dp))
                    HorizontalDivider()
                    LazyColumn(modifier = Modifier.weight(1f, fill = false)) {
                        if (suspendedError != null) item {
                            Text(suspendedError, Modifier.padding(12.dp), color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodySmall)
                        }
                        val visibleSuspended = suspendedSessions.filter {
                            normalizedSearch.isBlank() || it.name.contains(normalizedSearch, true) || it.cwd.contains(normalizedSearch, true)
                        }
                        if (visibleSuspended.isNotEmpty()) {
                            item { Text("已挂起", Modifier.padding(start = 12.dp, top = 8.dp), style = MaterialTheme.typography.titleSmall) }
                            itemsIndexed(visibleSuspended, key = { _, item -> "suspended:${item.id}:${item.createdAt}:${item.source}" }) { _, item ->
                                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Column(Modifier.weight(1f)) {
                                        Text(item.name + if (item.source == "ssh-fallback") " · SSH 降级快照" else "", style = MaterialTheme.typography.titleSmall)
                                        Text(item.cwd, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        if (item.uncertain) Text("恢复结果未知，请先检查 tmux。", color = MaterialTheme.colorScheme.error,
                                            style = MaterialTheme.typography.bodySmall)
                                    }
                                    TextButton(onClick = { onRestore(item) }, enabled = !refreshing && !item.uncertain) { Text("恢复") }
                                }
                                HorizontalDivider()
                            }
                        }
                        if (refreshing) {
                            item {
                                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                                    Text("正在刷新会话…", style = MaterialTheme.typography.bodySmall)
                                }
                            }
                        }
                        if (!message.isNullOrBlank()) {
                            item {
                                Text(message, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = if (errorDetails != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        if (errorDetails != null) item { BridgeSshTmuxErrorDetails(errorDetails, onCopyError) }
                        when {
                            sessions == null && !refreshing && errorDetails == null -> item {
                                Text("尚未读取会话，请刷新。", modifier = Modifier.padding(12.dp), style = MaterialTheme.typography.bodyMedium)
                            }
                            sessions != null && sessions.isEmpty() && !refreshing && errorDetails == null -> item {
                                Text("没有发现 tmux 会话。可以在 Composer 执行 tmux new -s <name>。",
                                    modifier = Modifier.padding(12.dp), style = MaterialTheme.typography.bodyMedium)
                            }
                            sessions != null && sessions.isNotEmpty() && visibleSessions.isEmpty() && !refreshing -> item {
                                Text("没有匹配的 tmux 会话。", modifier = Modifier.padding(12.dp), style = MaterialTheme.typography.bodyMedium)
                            }
                            sessions != null && sessions.isNotEmpty() -> {
                                if (errorDetails != null) item {
                                    Text("显示上次成功读取的会话。", modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                itemsIndexed(visibleSessions, key = { _, session -> session.id }) { index, session ->
                                    BridgeSshTmuxSessionRow(session = session, onSelect = { onSelect(session) })
                                    if (index != visibleSessions.lastIndex) HorizontalDivider()
                                }
                            }
                            else -> Unit
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun BridgeSshTmuxSessionRow(session: BridgeSshTmuxSession, onSelect: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)
            .clickable(onClickLabel = "进入会话 ${session.name}", role = Role.Button, onClick = onSelect)
            .padding(horizontal = 12.dp, vertical = 5.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(session.name, modifier = Modifier.weight(1f).padding(end = 6.dp), style = MaterialTheme.typography.titleSmall,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("${session.windows} 窗 · ${if (session.attached) "已附加" else "未附加"}",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text("${session.id} · ${session.cwd.ifBlank { "（未提供目录）" }}", modifier = Modifier.fillMaxWidth(),
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun BridgeSshTmuxErrorDetails(details: String, onCopyError: (String) -> Unit) {
    var expanded by remember(details) { mutableStateOf(false) }
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { expanded = !expanded }) {
                Text(if (expanded) "收起诊断" else "查看诊断")
            }
            TextButton(onClick = { onCopyError(details) }) { Text("复制诊断") }
        }
        if (expanded) {
            Surface(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                shape = MaterialTheme.shapes.small,
                color = MaterialTheme.colorScheme.errorContainer,
            ) {
                Box(
                    modifier = Modifier.fillMaxWidth().heightIn(max = 160.dp)
                        .verticalScroll(rememberScrollState()).padding(10.dp),
                ) {
                    Text(details, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        color = MaterialTheme.colorScheme.onErrorContainer)
                }
            }
        }
    }
}
