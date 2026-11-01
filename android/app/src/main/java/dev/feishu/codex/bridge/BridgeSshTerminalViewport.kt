@file:Suppress("INVISIBLE_MEMBER", "INVISIBLE_REFERENCE")

package dev.feishu.codex.bridge

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.connectbot.terminal.TerminalEmulatorImpl
import java.io.ByteArrayOutputStream

/** A read-only history overlay leaves the live PTY and its terminal intact. */

@Composable
internal fun BridgeSshTerminalViewport(
    session: BridgeSshTerminalSession,
    historyKey: Any?,
    captureHistory: (suspend () -> ByteArray)?,
    modifier: Modifier = Modifier,
    backgroundColor: Color,
    foregroundColor: Color,
    onTerminalTap: () -> Unit = {},
    onScrollControllerAvailable: (BridgeSshScrollController?) -> Unit = {},
    onHistoryError: (String) -> Unit = {},
) {
    key(session, historyKey) {
        val scope = rememberCoroutineScope()
        val currentCapture by rememberUpdatedState(captureHistory)
        val currentError by rememberUpdatedState(onHistoryError)
        var liveController by remember { mutableStateOf<BridgeSshScrollController?>(null) }
        var historyController by remember { mutableStateOf<BridgeSshScrollController?>(null) }
        var history by remember { mutableStateOf<BridgeSshTerminalSession?>(null) }
        var cachedHistory by remember { mutableStateOf<BridgeSshTerminalSession?>(null) }
        var loading by remember { mutableStateOf(false) }
        var openAtTop by remember { mutableStateOf(false) }

        fun openHistory(top: Boolean) {
            if (history != null || loading) return
            val capture = currentCapture ?: return
            loading = true
            scope.launch {
                try {
                    val bytes = capture()
                    if (bytes.isEmpty()) {
                        currentError("当前 tmux 窗格没有可回看的历史。")
                    } else {
                        val size = session.emulator.dimensions
                        val review = cachedHistory ?: BridgeSshTerminalSession(
                            ReadOnlyHistoryTransport,
                            BridgeSshTerminalSize(size.rows, size.columns),
                        ).also { cachedHistory = it }
                        val implementation = review.emulator as TerminalEmulatorImpl
                        val previousSnapshot = implementation.snapshot.value
                        review.resize(BridgeSshTerminalSize(size.rows, size.columns))
                        // Reuse the emulator for this Session and replace its
                        // old snapshot instead of accumulating native instances.
                        val clear = "\u001b[3J\u001b[2J\u001b[H\u001b[?25l".toByteArray()
                        review.acceptSshOutput(clear + bridgeSshHistoryTerminalBytes(bytes))
                        check(withTimeoutOrNull(5_000) {
                            implementation.snapshot.first { it !== previousSnapshot }
                        } != null) { "History snapshot timed out" }
                        openAtTop = top
                        history = review
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    currentError("无法读取 tmux 历史，请检查 SSH 连接后重试。")
                } finally {
                    loading = false
                }
            }
        }

        val currentOpenHistory by rememberUpdatedState<(Boolean) -> Unit>({ openHistory(it) })
        val exposedController = remember(session) {
            object : BridgeSshScrollController {
                override val scrollbackPosition get() = (historyController ?: liveController)?.scrollbackPosition ?: 0
                override val maxScrollback get() = (historyController ?: liveController)?.maxScrollback ?: 0
                override fun scrollToTop() {
                    val activeHistory = historyController
                    if (activeHistory != null) activeHistory.scrollToTop()
                    else if ((session.emulator as? TerminalEmulatorImpl)?.snapshot?.value?.alternateScreen == true && currentCapture != null) {
                        currentOpenHistory(true)
                    } else liveController?.scrollToTop()
                }
                override fun scrollToBottom() {
                    if (history != null) history = null else liveController?.scrollToBottom()
                }
                override fun scrollBy(lines: Int) {
                    (historyController ?: liveController)?.scrollBy(lines)
                }
            }
        }
        DisposableEffect(exposedController) {
            onScrollControllerAvailable(exposedController)
            onDispose { onScrollControllerAvailable(null) }
        }
        DisposableEffect(session) {
            onDispose { cachedHistory?.close() }
        }
        LaunchedEffect(history, historyController) {
            val review = history ?: return@LaunchedEffect
            val controller = historyController ?: return@LaunchedEffect
            val hasHistory = withTimeoutOrNull(5_000) {
                snapshotFlow { controller.maxScrollback }.first { it > 0 }
            } != null
            if (!hasHistory) {
                if (history === review) {
                    history = null
                    currentError("当前 tmux 窗格没有可回看的历史。")
                }
                return@LaunchedEffect
            }
            if (openAtTop) controller.scrollToTop() else controller.scrollBy(6)
            snapshotFlow { controller.scrollbackPosition }.first { it == 0 }
            if (history === review) history = null
        }

        Box(modifier) {
            BridgeSshTerminalView(
                session = session,
                modifier = Modifier.fillMaxSize(),
                keyboardEnabled = false,
                showSoftKeyboard = false,
                backgroundColor = backgroundColor,
                foregroundColor = foregroundColor,
                onTerminalTap = onTerminalTap,
                onScrollControllerAvailable = { liveController = it },
                onAlternateScrollBack = if (captureHistory != null && history == null && !loading) {
                    { openHistory(false) }
                } else null,
            )
            history?.let { review ->
                BridgeSshTerminalView(
                    session = review,
                    modifier = Modifier.fillMaxSize(),
                    keyboardEnabled = false,
                    showSoftKeyboard = false,
                    backgroundColor = backgroundColor,
                    foregroundColor = foregroundColor,
                    onScrollControllerAvailable = { historyController = it },
                )
                Text(
                    "返回实时",
                    modifier = Modifier.align(Alignment.TopEnd)
                        .background(MaterialTheme.colorScheme.surface.copy(alpha = .94f))
                        .clickable { history = null }
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
            if (loading) CircularProgressIndicator(Modifier.align(Alignment.TopEnd).padding(8.dp))
        }
    }
}

/** Convert capture-pane's LF line endings to terminal CRLF without decoding UTF-8. */
internal fun bridgeSshHistoryTerminalBytes(input: ByteArray): ByteArray {
    val output = ByteArrayOutputStream(input.size + 256)
    var previous = -1
    for (raw in input) {
        val byte = raw.toInt() and 0xff
        if (byte == 0x0a && previous != 0x0d) output.write(0x0d)
        output.write(byte)
        previous = byte
    }
    return output.toByteArray()
}

private object ReadOnlyHistoryTransport : BridgeSshTerminalTransport {
    override val initialState = BridgeSshConnectionState.CONNECTED
    override fun attach(listener: BridgeSshTerminalTransport.Listener?) = Unit
    override fun writeToSsh(bytes: ByteArray, offset: Int, length: Int) = Unit
    override fun requestResize(size: BridgeSshTerminalSize) = Unit
    override fun close() = Unit
}
