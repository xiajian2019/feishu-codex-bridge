@file:Suppress("INVISIBLE_MEMBER", "INVISIBLE_REFERENCE")

package dev.feishu.codex.bridge

import android.graphics.Rect
import android.os.SystemClock
import android.view.MotionEvent
import android.view.InputDevice
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntSize
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.connectbot.terminal.TerminalEmulatorImpl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class BridgeSshTerminalInteractionUiTest {
    @Test
    fun realSwipesReviewTmuxHistoryWithoutSendingInputOrInterruptingLiveOutput() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val controller = AtomicReference<BridgeSshScrollController>()
        val captures = AtomicInteger()
        val writes = AtomicInteger()
        val error = AtomicReference<String>()
        val transport = object : BridgeSshTerminalTransport {
            override val initialState = BridgeSshConnectionState.CONNECTED
            override fun attach(listener: BridgeSshTerminalTransport.Listener?) = Unit
            override fun writeToSsh(bytes: ByteArray, offset: Int, length: Int) { writes.incrementAndGet() }
            override fun requestResize(size: BridgeSshTerminalSize) = Unit
            override fun close() = Unit
        }
        ActivityScenario.launch(BridgeConnectBotSshActivity::class.java).use { scenario ->
            lateinit var terminal: BridgeSshTerminalSession
            scenario.onActivity { activity ->
                terminal = BridgeSshTerminalSession(transport)
                activity.setContent {
                    BridgeSshTerminalViewport(
                        session = terminal,
                        historyKey = "tmux-test",
                        captureHistory = {
                            captures.incrementAndGet()
                            (1..200).joinToString("\n") { "history line $it" }.toByteArray()
                        },
                        modifier = Modifier.fillMaxSize().semantics { contentDescription = "测试终端" },
                        backgroundColor = Color.Black,
                        foregroundColor = Color.White,
                        onScrollControllerAvailable = { controller.set(it) },
                        onHistoryError = { error.set(it) },
                    )
                }
                terminal.acceptSshOutput("\u001b[?1049hLive TUI".toByteArray())
            }
            waitUntil { (terminal.emulator as TerminalEmulatorImpl).snapshot.value.alternateScreen }
            instrumentation.waitForIdleSync()
            val bounds = Rect().also(waitForNode("测试终端")::getBoundsInScreen)
            longPress(bounds.centerX(), bounds.top + bounds.height() / 4)
            assertEquals("long press must remain selection, not open history", 0, captures.get())
            tap(bounds.centerX(), bounds.centerY()) // Clear the selection before scrolling.
            Thread.sleep(350)
            swipe(bounds.centerX(), bounds.top + bounds.height() / 4, bounds.top + bounds.height() * 3 / 4)
            try {
                waitUntil { captures.get() == 1 && (controller.get()?.scrollbackPosition ?: 0) > 0 }
            } catch (failure: AssertionError) {
                throw AssertionError("capture=${captures.get()} position=${controller.get()?.scrollbackPosition} error=${error.get()}", failure)
            }
            val firstPosition = controller.get().scrollbackPosition
            assertTrue(controller.get().maxScrollback > firstPosition)
            swipe(bounds.centerX(), bounds.top + bounds.height() / 4, bounds.top + bounds.height() * 3 / 4)
            waitUntil { controller.get().scrollbackPosition > firstPosition }
            scenario.onActivity { terminal.acceptSshOutput("\r\nlive output continues".toByteArray()) }
            instrumentation.waitForIdleSync()
            assertTrue("live output must not move the history view to the bottom", controller.get().scrollbackPosition > 0)
            assertEquals("history review must not send terminal keys or tmux scroll", 0, writes.get())
            assertEquals(null, error.get())
            repeat(8) {
                if (find(instrumentation.uiAutomation.rootInActiveWindow, "返回实时") != null) {
                    swipe(bounds.centerX(), bounds.top + bounds.height() * 3 / 4, bounds.top + bounds.height() / 4)
                    Thread.sleep(150)
                }
            }
            waitUntil { find(instrumentation.uiAutomation.rootInActiveWindow, "返回实时") == null }
            scenario.onActivity { controller.get().scrollToTop() }
            waitUntil { captures.get() == 2 && (controller.get()?.scrollbackPosition ?: 0) > 0 }
            val returnButton = waitForNode("返回实时")
            Rect().also(returnButton::getBoundsInScreen).let { tap(it.centerX(), it.centerY()) }
            waitUntil { find(instrumentation.uiAutomation.rootInActiveWindow, "返回实时") == null }
            assertEquals(0, writes.get())
            scenario.onActivity { terminal.close() }
        }
    }

    @Test
    fun composerFocusHidesOnlyRenderedCursorAndTypingKeepsTerminalSizeStable() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val editor = AtomicReference<BridgeSshCommandComposerState>()
        val terminalSize = AtomicReference(IntSize.Zero)
        val resizes = Collections.synchronizedList(mutableListOf<BridgeSshTerminalSize>())
        val writes = AtomicInteger()
        val transport = object : BridgeSshTerminalTransport {
            override val initialState = BridgeSshConnectionState.CONNECTED
            override fun attach(listener: BridgeSshTerminalTransport.Listener?) = Unit
            override fun writeToSsh(bytes: ByteArray, offset: Int, length: Int) { writes.incrementAndGet() }
            override fun requestResize(size: BridgeSshTerminalSize) { resizes.add(size) }
            override fun close() = Unit
        }
        ActivityScenario.launch(BridgeConnectBotSshActivity::class.java).use { scenario ->
            lateinit var terminal: BridgeSshTerminalSession
            scenario.onActivity { activity ->
                terminal = BridgeSshTerminalSession(transport)
                activity.setContent {
                    Column(Modifier.fillMaxSize().bridgeSshWorkspaceInsets()) {
                        Box(Modifier.weight(1f).fillMaxWidth().onSizeChanged { terminalSize.set(it) }) {
                            BridgeSshTerminalView(terminal, Modifier.fillMaxSize(), keyboardEnabled = false, showSoftKeyboard = false)
                        }
                        val state = rememberBridgeSshCommandComposerState()
                        editor.set(state)
                        BridgeSshCommandComposer(state, onSend = { _, _ -> },
                            stabilizeInputWhileFocused = true,
                            onInputFocusChanged = { terminal.setComposerFocused(it) })
                    }
                }
                terminal.acceptSshOutput("\u001b[?25hcursor".toByteArray())
            }
            val emulator = terminal.emulator as TerminalEmulatorImpl
            waitUntil { emulator.snapshot.value.cursorVisible }
            val inputBounds = Rect().also(waitForNode("SSH 消息输入")::getBoundsInScreen)
            tap(inputBounds.centerX(), inputBounds.centerY())
            waitUntil { !emulator.snapshot.value.cursorVisible }
            Thread.sleep(900) // Let the soft keyboard and the final PTY resize settle.
            val stableSize = terminalSize.get()
            val visible = Rect()
            scenario.onActivity { it.window.decorView.getWindowVisibleDisplayFrame(visible) }
            assertTrue("the terminal remains visible with the keyboard open: terminal=$stableSize visible=$visible", stableSize.height >= 80)
            val beforeTyping = resizes.size
            for (lines in 1..6) {
                scenario.onActivity { editor.get().replaceText((1..lines).joinToString("\n") { "line $it" }) }
                instrumentation.waitForIdleSync()
                Thread.sleep(100)
                assertEquals("typing must not resize the terminal", stableSize, terminalSize.get())
            }
            Thread.sleep(400)
            assertEquals("typing must not resize the remote PTY", beforeTyping, resizes.size)
            repeat(20) {
                scenario.onActivity { terminal.acceptSshOutput("\u001b[?25houtput $it\r".toByteArray()) }
                Thread.sleep(20)
                assertFalse("new output must not restore the second cursor", emulator.snapshot.value.cursorVisible)
            }
            scenario.onActivity { terminal.setComposerFocused(false) }
            waitUntil { emulator.snapshot.value.cursorVisible }
            scenario.onActivity {
                terminal.acceptSshOutput("\u001b[?25l".toByteArray())
                terminal.setComposerFocused(true)
                terminal.setComposerFocused(false)
            }
            waitUntil { !emulator.snapshot.value.cursorVisible }
            assertEquals("focus changes must not write to SSH", 0, writes.get())
            scenario.onActivity { terminal.close() }
        }
    }

    @Test
    fun ordinaryTerminalRespondsToFingerScrollingWithoutSendingRemoteInput() {
        val controller = AtomicReference<BridgeSshScrollController>()
        val writes = AtomicInteger()
        val transport = object : BridgeSshTerminalTransport {
            override val initialState = BridgeSshConnectionState.CONNECTED
            override fun attach(listener: BridgeSshTerminalTransport.Listener?) = Unit
            override fun writeToSsh(bytes: ByteArray, offset: Int, length: Int) { writes.incrementAndGet() }
            override fun requestResize(size: BridgeSshTerminalSize) = Unit
            override fun close() = Unit
        }
        ActivityScenario.launch(BridgeConnectBotSshActivity::class.java).use { scenario ->
            lateinit var terminal: BridgeSshTerminalSession
            scenario.onActivity { activity ->
                terminal = BridgeSshTerminalSession(transport)
                activity.setContent {
                    BridgeSshTerminalView(terminal,
                        Modifier.fillMaxSize().semantics { contentDescription = "普通终端" },
                        keyboardEnabled = false, showSoftKeyboard = false,
                        onScrollControllerAvailable = { controller.set(it) })
                }
                terminal.acceptSshOutput((1..160).joinToString("\r\n") { "line $it" }.toByteArray())
            }
            waitUntil { (controller.get()?.maxScrollback ?: 0) > 0 }
            val bounds = Rect().also(waitForNode("普通终端")::getBoundsInScreen)
            swipe(bounds.centerX(), bounds.top + bounds.height() / 4, bounds.top + bounds.height() * 3 / 4)
            waitUntil { controller.get().scrollbackPosition > 0 }
            scenario.onActivity { terminal.acceptSshOutput("\r\nnew output".toByteArray()) }
            assertTrue("new output must not return the reader to the bottom", controller.get().scrollbackPosition > 0)
            assertEquals(0, writes.get())
            scenario.onActivity { terminal.close() }
        }
    }

    @Test
    fun embeddedWorkspaceKeepsTerminalAndComposerAboveTheKeyboard() {
        val size = AtomicReference(IntSize.Zero)
        val transport = object : BridgeSshTerminalTransport {
            override val initialState = BridgeSshConnectionState.CONNECTED
            override fun attach(listener: BridgeSshTerminalTransport.Listener?) = Unit
            override fun writeToSsh(bytes: ByteArray, offset: Int, length: Int) = Unit
            override fun requestResize(size: BridgeSshTerminalSize) = Unit
            override fun close() = Unit
        }
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var terminal: BridgeSshTerminalSession
            lateinit var view: ComposeView
            scenario.onActivity { activity ->
                terminal = BridgeSshTerminalSession(transport)
                view = ComposeView(activity).apply {
                    setContent {
                        Column(Modifier.fillMaxSize().bridgeSshWorkspaceInsets()) {
                            Box(Modifier.weight(1f).fillMaxWidth().onSizeChanged { size.set(it) }) {
                                BridgeSshTerminalView(terminal, Modifier.fillMaxSize(), keyboardEnabled = false, showSoftKeyboard = false)
                            }
                            BridgeSshCommandComposer(rememberBridgeSshCommandComposerState(), onSend = { _, _ -> },
                                stabilizeInputWhileFocused = true, onInputFocusChanged = { terminal.setComposerFocused(it) })
                        }
                    }
                }
                activity.addContentView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            }
            val field = Rect().also(waitForNode("SSH 消息输入")::getBoundsInScreen)
            tap(field.centerX(), field.centerY())
            Thread.sleep(900)
            val keyboardTop = AtomicInteger()
            scenario.onActivity { activity ->
                val insets = activity.window.decorView.rootWindowInsets
                keyboardTop.set(activity.windowManager.currentWindowMetrics.bounds.height() - insets.getInsets(android.view.WindowInsets.Type.ime()).bottom)
            }
            val send = Rect().also(waitForNode("发送")::getBoundsInScreen)
            assertTrue("embedded terminal should remain visible: ${size.get()}", size.get().height >= 80)
            assertTrue("embedded composer must stay above the keyboard: $send", send.bottom <= keyboardTop.get())
            scenario.onActivity { (view.parent as? ViewGroup)?.removeView(view); terminal.close() }
        }
    }

    private fun waitUntil(condition: () -> Boolean) {
        repeat(150) {
            if (condition()) return
            Thread.sleep(50)
        }
        throw AssertionError("Timed out waiting for terminal state")
    }

    private fun waitForNode(label: String): AccessibilityNodeInfo {
        var result: AccessibilityNodeInfo? = null
        waitUntil { find(InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow, label).also { result = it } != null }
        return checkNotNull(result)
    }

    private fun find(node: AccessibilityNodeInfo?, label: String): AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.contentDescription?.toString() == label || node.text?.toString() == label) return node
        for (index in 0 until node.childCount) find(node.getChild(index), label)?.let { return it }
        return null
    }

    private fun touchEvent(start: Long, action: Int, x: Float, y: Float): MotionEvent {
        val properties = MotionEvent.PointerProperties().apply { id = 0; toolType = MotionEvent.TOOL_TYPE_FINGER }
        val coordinates = MotionEvent.PointerCoords().apply { this.x = x; this.y = y; pressure = 1f; size = 1f }
        return MotionEvent.obtain(start, SystemClock.uptimeMillis(), action, 1, arrayOf(properties), arrayOf(coordinates),
            0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
    }

    private fun tap(x: Int, y: Int) {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val now = SystemClock.uptimeMillis()
        for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
            val event = touchEvent(now, action, x.toFloat(), y.toFloat())
            assertTrue(automation.injectInputEvent(event, true)); event.recycle()
        }
    }

    private fun longPress(x: Int, y: Int) {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val start = SystemClock.uptimeMillis()
        val down = touchEvent(start, MotionEvent.ACTION_DOWN, x.toFloat(), y.toFloat())
        assertTrue(automation.injectInputEvent(down, true)); down.recycle()
        Thread.sleep(1_600)
        val up = touchEvent(start, MotionEvent.ACTION_UP, x.toFloat(), y.toFloat())
        assertTrue(automation.injectInputEvent(up, true)); up.recycle()
    }

    private fun swipe(x: Int, fromY: Int, toY: Int) {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val start = SystemClock.uptimeMillis()
        for (step in 0..20) {
            val action = when (step) { 0 -> MotionEvent.ACTION_DOWN; 20 -> MotionEvent.ACTION_UP; else -> MotionEvent.ACTION_MOVE }
            val y = fromY + (toY - fromY) * step / 20f
            val event = touchEvent(start, action, x.toFloat(), y)
            assertTrue(automation.injectInputEvent(event, true)); event.recycle()
            Thread.sleep(12)
        }
    }
}
