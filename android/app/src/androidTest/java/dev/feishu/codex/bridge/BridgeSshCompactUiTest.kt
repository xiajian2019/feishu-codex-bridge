package dev.feishu.codex.bridge

import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import android.graphics.Rect
import android.net.Uri
import android.os.SystemClock
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class BridgeSshCompactUiTest {
    @Test
    fun imagesAppearAboveTheInputAndPreviewAndRemovalAreSeparateTargets() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val imageFile = File.createTempFile("bridge-composer-image", ".png", instrumentation.targetContext.cacheDir)
        try {
            Bitmap.createBitmap(80, 40, Bitmap.Config.ARGB_8888).also { bitmap ->
                bitmap.eraseColor(AndroidColor.GREEN)
                FileOutputStream(imageFile).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
            }
            val uri = Uri.fromFile(imageFile).toString()
            val image = BridgeSshComposerAttachment("image", "very-long-image-name.png",
                BridgeSshComposerAttachmentStatus.Ready, mimeType = "image/png", previewUri = uri)
            val second = image.copy(id = "second", name = "second.png")
            val file = BridgeSshComposerAttachment("file", "notes.txt", BridgeSshComposerAttachmentStatus.Ready,
                mimeType = "text/plain")
            val removed = AtomicReference<String>()
            ActivityScenario.launch(BridgeConnectBotSshActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    activity.setContent {
                        BridgeSshTheme("dark") {
                            var attachments by remember { mutableStateOf(listOf(image, second, file)) }
                            var preview by remember { mutableStateOf<BridgeSshComposerAttachment?>(null) }
                            Column(Modifier.fillMaxSize().background(Color.Black).safeDrawingPadding()) {
                                Box(Modifier.weight(1f))
                                BridgeSshCommandComposer(
                                    state = rememberBridgeSshCommandComposerState(initialText = "原草稿"),
                                    onSend = { _, _ -> }, modifier = Modifier.fillMaxWidth(), attachments = attachments,
                                    onPreviewAttachment = { id -> preview = attachments.first { it.id == id } },
                                    onRemoveAttachment = { id -> removed.set(id); attachments = attachments.filterNot { it.id == id } },
                                )
                            }
                            preview?.let { BridgeSshAttachmentDialog(it) { preview = null } }
                        }
                    }
                }
                instrumentation.waitForIdleSync()
                val preview = waitForNode("预览 very-long-image-name.png")
                val imageBounds = Rect().also(preview::getBoundsInScreen)
                val inputBounds = Rect().also(waitForNode("SSH 消息输入")::getBoundsInScreen)
                assertTrue("image must be above the text input", imageBounds.bottom <= inputBounds.top)
                assertNotNull("other files remain identifiable", waitForNode("notes.txt"))
                assertFalse("image name should not be a visible text row", hasText("very-long-image-name.png"))
                tap(imageBounds.centerX(), imageBounds.centerY())
                waitForNode("图片预览：very-long-image-name.png")
                assertNotNull(waitForNode("关闭图片预览"))
                assertFalse("preview should not show an oversized filename heading", hasText("very-long-image-name.png"))
                Thread.sleep(350) // Let the platform dialog entrance animation finish.
                saveScreenshot("ssh-image-lightbox.png")
                tap(waitForNode("关闭图片预览"))
                instrumentation.waitForIdleSync()
                val remove = Rect().also(waitForNode("移除 very-long-image-name.png")::getBoundsInScreen)
                tap(remove.centerX(), remove.centerY())
                instrumentation.waitForIdleSync()
                assertEquals("image", removed.get())
                assertNotNull(waitForNode("预览 second.png"))
                assertNotNull(waitForNode("原草稿"))
                saveScreenshot("ssh-composer-thumbnails.png")
            }
        } finally { imageFile.delete() }
    }

    @Test
    fun headerKeepsTmuxAndReturnVisibleAndMovesOtherActionsIntoMenu() {
        val returned = AtomicInteger()
        val hosts = AtomicInteger()
        val tmux = AtomicInteger()
        val disconnected = AtomicInteger()
        ActivityScenario.launch(BridgeConnectBotSshActivity::class.java).use { scenario ->
            scenario.onActivity { activity -> activity.setContent {
                BridgeSshTheme("dark") {
                    BridgeSshTerminalHeader("user@host", connected = true, busy = false,
                        onReturnToWorkbench = { returned.incrementAndGet() },
                        onHosts = { hosts.incrementAndGet() }, onTmux = { tmux.incrementAndGet() },
                        onReconnect = {}, onDisconnect = { disconnected.incrementAndGet() })
                }
            } }
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            assertNotNull(waitForNode("tmux"))
            assertNotNull(waitForNode("返回工作台"))
            assertFalse(hasText("主机"))
            assertFalse(hasText("断开"))
            tap(waitForNode("tmux"))
            tap(waitForNode("返回工作台"))
            assertEquals(1, tmux.get())
            assertEquals(1, returned.get())
            assertEquals(0, disconnected.get())
            tap(waitForNode("更多操作"))
            tap(waitForNode("主机"))
            assertEquals(1, hosts.get())
            tap(waitForNode("更多操作"))
            tap(waitForNode("断开"))
            assertEquals(1, disconnected.get())
        }
    }

    private fun waitForNode(label: String): AccessibilityNodeInfo {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        repeat(80) {
            find(instrumentation.uiAutomation.rootInActiveWindow, label)?.let { return it }
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

    private fun hasText(label: String): Boolean {
        fun findText(node: AccessibilityNodeInfo?): Boolean {
            if (node == null) return false
            if (node.text?.toString() == label) return true
            return (0 until node.childCount).any { findText(node.getChild(it)) }
        }
        return findText(InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow)
    }

    private fun tap(node: AccessibilityNodeInfo) {
        val bounds = Rect().also(node::getBoundsInScreen)
        tap(bounds.centerX(), bounds.centerY())
    }

    private fun tap(x: Int, y: Int) {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val now = SystemClock.uptimeMillis()
        val down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, x.toFloat(), y.toFloat(), 0)
        val up = MotionEvent.obtain(now, now + 40, MotionEvent.ACTION_UP, x.toFloat(), y.toFloat(), 0)
        try {
            assertTrue(automation.injectInputEvent(down, true))
            assertTrue(automation.injectInputEvent(up, true))
        } finally { down.recycle(); up.recycle() }
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
    }

    private fun saveScreenshot(name: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val bitmap = instrumentation.uiAutomation.takeScreenshot() ?: return
        val directory = instrumentation.targetContext.getExternalFilesDir(null) ?: return
        try { FileOutputStream(File(directory, name)).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) } }
        finally { bitmap.recycle() }
    }
}
