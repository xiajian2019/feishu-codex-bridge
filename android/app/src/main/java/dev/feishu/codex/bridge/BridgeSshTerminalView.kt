@file:Suppress("INVISIBLE_MEMBER", "INVISIBLE_REFERENCE")

package dev.feishu.codex.bridge

import android.os.Handler
import android.os.Looper
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.produceState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalViewConfiguration
import org.connectbot.terminal.SelectionController
import org.connectbot.terminal.TerminalWithAccessibility
import org.connectbot.terminal.TerminalDimensions
import org.connectbot.terminal.TerminalEmulator
import org.connectbot.terminal.TerminalEmulatorFactory
import org.connectbot.terminal.TerminalEmulatorImpl
import org.connectbot.terminal.TerminalProperty
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import java.io.Closeable
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs

/**
 * Connection states exposed by the SSH adapter to the native terminal screen.
 *
 * This is deliberately smaller than the existing Capacitor plugin event
 * vocabulary. A future adapter can map plugin events into this stable UI
 * state without making termlib depend on Capacitor or on the SSH library.
 */
enum class BridgeSshConnectionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    DISCONNECTING,
    FAILED,
    CLOSED,
}

data class BridgeSshTerminalStatus(
    val state: BridgeSshConnectionState,
    val message: String? = null,
)

/**
 * Character-grid and optional pixel dimensions negotiated with the SSH PTY.
 *
 * Rows and columns are the wire-level resize contract. Pixel dimensions are
 * carried for SSH implementations that support them, but are not required by
 * the first adapter.
 */
data class BridgeSshTerminalSize(
    val rows: Int,
    val columns: Int,
    val widthPixels: Int = 0,
    val heightPixels: Int = 0,
) {
    init {
        require(rows > 0) { "rows must be positive" }
        require(columns > 0) { "columns must be positive" }
        require(widthPixels >= 0) { "widthPixels must not be negative" }
        require(heightPixels >= 0) { "heightPixels must not be negative" }
    }
}

/**
 * Native boundary between a byte-oriented SSH/PTy implementation and
 * ConnectBot termlib.
 *
 * Direction is explicit:
 *
 *  * [Listener.onSshOutput] is SSH -> terminal. The bytes are raw terminal
 *    bytes; this interface must not decode them as UTF-8.
 *  * [writeToSsh] is terminal -> SSH. The bytes are the exact bytes generated
 *    by termlib for keyboard, IME, or shortcut input.
 *  * [requestResize] forwards the terminal grid to the remote PTY.
 *
 * The implementation owns the SSH socket, authentication, host-key policy,
 * and reconnect policy. It must not retain an output buffer passed to
 * [writeToSsh] or [Listener.onSshOutput] after the callback returns unless it
 * makes its own copy.
 */
interface BridgeSshTerminalTransport {
    val initialState: BridgeSshConnectionState

    fun attach(listener: Listener?)

    fun writeToSsh(bytes: ByteArray, offset: Int, length: Int)

    fun requestResize(size: BridgeSshTerminalSize)

    fun close()

    interface Listener {
        fun onSshOutput(bytes: ByteArray, offset: Int, length: Int)

        fun onStateChanged(state: BridgeSshConnectionState, message: String?)

        fun onClosed(message: String?)
    }
}

interface BridgeSshScrollController {
    val scrollbackPosition: Int
    val maxScrollback: Int
    fun scrollToTop()
    fun scrollToBottom()
    fun scrollBy(lines: Int)
}

/**
 * Owns one termlib emulator and connects it to a byte-oriented SSH
 * transport. It is UI-framework independent apart from exposing Compose
 * observable status through [status].
 *
 * This class is not an Activity, Capacitor plugin, or SSH implementation. A
 * app session creates it after it has a transport; native screens attach
 * [BridgeSshTerminalView] or [BridgeSshTerminalScreen] while visible.
 */
