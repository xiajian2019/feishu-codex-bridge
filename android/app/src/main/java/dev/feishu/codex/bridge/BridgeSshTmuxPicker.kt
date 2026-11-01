package dev.feishu.codex.bridge

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material3.OutlinedTextField
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
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 16.dp),
            shape = MaterialTheme.shapes.large,
            color = MaterialTheme.colorScheme.surface,
            tonalElevation = 3.dp,
        ) {
            var search by remember { mutableStateOf("") }
            val normalizedSearch = search.trim()
            val visibleSessions = sessions.orEmpty().filter { session ->
                normalizedSearch.isBlank() ||
                    session.name.contains(normalizedSearch, ignoreCase = true) ||
                    session.cwd.contains(normalizedSearch, ignoreCase = true) ||
                    session.id.contains(normalizedSearch, ignoreCase = true)
            }
            Column(modifier = Modifier.heightIn(max = 680.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "tmux 会话",
                        modifier = Modifier.weight(1f),
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    TextButton(onClick = onRefresh, enabled = canRefresh && !refreshing) {
                        Text("刷新")
                    }
                    TextButton(onClick = onDismiss) { Text("关闭") }
                }
                Text(
                    "当前 SSH 主机 · $target",
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 10.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                OutlinedTextField(
                    value = search,
                    onValueChange = { search = it },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    singleLine = true,
                    label = { Text("筛选 Session") },
                    placeholder = { Text("按名称、目录或 ID 搜索") },
                )
                HorizontalDivider()

                LazyColumn(modifier = Modifier.weight(1f, fill = false)) {
                    if (refreshing) {
                        item {
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                                Text("正在刷新会话…", style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                    if (!message.isNullOrBlank()) {
                        item {
                            Text(
                                message,
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                                style = MaterialTheme.typography.bodySmall,
                                color = if (errorDetails != null) MaterialTheme.colorScheme.error
                                    else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    if (errorDetails != null) {
                        item { BridgeSshTmuxErrorDetails(errorDetails, onCopyError) }
                    }
                    when {
                        sessions == null && !refreshing && errorDetails == null -> item {
                            Text(
                                "尚未读取会话，请刷新。",
                                modifier = Modifier.padding(16.dp),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                        sessions != null && sessions.isEmpty() && !refreshing && errorDetails == null -> item {
                            Text(
                                "没有发现 tmux 会话。可以在 Composer 执行 tmux new -s <name>。",
                                modifier = Modifier.padding(16.dp),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                        sessions != null && sessions.isNotEmpty() && visibleSessions.isEmpty() && !refreshing -> item {
                            Text(
                                "没有匹配的 tmux 会话。",
                                modifier = Modifier.padding(16.dp),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                        sessions != null && sessions.isNotEmpty() -> {
                            if (errorDetails != null) {
                                item {
                                    Text(
                                        "显示上次成功读取的会话。",
                                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                            itemsIndexed(visibleSessions, key = { _, session -> session.id }) { index, session ->
                                BridgeSshTmuxSessionRow(session = session, onSelect = { onSelect(session) })
                                if (index != visibleSessions.lastIndex) {
                                    HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                                }
                            }
                        }
                        else -> Unit
                    }
                }
            }
        }
    }
}

@Composable
private fun BridgeSshTmuxSessionRow(
    session: BridgeSshTmuxSession,
    onSelect: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .clickable(onClickLabel = "进入会话 ${session.name}", role = Role.Button, onClick = onSelect)
            .padding(horizontal = 16.dp, vertical = 9.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                session.name,
                modifier = Modifier.weight(1f).padding(end = 8.dp),
                style = MaterialTheme.typography.titleSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                "${session.windows} 个窗口 · ${if (session.attached) "已附加" else "未附加"}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text(
            "${session.id} · ${session.cwd.ifBlank { "（未提供目录）" }}",
            modifier = Modifier.fillMaxWidth().padding(top = 3.dp),
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
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
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 160.dp)
                        .verticalScroll(rememberScrollState())
                        .padding(10.dp),
                ) {
                    Text(
                        details,
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        color = MaterialTheme.colorScheme.onErrorContainer,
                    )
                }
            }
        }
    }
}
