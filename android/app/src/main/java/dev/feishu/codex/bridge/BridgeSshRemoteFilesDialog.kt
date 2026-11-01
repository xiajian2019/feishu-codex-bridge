package dev.feishu.codex.bridge

import androidx.compose.foundation.clickable
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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.io.File

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
    val visible = files.filter { it.name.contains(search, ignoreCase = true) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("SSH 文件") },
        text = {
            Column {
                Text(root.trimEnd('/') + if (relative.isEmpty()) "" else "/$relative",
                    maxLines = 2, overflow = TextOverflow.Ellipsis, fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    if (relative.isNotEmpty()) TextButton(onClick = { onDirectory(relative.substringBeforeLast('/', "")) }, enabled = !busy) { Text("上级") }
                    TextButton(onClick = { onDirectory(relative) }, enabled = !busy) { Text("刷新") }
                    TextButton(onClick = onUpload, enabled = !busy) { Text("上传") }
                }
                OutlinedTextField(value = search, onValueChange = { search = it }, modifier = Modifier.fillMaxWidth(),
                    textStyle = TextStyle(fontSize = 16.sp), singleLine = true, label = { Text("搜索文件名") })
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp)) }
                if (busy) Text("正在读取…", Modifier.padding(top = 8.dp))
                LazyColumn(Modifier.heightIn(max = 330.dp).padding(top = 4.dp)) {
                    items(visible, key = { it.relativePath }) { file ->
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text((if (file.directory) "▸ " else "  ") + file.name,
                                modifier = Modifier.weight(1f).clickable(enabled = !busy) {
                                    if (file.directory) onDirectory(file.relativePath) else onPreview(file)
                                }.padding(vertical = 12.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (!file.directory) TextButton(onClick = { onDownload(file) }, enabled = !busy) { Text("↓") }
                            if (!file.directory) TextButton(onClick = { onCopyPath(file) }, enabled = !busy) { Text("⧉") }
                            if (!file.directory) TextButton(onClick = { onForward(file) }, enabled = !busy) { Text("↗") }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
    )
    if (previewName != null) AlertDialog(
        onDismissRequest = onClosePreview,
        title = { Text(previewName, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        text = { BridgeSshRemotePreview(previewFile, previewPdf, previewText) },
        confirmButton = { TextButton(onClick = onClosePreview) { Text("关闭") } },
        dismissButton = { TextButton(onClick = onCopyPreview, enabled = !busy) { Text("复制") } },
    )
}