class BridgeSshTerminalSession(
    private val transport: BridgeSshTerminalTransport,
    initialSize: BridgeSshTerminalSize = BridgeSshTerminalSize(rows = 24, columns = 80),
    private val mainHandler: Handler = Handler(Looper.getMainLooper()),
) : Closeable {
    private val closed = AtomicBoolean(false)
    private var lastEmulatorGrid: Pair<Int, Int>? = null
    private var lastForwardedSize: BridgeSshTerminalSize? = null
    private val resizeLock = Any()
    private var pendingResize: BridgeSshTerminalSize? = null
    private val flushResize = Runnable {
        synchronized(resizeLock) {
            val size = pendingResize
            pendingResize = null
            if (!closed.get() && size != null && size != lastForwardedSize) dispatchResize(size)
        }
    }
    private val outputLock = Any()
    private val remoteCursor = BridgeSshCursorState()
    private var composerFocused = false

    private var statusState by mutableStateOf(
        BridgeSshTerminalStatus(transport.initialState),
    )

    /** Compose observes this property when it is read from a composable. */
    val status: BridgeSshTerminalStatus
        get() = statusState

    /** The termlib emulator rendered by [BridgeSshTerminalView]. */
    val emulator: TerminalEmulator = TerminalEmulatorFactory.create(
        initialRows = initialSize.rows,
        initialCols = initialSize.columns,
        onKeyboardInput = { bytes ->
            if (!closed.get() && bytes.isNotEmpty()) {
                try {
                    // termlib may reuse its callback buffer. The transport is
                    // therefore given an owned copy and the full byte range.
                    transport.writeToSsh(bytes.copyOf(), 0, bytes.size)
                } catch (error: Throwable) {
                    publishStatus(
                        BridgeSshTerminalStatus(
                            BridgeSshConnectionState.FAILED,
                            error.message ?: "SSH input failed",
                        ),
                    )
                }
            }
        },
        onResize = { dimensions ->
            onEmulatorResize(dimensions)
        },
    )

    private val transportListener = object : BridgeSshTerminalTransport.Listener {
        override fun onSshOutput(bytes: ByteArray, offset: Int, length: Int) {
            if (closed.get()) return
            val end = checkedEnd(bytes.size, offset, length) ?: return
            if (length == 0) return

            // SSH callbacks commonly arrive on a socket thread. termlib's
            // emulator is thread-safe, so feed raw bytes without a UI hop.
            // A copy prevents a socket reader from mutating the buffer while
            // libvterm is consuming it.
            val copy = bytes.copyOfRange(offset, end)
            try {
                synchronized(outputLock) {
                    remoteCursor.accept(copy)
                    val implementation = emulator as? TerminalEmulatorImpl
                    if (composerFocused && implementation != null) {
                        // Hold termlib's snapshot lock across the raw write and
                        // cursor override, so no intermediate frame can flash it.
                        implementation.batchOutput {
                            emulator.writeInput(copy, 0, copy.size)
                            setRenderedCursorVisible(false)
                        }
                    } else {
                        emulator.writeInput(copy, 0, copy.size)
                    }
                }
            } catch (error: Throwable) {
                publishStatus(
                    BridgeSshTerminalStatus(
                        BridgeSshConnectionState.FAILED,
                        error.message ?: "Terminal output failed",
                    ),
                )
            }
        }

        override fun onStateChanged(state: BridgeSshConnectionState, message: String?) {
            publishStatus(BridgeSshTerminalStatus(state, message))
        }

        override fun onClosed(message: String?) {
            publishStatus(BridgeSshTerminalStatus(BridgeSshConnectionState.CLOSED, message))
        }
    }

    init {
        transport.attach(transportListener)
        lastEmulatorGrid = initialSize.rows to initialSize.columns
        forwardResize(initialSize)
    }

    /** Feed raw SSH/PTy output when the adapter chooses direct dispatch. */
    fun acceptSshOutput(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size) {
        transportListener.onSshOutput(bytes, offset, length)
    }

    /** Change the local render property only; the remote PTY receives no control bytes. */
    fun setComposerFocused(focused: Boolean) {
        synchronized(outputLock) {
            if (closed.get() || composerFocused == focused) return
            composerFocused = focused
            setRenderedCursorVisible(if (focused) false else remoteCursor.visible)
        }
    }

    private fun setRenderedCursorVisible(visible: Boolean) {
        // termlib 0.3.13 has no public display-cursor override. This callback
        // changes its render snapshot only, without writing to libvterm or SSH.
        (emulator as? TerminalEmulatorImpl)?.setTermProp(1, TerminalProperty.BoolValue(visible))
    }

    /** Send an explicit terminal sequence, for example a native shortcut. */
    fun sendTerminalInput(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size) {
        check(!closed.get()) { "SSH terminal session is closed" }
        val end = checkedEnd(bytes.size, offset, length)
            ?: throw IndexOutOfBoundsException("Invalid terminal input range")
        if (length == 0) return
        transport.writeToSsh(bytes.copyOfRange(offset, end), 0, length)
    }

    /**
     * Resize both sides of the adapter. The termlib composable also resizes
     * its emulator from layout changes; this explicit method is for a native
     * host that owns the PTY resize negotiation or uses [forcedSize].
     */
    fun resize(size: BridgeSshTerminalSize) {
        check(!closed.get()) { "SSH terminal session is closed" }
        val grid = size.rows to size.columns
        if (lastEmulatorGrid != grid) {
            emulator.resize(size.rows, size.columns)
            lastEmulatorGrid = grid
        }
        forwardResize(size)
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        synchronized(resizeLock) {
            mainHandler.removeCallbacks(flushResize)
            pendingResize = null
        }
        transport.attach(null)
        try {
            // termlib 0.3.13 has no public close()/dispose() on
            // TerminalEmulator. Detach the transport and drop this session;
            // never reuse the emulator after this point.
            transport.close()
        } finally {
            publishStatus(
                BridgeSshTerminalStatus(BridgeSshConnectionState.CLOSED, "Terminal closed"),
            )
        }
    }

    private fun onEmulatorResize(dimensions: TerminalDimensions) {
        if (closed.get()) return
        if (dimensions.rows <= 0 || dimensions.columns <= 0) return
        val size = BridgeSshTerminalSize(
            rows = dimensions.rows,
            columns = dimensions.columns,
            widthPixels = dimensions.widthPixels,
            heightPixels = dimensions.heightPixels,
        )
        lastEmulatorGrid = size.rows to size.columns
        forwardResize(size)
    }

    private fun forwardResize(size: BridgeSshTerminalSize) {
        synchronized(resizeLock) {
            if (closed.get() || pendingResize == size) return
            mainHandler.removeCallbacks(flushResize)
            if (lastForwardedSize == null) {
                dispatchResize(size)
            } else if (lastForwardedSize != size) {
                // Soft-keyboard animations emit many transient grid/pixel sizes.
                // Keep the final PTY size, not every intermediate layout frame.
                pendingResize = size
                mainHandler.postDelayed(flushResize, RESIZE_SETTLE_MS)
            } else {
                pendingResize = null
            }
        }
    }

    private fun dispatchResize(size: BridgeSshTerminalSize) {
        try {
            // The transport must enqueue or otherwise make this operation
            // non-blocking when the termlib callback runs on the UI looper.
            transport.requestResize(size)
            lastForwardedSize = size
        } catch (error: Throwable) {
            publishStatus(
                BridgeSshTerminalStatus(
                    BridgeSshConnectionState.FAILED,
                    error.message ?: "SSH resize failed",
                ),
            )
        }
    }

    private fun publishStatus(next: BridgeSshTerminalStatus) {
        if (closed.get() && next.state != BridgeSshConnectionState.CLOSED) return
        if (Looper.myLooper() == Looper.getMainLooper()) {
            statusState = next
        } else {
            mainHandler.post {
                if (!closed.get() || next.state == BridgeSshConnectionState.CLOSED) {
                    statusState = next
                }
            }
        }
    }

    private companion object { const val RESIZE_SETTLE_MS = 180L }

    private fun checkedEnd(size: Int, offset: Int, length: Int): Int? {
        if (offset < 0 || length < 0 || offset > size || length > size - offset) return null
        return offset + length
    }
}

