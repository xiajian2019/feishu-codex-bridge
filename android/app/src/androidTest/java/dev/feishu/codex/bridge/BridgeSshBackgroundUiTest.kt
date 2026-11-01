package dev.feishu.codex.bridge

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream

@RunWith(AndroidJUnit4::class)
class BridgeSshBackgroundUiTest {
    @Test
    fun terminalAndComposerUseTheSameBackgroundInBothThemes() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val transport = object : BridgeSshTerminalTransport {
            override val initialState = BridgeSshConnectionState.CONNECTED
            override fun attach(listener: BridgeSshTerminalTransport.Listener?) = Unit
            override fun writeToSsh(bytes: ByteArray, offset: Int, length: Int) = Unit
            override fun requestResize(size: BridgeSshTerminalSize) = Unit
            override fun close() = Unit
        }
        ActivityScenario.launch(BridgeConnectBotSshActivity::class.java).use { scenario ->
            val terminal = BridgeSshTerminalSession(transport)
            scenario.onActivity { terminal.acceptSshOutput("SSH theme contrast\r\n".toByteArray()) }
            try {
                for (theme in listOf("dark", "light")) {
                    scenario.onActivity { activity -> activity.setContent {
                        BridgeSshTheme(theme) {
                            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                                Column(Modifier.fillMaxSize().safeDrawingPadding()) {
                                    Box(Modifier.weight(1f).fillMaxWidth().semantics { contentDescription = "SSH 终端区域" }) {
                                        BridgeSshTerminalView(terminal, Modifier.fillMaxSize(), keyboardEnabled = false,
                                            showSoftKeyboard = false, backgroundColor = MaterialTheme.colorScheme.background,
                                            foregroundColor = MaterialTheme.colorScheme.onBackground)
                                    }
                                    BridgeSshCommandComposer(state = rememberBridgeSshCommandComposerState(),
                                        onSend = { _, _ -> }, modifier = Modifier.fillMaxWidth())
                                }
                            }
                        }
                    } }
                    instrumentation.waitForIdleSync()
                    Thread.sleep(300)
                    val terminalBounds = Rect().also(waitForNode("SSH 终端区域")::getBoundsInScreen)
                    val editorBounds = Rect().also(waitForNode("SSH 消息输入")::getBoundsInScreen)
                    val screenshot = instrumentation.uiAutomation.takeScreenshot()
                    assertNotNull(screenshot)
                    try {
                        val expected = bridgeSshColorScheme(theme).background.toArgb()
                        val terminalPixel = screenshot.getPixel(terminalBounds.centerX(), terminalBounds.centerY())
                        val editorPixel = screenshot.getPixel(editorBounds.centerX(), editorBounds.bottom - 8)
                        assertEquals("$theme terminal background", expected, terminalPixel)
                        assertEquals("$theme Composer background", expected, editorPixel)
                        val textPixels = (terminalBounds.top until minOf(terminalBounds.top + 25, terminalBounds.bottom)).sumOf { y ->
                            (terminalBounds.left until minOf(terminalBounds.left + 150, terminalBounds.right))
                                .count { x -> screenshot.getPixel(x, y) != expected }
                        }
                        assertTrue("$theme terminal text must remain visible", textPixels > 40)
                        instrumentation.targetContext.getExternalFilesDir(null)?.let { directory ->
                            FileOutputStream(File(directory, "ssh-background-$theme.png")).use {
                                screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
                            }
                        }
                    } finally { screenshot.recycle() }
                }
            } finally { scenario.onActivity { terminal.close() } }
        }
    }

    private fun waitForNode(label: String): AccessibilityNodeInfo {
        repeat(80) {
            find(InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow, label)?.let { return it }
            Thread.sleep(100)
        }
        throw AssertionError("Missing accessibility target: $label")
    }

    private fun find(node: AccessibilityNodeInfo?, label: String): AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.contentDescription?.toString() == label || node.text?.toString() == label) return node
        for (index in 0 until node.childCount) find(node.getChild(index), label)?.let { return it }
        return null
    }
}
