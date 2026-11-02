package dev.feishu.codex.bridge

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import java.io.File
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

@Composable
internal fun BridgeSshRemoteFilesDialog(
    root: String,
    relative: String,
    files: List<BridgeSshRemoteFile>,
    busy: Boolean,
    error: String?,
    previewName: String?,
    previewText: String?,
    previewFile: File?,
    previewPdf: Boolean,
    onDismiss: () -> Unit,
    onDirectory: (String) -> Unit,
    onPreview: (BridgeSshRemoteFile) -> Unit,
    onDownload: (BridgeSshRemoteFile) -> Unit,
    onCopyPath: (BridgeSshRemoteFile) -> Unit,
    onForward: (BridgeSshRemoteFile) -> Unit,
    onUpload: () -> Unit,
    onClosePreview: () -> Unit,
    onCopyPreview: () -> Unit,
) {
    var search by remember(relative) { mutableStateOf("") }
    val visible = remember(files, search) { files.filter { it.name.contains(search.trim(), ignoreCase = true) } }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize().safeDrawingPadding()) {
                Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = 12.dp, end = 4.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    val scroll = rememberScrollState()
                    LaunchedEffect(relative, scroll.maxValue) { scroll.scrollTo(scroll.maxValue) }
                    Row(Modifier.weight(1f).horizontalScroll(scroll), verticalAlignment = Alignment.CenterVertically) {
                        BridgeSshDirectoryCrumb(root.ifBlank { "SSH 文件" }, enabled = !busy && relative.isNotEmpty()) { onDirectory("") }
                        var path = ""
                        relative.split('/').filter(String::isNotEmpty).forEach { part ->
                            path = if (path.isEmpty()) part else "$path/$part"
                            val target = path
                            Text(" / ", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
                            BridgeSshDirectoryCrumb(part, enabled = !busy && target != relative) { onDirectory(target) }
                        }
                    }
                    if (relative.isNotEmpty()) BridgeSshFileToolbarButton(BridgeSshFileToolbarIcon.Parent, "上级目录", !busy) {
                        onDirectory(relative.substringBeforeLast('/', ""))
                    }
                    BridgeSshFileToolbarButton(BridgeSshFileToolbarIcon.Refresh, "刷新目录", !busy) { onDirectory(relative) }
                    BridgeSshFileToolbarButton(BridgeSshFileToolbarIcon.Upload, "上传文件", !busy, onUpload)
                    BridgeSshFileToolbarButton(BridgeSshFileToolbarIcon.Return, "返回 Session", true, onDismiss)
                }
                HorizontalDivider()
                BridgeSshCompactSearch(search, { search = it }, "搜索当前目录", Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
                Box(Modifier.fillMaxWidth().height(3.dp)) {
                    if (busy) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp))
                }
                error?.let {
                    Text(it, modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                        color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
                LazyColumn(Modifier.weight(1f).fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 8.dp)
                    .border(1.dp, MaterialTheme.colorScheme.outline, MaterialTheme.shapes.small)) {
                    if (visible.isEmpty() && !busy) {
                        item {
                            Text(if (search.isBlank()) "此目录为空。" else "没有匹配的文件。",
                                modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                    itemsIndexed(visible, key = { _, file -> file.relativePath }) { index, file ->
                        BridgeSshRemoteFileRow(file, busy, onDirectory, onPreview, onDownload, onCopyPath, onForward)
                        if (index != visible.lastIndex) HorizontalDivider()
                    }
                }
            }
        }
    }
    if (previewName != null) Dialog(
        onDismissRequest = onClosePreview,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize().safeDrawingPadding()) {
                Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(previewName, modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleMedium,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    BridgeSshFileToolbarButton(BridgeSshFileToolbarIcon.Copy, "复制预览", !busy, onCopyPreview)
                    BridgeSshFileToolbarButton(BridgeSshFileToolbarIcon.Close, "关闭预览", true, onClosePreview)
                }
                HorizontalDivider()
                error?.let { Text(it, Modifier.padding(horizontal = 12.dp, vertical = 4.dp), color = MaterialTheme.colorScheme.error) }
                BridgeSshRemotePreview(previewFile, previewPdf, previewText, Modifier.weight(1f).padding(12.dp))
            }
        }
    }
}

