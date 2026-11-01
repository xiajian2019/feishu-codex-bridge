package dev.feishu.codex.bridge

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
internal fun BridgeSshTerminalHeader(
    title: String,
    connected: Boolean,
    busy: Boolean,
    onReturnToWorkbench: () -> Unit,
    onHosts: () -> Unit,
    onTmux: () -> Unit,
    onReconnect: () -> Unit,
    onDisconnect: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text(title, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        TextButton(
            onClick = if (connected) onTmux else onReconnect,
            enabled = !connected || !busy,
            modifier = Modifier.height(40.dp).widthIn(min = 48.dp),
            contentPadding = PaddingValues(horizontal = 4.dp),
        ) {
            Text(if (connected) "tmux" else "重连", maxLines = 1)
        }
        IconButton(onClick = onReturnToWorkbench, enabled = !busy,
            modifier = Modifier.size(40.dp).semantics { contentDescription = "返回工作台" }) {
            val color = LocalContentColor.current
            Canvas(Modifier.size(24.dp)) {
                val unit = size.width / 24f
                val arrow = Path().apply {
                    moveTo(20f * unit, 5f * unit)
                    lineTo(20f * unit, 8f * unit)
                    cubicTo(20f * unit, 11f * unit, 18f * unit, 13f * unit, 15f * unit, 13f * unit)
                    lineTo(4f * unit, 13f * unit)
                    moveTo(8f * unit, 9f * unit)
                    lineTo(4f * unit, 13f * unit)
                    lineTo(8f * unit, 17f * unit)
                }
                drawPath(arrow, color, style = Stroke(width = 2f * unit, cap = StrokeCap.Round, join = StrokeJoin.Round))
            }
        }
        Box {
            IconButton(onClick = { menuOpen = true },
                modifier = Modifier.size(40.dp).semantics { contentDescription = "更多操作" }) {
                val color = LocalContentColor.current
                Canvas(Modifier.size(24.dp)) {
                    val unit = size.width / 24f
                    listOf(7f, 12f, 17f).forEach { y ->
                        drawCircle(color, radius = 1.6f * unit, center = Offset(12f * unit, y * unit))
                    }
                }
            }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(text = { Text("主机") }, enabled = !busy,
                    onClick = { menuOpen = false; onHosts() })
                DropdownMenuItem(text = { Text("断开") },
                    onClick = { menuOpen = false; onDisconnect() })
            }
        }
    }
}
