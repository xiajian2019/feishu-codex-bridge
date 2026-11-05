package dev.feishu.codex.bridge

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import java.text.DateFormat
import java.util.Date
import org.json.JSONObject

internal data class BridgeSshGitFile(val path: String, val status: String, val size: Long?)
internal data class BridgeSshGitState(val root: String, val branch: String, val files: List<BridgeSshGitFile>)
internal data class BridgeSshCodexHome(val id: String, val path: String, val label: String)
internal data class BridgeSshSuspendedSession(
    val id: String, val createdAt: Long, val name: String, val cwd: String,
    val source: String = "", val uncertain: Boolean = false,
)

internal data class BridgeSshDiffLine(val text: String, val oldLine: Int?, val newLine: Int?)

internal fun parseBridgeSshDiff(text: String, preview: Boolean): List<BridgeSshDiffLine> {
    if (preview) return text.split('\n').mapIndexed { index, line -> BridgeSshDiffLine(line, null, index + 1) }
    val hunk = Regex("""^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@""")
    var oldNumber = 0
    var newNumber = 0
    var inHunk = false
    return text.split('\n').map { line ->
        val header = hunk.find(line)
        if (header != null) {
            oldNumber = header.groupValues[1].toInt()
            newNumber = header.groupValues[2].toInt()
            inHunk = true
            BridgeSshDiffLine(line, null, null)
        } else if (!inHunk || line.startsWith("diff --git ") || line.startsWith("\\")) {
            if (line.startsWith("diff --git ")) inHunk = false
            BridgeSshDiffLine(line, null, null)
        } else when (line.firstOrNull()) {
            ' ' -> BridgeSshDiffLine(line, oldNumber++, newNumber++)
            '-' -> BridgeSshDiffLine(line, oldNumber++, null)
            '+' -> BridgeSshDiffLine(line, null, newNumber++)
            else -> BridgeSshDiffLine(line, null, null)
        }
    }
}