@Composable
private fun BridgeSshDirectoryCrumb(label: String, enabled: Boolean, onClick: () -> Unit) {
    Text(label, modifier = Modifier.clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(vertical = 8.dp),
        color = if (enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
        style = MaterialTheme.typography.labelLarge, maxLines = 1)
}

private enum class BridgeSshFileToolbarIcon { Parent, Refresh, Upload, Return, Copy, Close }

@Composable
private fun BridgeSshFileToolbarButton(icon: BridgeSshFileToolbarIcon, label: String, enabled: Boolean, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = enabled,
        modifier = Modifier.size(40.dp).semantics { contentDescription = label }) {
        val color = LocalContentColor.current
        Canvas(Modifier.size(22.dp)) {
            val u = size.width / 24f
            val stroke = Stroke(width = 1.9f * u, cap = StrokeCap.Round, join = StrokeJoin.Round)
            val path = Path().apply {
                when (icon) {
                    BridgeSshFileToolbarIcon.Parent -> {
                        moveTo(12f*u, 20f*u); lineTo(12f*u, 4f*u)
                        moveTo(6f*u, 10f*u); lineTo(12f*u, 4f*u); lineTo(18f*u, 10f*u)
                    }
                    BridgeSshFileToolbarIcon.Refresh -> {
                        moveTo(19f*u, 5f*u); lineTo(19f*u, 10f*u); lineTo(14f*u, 10f*u)
                    }
                    BridgeSshFileToolbarIcon.Upload -> {
                        moveTo(12f*u, 16f*u); lineTo(12f*u, 4f*u)
                        moveTo(7f*u, 9f*u); lineTo(12f*u, 4f*u); lineTo(17f*u, 9f*u)
                        moveTo(5f*u, 16f*u); lineTo(5f*u, 20f*u); lineTo(19f*u, 20f*u); lineTo(19f*u, 16f*u)
                    }
                    BridgeSshFileToolbarIcon.Return -> {
                        moveTo(20f*u, 12f*u); lineTo(4f*u, 12f*u)
                        moveTo(10f*u, 6f*u); lineTo(4f*u, 12f*u); lineTo(10f*u, 18f*u)
                    }
                    BridgeSshFileToolbarIcon.Copy -> {
                        moveTo(8f*u, 7f*u); lineTo(19f*u, 7f*u); lineTo(19f*u, 21f*u); lineTo(8f*u, 21f*u); close()
                        moveTo(16f*u, 7f*u); lineTo(16f*u, 3f*u); lineTo(4f*u, 3f*u); lineTo(4f*u, 17f*u); lineTo(8f*u, 17f*u)
                    }
                    BridgeSshFileToolbarIcon.Close -> {
                        moveTo(5f*u, 5f*u); lineTo(19f*u, 19f*u)
                        moveTo(19f*u, 5f*u); lineTo(5f*u, 19f*u)
                    }
                }
            }
            if (icon == BridgeSshFileToolbarIcon.Refresh) drawArc(color, 40f, 285f, false,
                topLeft = Offset(4f*u, 4f*u), size = Size(16f*u, 16f*u), style = stroke)
            drawPath(path, color, style = stroke)
        }
    }
}

@Composable
private fun BridgeSshRemoteFileRow(
    file: BridgeSshRemoteFile,
    busy: Boolean,
    onDirectory: (String) -> Unit,
    onPreview: (BridgeSshRemoteFile) -> Unit,
    onDownload: (BridgeSshRemoteFile) -> Unit,
    onCopyPath: (BridgeSshRemoteFile) -> Unit,
    onForward: (BridgeSshRemoteFile) -> Unit,
) {
    var menuOpen by remember(file.relativePath) { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(enabled = !busy, role = Role.Button,
        onClickLabel = if (file.directory) "打开目录 ${file.name}" else "预览 ${file.name}") {
        if (file.directory) onDirectory(file.relativePath) else onPreview(file)
    }.padding(start = 10.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        BridgeSshFileIcon(file.directory)
        Text(file.name, modifier = Modifier.weight(1f).padding(start = 9.dp, end = 4.dp),
            style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        val date = remember(file.modifiedAtSeconds) { file.modifiedAtSeconds?.let(::bridgeSshFileDate) }
        if (date != null) Text(date, color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall, maxLines = 1)
        if (!file.directory) {
            IconButton(onClick = { onDownload(file) }, enabled = !busy,
                modifier = Modifier.size(40.dp).semantics { contentDescription = "下载 ${file.name}" }) {
                Text("↓", fontSize = 21.sp)
            }
            Box {
                IconButton(onClick = { menuOpen = true }, enabled = !busy,
                    modifier = Modifier.size(40.dp).semantics { contentDescription = "${file.name} 的更多操作" }) {
                    Text("⋮", fontSize = 21.sp)
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(text = { Text("复制路径") }, onClick = { menuOpen = false; onCopyPath(file) })
                    DropdownMenuItem(text = { Text("添加路径到输入框") }, onClick = { menuOpen = false; onForward(file) })
                }
            }
        }
    }
}

@Composable
private fun BridgeSshFileIcon(directory: Boolean) {
    val color = if (directory) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
    Canvas(Modifier.size(19.dp)) {
        val unit = size.width / 24f
        val path = Path().apply {
            if (directory) {
                moveTo(2f * unit, 5f * unit); lineTo(9f * unit, 5f * unit); lineTo(11f * unit, 8f * unit)
                lineTo(22f * unit, 8f * unit); lineTo(22f * unit, 19f * unit); lineTo(2f * unit, 19f * unit); close()
            } else {
                moveTo(5f * unit, 2f * unit); lineTo(14f * unit, 2f * unit); lineTo(19f * unit, 7f * unit)
                lineTo(19f * unit, 22f * unit); lineTo(5f * unit, 22f * unit); close()
                moveTo(14f * unit, 2f * unit); lineTo(14f * unit, 7f * unit); lineTo(19f * unit, 7f * unit)
            }
        }
        if (directory) drawPath(path, color) else drawPath(path, color, style = Stroke(width = 1.7f * unit))
    }
}

private fun bridgeSshFileDate(seconds: Long): String {
    val date = Date(seconds * 1_000L)
    val year = Calendar.getInstance().apply { time = date }.get(Calendar.YEAR)
    val pattern = if (year == Calendar.getInstance().get(Calendar.YEAR)) "M/d" else "yyyy/M/d"
    return SimpleDateFormat(pattern, Locale.getDefault()).format(date)
}