/**
 * Thin Compose wrapper around termlib's native terminal component.
 *
 * Session ownership remains with the caller by default. Set
 * [closeSessionOnDispose] only when the composable owns the SSH session for
 * its whole lifetime; a tab switch should normally keep the session alive.
 */
@Composable
fun BridgeSshTerminalView(
    session: BridgeSshTerminalSession,
    modifier: Modifier = Modifier,
    keyboardEnabled: Boolean = true,
    showSoftKeyboard: Boolean = true,
    resizeSuspended: Boolean = false,
    forcedSize: Pair<Int, Int>? = null,
    closeSessionOnDispose: Boolean = false,
    onTerminalTap: () -> Unit = {},
    onHyperlinkClick: (String) -> Unit = {},
    onScrollControllerAvailable: (BridgeSshScrollController?) -> Unit = {},
    onAlternateScrollBack: (() -> Unit)? = null,
    backgroundColor: Color? = null,
    foregroundColor: Color? = null,
) {
    if (closeSessionOnDispose) {
        DisposableEffect(session) {
            onDispose { session.close() }
        }
    }

    // The terminal emulator stores default cell colours separately from the
    // Compose canvas. Update both when the host chooses a theme.
    LaunchedEffect(session, backgroundColor, foregroundColor) {
        if (backgroundColor != null && foregroundColor != null) {
            session.emulator.setDefaultColors(foregroundColor.toArgb(), backgroundColor.toArgb())
        }
    }

    // If the native host supplies a fixed grid, keep the transport PTY in
    // sync with the same values that termlib renders. Without forcedSize,
    // termlib performs its normal layout-driven resize and the factory's
    // onResize callback forwards that resulting grid to the transport.
    SideEffect {
        forcedSize?.let { (rows, columns) ->
            session.resize(BridgeSshTerminalSize(rows = rows, columns = columns))
        }
    }

    DisposableEffect(session) {
        onDispose { onScrollControllerAvailable(null) }
    }

    val emulator = session.emulator as? TerminalEmulatorImpl
    val alternateScreen by produceState(false, emulator) {
        emulator?.snapshot?.map { it.alternateScreen }?.distinctUntilChanged()?.collect { value = it }
    }
    var selectionController by remember(session) { mutableStateOf<SelectionController?>(null) }
    val alternateScrollBack by rememberUpdatedState(onAlternateScrollBack)
    val viewConfiguration = LocalViewConfiguration.current
    val alternateScrollModifier = if (alternateScreen && onAlternateScrollBack != null) {
        Modifier.pointerInput(session, alternateScreen, viewConfiguration) {
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                var cancelled = down.type != PointerType.Touch || selectionController?.isSelectionActive == true
                while (!cancelled) {
                    val event = awaitPointerEvent(PointerEventPass.Initial)
                    val change = event.changes.firstOrNull { it.id == down.id } ?: break
                    if (event.changes.count { it.pressed } > 1 ||
                        change.uptimeMillis - down.uptimeMillis >= viewConfiguration.longPressTimeoutMillis ||
                        selectionController?.isSelectionActive == true) {
                        cancelled = true
                    } else {
                        val distance = change.position - down.position
                        // Match termlib's two-finger grace period before taking
                        // the gesture, so a pinch still gets first refusal.
                        if (change.uptimeMillis - down.uptimeMillis > 40 &&
                            distance.y > viewConfiguration.touchSlop * 2 && distance.y > abs(distance.x) * 1.4f) {
                            change.consume()
                            alternateScrollBack?.invoke()
                            break
                        }
                        if (abs(distance.x) > viewConfiguration.touchSlop * 2 && abs(distance.x) > abs(distance.y)) {
                            cancelled = true
                        }
                    }
                    if (!change.pressed) break
                }
            }
        }
    } else Modifier

    // termlib 0.3.13's public Terminal delegates to this same composable but
    // does not forward its scroll controller. Keep the pinned API in one place.
    TerminalWithAccessibility(
        terminalEmulator = session.emulator,
        modifier = modifier.then(alternateScrollModifier),
        backgroundColor = backgroundColor ?: Color.Black,
        foregroundColor = foregroundColor ?: Color.White,
        keyboardEnabled = keyboardEnabled,
        showSoftKeyboard = showSoftKeyboard,
        forcedSize = forcedSize,
        resizeSuspended = resizeSuspended,
        onTerminalTap = onTerminalTap,
        onHyperlinkClick = onHyperlinkClick,
        onSelectionControllerAvailable = { selectionController = it },
        onScrollControllerAvailable = { controller ->
            onScrollControllerAvailable(object : BridgeSshScrollController {
                override val scrollbackPosition: Int get() = controller.scrollbackPosition
                override val maxScrollback: Int get() = controller.maxScrollback
                override fun scrollToTop() = controller.scrollToTop()
                override fun scrollToBottom() = controller.scrollToBottom()
                override fun scrollBy(lines: Int) = controller.scrollBy(lines)
            })
        },
    )
}