@Composable
internal fun BridgeSshGitChangesDialog(
    sessionName: String,
    data: BridgeSshGitState?,
    busy: Boolean,
    error: String?,
    selected: BridgeSshGitFile?,
    detail: String?,
    preview: Boolean,
    truncated: Boolean,
    onDismiss: () -> Unit,
    onRefresh: () -> Unit,
    onSelect: (BridgeSshGitFile, Boolean) -> Unit,
    onDownload: (BridgeSshGitFile) -> Unit,
) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth().padding(6.dp).heightIn(max = 760.dp), shape = MaterialTheme.shapes.medium) {
            var query by remember { mutableStateOf("") }
            var listVisible by remember { mutableStateOf(true) }
            LaunchedEffect(selected) { if (selected == null) listVisible = true }
            Column(Modifier.fillMaxWidth().padding(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Git 变更 · $sessionName", style = MaterialTheme.typography.titleMedium, maxLines = 1)
                        data?.let { Text(it.branch.ifBlank { "分离的 HEAD" }, style = MaterialTheme.typography.bodySmall) }
                    }
                    TextButton(onClick = onRefresh, enabled = !busy) { Text("刷新") }
                    TextButton(onClick = onDismiss) { Text("返回") }
                }
                data?.let {
                    val added = it.files.count { file -> gitStatusLabel(file.status) == "新增" }
                    val deleted = it.files.count { file -> gitStatusLabel(file.status) == "删除" }
                    val modified = it.files.size - added - deleted
                    Text("${it.files.size} 个文件 · 新增 $added · 修改 $modified · 删除 $deleted",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(it.root, style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        TextButton(onClick = { listVisible = true }) { Text("文件 ${it.files.size}") }
                        TextButton(onClick = { listVisible = false }, enabled = selected != null) { Text("Diff") }
                    }
                }
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (!error.isNullOrBlank()) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                if (listVisible) {
                    BridgeSshCompactSearch(query, { query = it }, "搜索文件名或路径")
                    val files = data?.files.orEmpty().filter { it.path.contains(query.trim(), ignoreCase = true) }
                    if (data != null && files.isEmpty()) Text("没有匹配的变更文件。", modifier = Modifier.padding(12.dp))
                    LazyColumn(Modifier.weight(1f, fill = false)) {
                        items(files, key = { it.path }) { file ->
                            Column(Modifier.fillMaxWidth().clickable(enabled = !busy) {
                                listVisible = false; onSelect(file, false)
                            }.padding(vertical = 9.dp, horizontal = 6.dp)) {
                                Text(gitStatusLabel(file.status), color = MaterialTheme.colorScheme.primary,
                                    style = MaterialTheme.typography.labelMedium)
                                Text(file.path, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                                    maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Text("${if (file.status == "??") "未跟踪" else "工作区 / 暂存区"}${file.size?.let { " · $it B" } ?: ""}",
                                    color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                            }
                            HorizontalDivider()
                        }
                    }
                } else {
                    selected?.let { file ->
                        Column(Modifier.weight(1f, fill = false)) {
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                Text(file.path, Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis,
                                    style = MaterialTheme.typography.titleSmall)
                                TextButton(onClick = { onSelect(file, false) }, enabled = !busy) { Text("变更") }
                                TextButton(onClick = { onSelect(file, true) }, enabled = !busy) { Text("预览") }
                                TextButton(onClick = { onDownload(file) }, enabled = !busy && file.size != null) { Text("下载") }
                            }
                            if (truncated) Text("内容较长，仅显示前 512 KiB。", style = MaterialTheme.typography.bodySmall)
                            val text = detail ?: if (busy) "正在读取…" else "没有可显示的内容。"
                            val lines = remember(text, preview) { parseBridgeSshDiff(text, preview) }
                            LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = false)
                                .horizontalScroll(rememberScrollState()).background(MaterialTheme.colorScheme.surfaceContainerLow)
                                .padding(8.dp)) {
                                items(lines.size) { index ->
                                    val entry = lines[index]
                                    val line = entry.text
                                    val color = when {
                                        preview -> MaterialTheme.colorScheme.onSurface
                                        line.startsWith("+") && !line.startsWith("+++") -> MaterialTheme.colorScheme.primary
                                        line.startsWith("-") && !line.startsWith("---") -> MaterialTheme.colorScheme.error
                                        else -> MaterialTheme.colorScheme.onSurface
                                    }
                                    Row {
                                        val numbers = "${entry.oldLine?.toString()?.padStart(4) ?: "    "} ${entry.newLine?.toString()?.padStart(4) ?: "    "} "
                                        Text(numbers, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), softWrap = false)
                                        Text(line.ifEmpty { " " }, color = color,
                                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), softWrap = false)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun gitStatusLabel(status: String): String = when {
    status == "??" -> "新增"
    'D' in status -> "删除"
    'R' in status -> "重命名"
    'A' in status -> "新增"
    else -> "修改"
}

@Composable
internal fun BridgeSshCodexHomesDialog(
    homes: List<BridgeSshCodexHome>, selected: String, busy: Boolean, error: String?,
    onSelect: (BridgeSshCodexHome) -> Unit, onRefreshRunning: () -> Unit, onDismiss: () -> Unit,
) {
    AlertDialog(onDismissRequest = onDismiss, title = { Text("标记 Codex 账号") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text("账号标记与 Web 共用，用于查看用量并由新建窗口或窗格继承；不会更改现有 shell 或运行中的 Codex。",
                    style = MaterialTheme.typography.bodySmall)
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(vertical = 8.dp))
                if (!error.isNullOrBlank()) Text(error, color = MaterialTheme.colorScheme.error)
                homes.forEach { home ->
                    Column(Modifier.fillMaxWidth().clickable(enabled = !busy) { onSelect(home) }.padding(vertical = 9.dp)) {
                        Text(home.label + if (home.id == selected) " · 已标记" else "")
                        if (home.path.isNotBlank()) Text(home.path, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    HorizontalDivider()
                }
            }
        },
        confirmButton = { TextButton(onClick = onRefreshRunning, enabled = !busy) { Text("检测当前 Codex") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("关闭") } })
}

@Composable
internal fun BridgeSshCodexUsageDialog(
    label: String, result: JSONObject?, busy: Boolean, error: String?, onRefresh: () -> Unit, onDismiss: () -> Unit,
) {
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Codex 用量 · $label") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (!error.isNullOrBlank()) Text(error, color = MaterialTheme.colorScheme.error)
            result?.let { response ->
                val byId = response.optJSONObject("rateLimitsByLimitId")
                val snapshots = mutableListOf<Pair<String, JSONObject>>()
                if (byId != null) {
                    val keys = byId.keys()
                    while (keys.hasNext()) {
                        val key = keys.next()
                        byId.optJSONObject(key)?.let { snapshots.add(key to it) }
                    }
                }
                if (snapshots.isEmpty()) response.optJSONObject("rateLimits")?.let { snapshots.add("codex" to it) }
                if (snapshots.isEmpty()) Text("Codex 未返回额度数据。")
                snapshots.forEach { (key, snapshot) ->
                    Text(snapshot.optString("limitName").ifBlank { key } +
                        snapshot.optString("planType").takeIf { it.isNotBlank() && it != "null" }?.let { " · $it" }.orEmpty(),
                        style = MaterialTheme.typography.titleSmall)
                    snapshot.optJSONObject("primary")?.let { UsageWindow("主窗口", it) }
                    snapshot.optJSONObject("secondary")?.let { UsageWindow("次窗口", it) }
                    snapshot.optJSONObject("credits")?.optString("balance")?.takeIf { it.isNotBlank() && it != "null" }
                        ?.let { Text("余额 $it", style = MaterialTheme.typography.bodySmall) }
                    HorizontalDivider()
                }
            }
        }
    }, confirmButton = { TextButton(onClick = onRefresh, enabled = !busy) { Text("刷新") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("关闭") } })
}

@Composable
private fun UsageWindow(label: String, window: JSONObject) {
    val used = window.optDouble("usedPercent", Double.NaN)
    val duration = window.optLong("windowDurationMins", -1)
    val durationText = when {
        duration <= 0 -> ""
        duration % 1440L == 0L -> " · ${duration / 1440} 天"
        duration % 60L == 0L -> " · ${duration / 60} 小时"
        else -> " · $duration 分钟"
    }
    Text(label + durationText, style = MaterialTheme.typography.titleSmall)
    if (used.isFinite()) {
        val normalized = used.coerceIn(0.0, 100.0)
        Text("已用 ${normalized.toInt()}% · 剩余 ${(100 - normalized).toInt()}%", style = MaterialTheme.typography.bodySmall)
        LinearProgressIndicator(progress = { (normalized / 100).toFloat() }, modifier = Modifier.fillMaxWidth())
    } else Text("额度未知", style = MaterialTheme.typography.bodySmall)
    val reset = window.optLong("resetsAt", 0)
    if (reset > 0) Text("重置于 ${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(reset * 1000))}",
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
