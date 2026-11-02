package dev.feishu.codex.bridge

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun BridgeSshTerminalHeader(
    title: String,
    connected: Boolean,
    reconnecting: Boolean,
    busy: Boolean,
    onReturnToWorkbench: () -> Unit,
    onHosts: () -> Unit,
    onTmux: () -> Unit,
    onReconnect: () -> Unit,
    onDisconnect: () -> Unit,
    hasTmuxSession: Boolean = false,
    accountLabel: String? = null,
    usageSummary: String = "-·-",
    onGitChanges: () -> Unit = {},
    onAccounts: () -> Unit = {},
    onUsage: () -> Unit = {},
    onSaveSnapshot: () -> Unit = {},
    onSuspend: () -> Unit = {},
    onEnd: () -> Unit = {},
) {
    var menuOpen by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text(title, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (connected) {
            BridgeSshHeaderAction(onClick = onTmux, enabled = !busy,
                modifier = Modifier.width(48.dp).semantics { contentDescription = "tmux 会话" }) {
                val color = MaterialTheme.colorScheme.primary.copy(alpha = if (busy) .38f else 1f)
                Canvas(Modifier.size(24.dp)) {
                    val unit = size.width / 24f
                    drawRoundRect(color, topLeft = Offset(3f * unit, 4f * unit),
                        size = Size(18f * unit, 16f * unit), cornerRadius = CornerRadius(2f * unit),
                        style = Stroke(width = 1.8f * unit))
                    drawLine(color, Offset(12f * unit, 4f * unit), Offset(12f * unit, 20f * unit), 1.8f * unit)
                    drawLine(color, Offset(12f * unit, 12f * unit), Offset(21f * unit, 12f * unit), 1.8f * unit)
                }
            }
        } else {
            BridgeSshHeaderAction(onClick = onReconnect) {
                Text(if (reconnecting) "重连中" else "重连", modifier = Modifier.padding(horizontal = 4.dp), maxLines = 1,
                    color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelLarge)
            }
        }
        if (connected && hasTmuxSession) {
            val usageEnabled = !busy && accountLabel != null
            BridgeSshHeaderAction(onClick = onUsage, enabled = usageEnabled, modifier = Modifier.widthIn(max = 88.dp)) {
                Column(
                    modifier = Modifier.padding(horizontal = 4.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text(accountLabel ?: "账号", maxLines = 1, fontSize = 13.sp, lineHeight = 16.sp,
                        color = if (usageEnabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface.copy(alpha = .38f),
                        fontWeight = FontWeight.Medium, overflow = TextOverflow.Ellipsis)
                    Text(usageSummary, maxLines = 1, fontSize = 8.sp, lineHeight = 10.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        BridgeSshHeaderAction(onClick = onReturnToWorkbench, enabled = !busy,
            modifier = Modifier.width(48.dp).semantics { contentDescription = "返回工作台" }) {
            val color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (busy) .38f else 1f)
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
            BridgeSshHeaderAction(onClick = { menuOpen = true },
                modifier = Modifier.width(48.dp).semantics { contentDescription = "更多操作" }) {
                val color = MaterialTheme.colorScheme.onSurface
                Canvas(Modifier.size(24.dp)) {
                    val unit = size.width / 24f
                    listOf(7f, 12f, 17f).forEach { y ->
                        drawCircle(color, radius = 1.6f * unit, center = Offset(12f * unit, y * unit))
                    }
                }
            }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                if (connected && hasTmuxSession) {
                    DropdownMenuItem(text = { Text("查看 Git 变更") }, enabled = !busy,
                        onClick = { menuOpen = false; onGitChanges() })
                    DropdownMenuItem(text = { Text("标记 Codex 账号") }, enabled = !busy,
                        onClick = { menuOpen = false; onAccounts() })
                    DropdownMenuItem(text = { Text("查看 Codex 用量") }, enabled = !busy && accountLabel != null,
                        onClick = { menuOpen = false; onUsage() })
                    DropdownMenuItem(text = { Text("保存快照") }, enabled = !busy,
                        onClick = { menuOpen = false; onSaveSnapshot() })
                    DropdownMenuItem(text = { Text("挂起 Session") }, enabled = !busy,
                        onClick = { menuOpen = false; onSuspend() })
                    DropdownMenuItem(text = { Text("终结 Session") }, enabled = !busy,
                        onClick = { menuOpen = false; onEnd() })
                }
                DropdownMenuItem(text = { Text("主机") }, enabled = !busy,
                    onClick = { menuOpen = false; onHosts() })
                DropdownMenuItem(text = { Text("断开") },
                    onClick = { menuOpen = false; onDisconnect() })
            }
        }
    }
}

@Composable
private fun BridgeSshHeaderAction(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable BoxScope.() -> Unit,
) {
    Box(
        modifier = modifier.height(48.dp).widthIn(min = 48.dp)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            // Each background stays inside its own touch target, leaving an 8 dp visual gap.
            .padding(4.dp)
            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(6.dp)),
        contentAlignment = Alignment.Center,
        content = content,
    )
}
