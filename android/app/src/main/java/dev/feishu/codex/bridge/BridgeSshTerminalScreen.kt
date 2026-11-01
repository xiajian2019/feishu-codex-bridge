package dev.feishu.codex.bridge

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Small native screen shell for a termlib session.
 *
 * This is a composable, not an Activity. A future Capacitor native page can
 * host it in a ComposeView while keeping WebView routing and SSH connection
 * ownership outside this file.
 */
@Composable
fun BridgeSshTerminalScreen(
    session: BridgeSshTerminalSession,
    modifier: Modifier = Modifier,
    title: String? = null,
    showStatus: Boolean = true,
    keyboardEnabled: Boolean = true,
    showSoftKeyboard: Boolean = true,
    resizeSuspended: Boolean = false,
    forcedSize: Pair<Int, Int>? = null,
    closeSessionOnDispose: Boolean = false,
    onTerminalTap: () -> Unit = {},
    onHyperlinkClick: (String) -> Unit = {},
) {
    val status = session.status

    val headerVisible = title != null || showStatus
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color.Black),
    ) {
        BridgeSshTerminalView(
            session = session,
            modifier = Modifier
                .fillMaxSize()
                .padding(top = if (headerVisible) 52.dp else 0.dp),
            keyboardEnabled = keyboardEnabled,
            showSoftKeyboard = showSoftKeyboard,
            resizeSuspended = resizeSuspended,
            forcedSize = forcedSize,
            closeSessionOnDispose = closeSessionOnDispose,
            onTerminalTap = onTerminalTap,
            onHyperlinkClick = onHyperlinkClick,
        )
        if (headerVisible) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .align(Alignment.TopCenter)
                    .background(Color(0xFF171717))
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            ) {
                title?.let { BasicText(text = it, style = titleTextStyle) }
                if (showStatus) BasicText(text = formatStatus(status), style = statusTextStyle)
            }
        }
    }
}

private val titleTextStyle = TextStyle(
    color = Color.White,
    fontFamily = FontFamily.Monospace,
    fontSize = 13.sp,
)

private val statusTextStyle = TextStyle(
    color = Color(0xFFB8B8B8),
    fontFamily = FontFamily.Monospace,
    fontSize = 11.sp,
)

private fun formatStatus(status: BridgeSshTerminalStatus): String {
    val label = when (status.state) {
        BridgeSshConnectionState.DISCONNECTED -> "disconnected"
        BridgeSshConnectionState.CONNECTING -> "connecting"
        BridgeSshConnectionState.CONNECTED -> "connected"
        BridgeSshConnectionState.DISCONNECTING -> "disconnecting"
        BridgeSshConnectionState.FAILED -> "failed"
        BridgeSshConnectionState.CLOSED -> "closed"
    }
    return status.message?.takeIf { it.isNotBlank() }?.let { "$label · $it" } ?: label
}
