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
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
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
import kotlin.math.abs
import kotlin.math.roundToInt

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
        val reconnected = AtomicInteger()
        val connected = mutableStateOf(true)
        val reconnecting = mutableStateOf(false)
        ActivityScenario.launch(BridgeConnectBotSshActivity::class.java).use { scenario ->
            scenario.onActivity { activity -> activity.setContent {
                BridgeSshTheme("dark") {
                    BridgeSshTerminalHeader("user@host", connected = connected.value, reconnecting = reconnecting.value, busy = false,
                        onReturnToWorkbench = { returned.incrementAndGet() },
                        onHosts = { hosts.incrementAndGet() }, onTmux = { tmux.incrementAndGet() },
                        onReconnect = { reconnected.incrementAndGet() }, onDisconnect = { disconnected.incrementAndGet() })
                }
            } }
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            assertNotNull(waitForNode("tmux 会话"))
            assertFalse("the tmux entry should be an icon", hasText("tmux"))
            assertNotNull(waitForNode("返回工作台"))
            assertFalse(hasText("主机"))
            assertFalse(hasText("断开"))
            tap(waitForNode("tmux 会话"))
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
            scenario.onActivity { connected.value = false }
            tap(waitForNode("重连"))
            assertEquals(1, reconnected.get())
            scenario.onActivity { reconnecting.value = true }
            assertNotNull(waitForNode("重连中"))
        }
    }

    @Test
    fun compactHeaderKeepsActionBackgroundsAndTouchTargetsSeparate() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val density = instrumentation.targetContext.resources.displayMetrics.density
        val usageClicks = AtomicInteger()
        ActivityScenario.launch(BridgeConnectBotSshActivity::class.java).use { scenario ->
            scenario.onActivity { activity -> activity.setContent {
                BridgeSshTheme("dark") {
                    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
                            Box(Modifier.width(320.dp)) {
                                BridgeSshTerminalHeader(
                                    title = "codex-SDK", connected = true, reconnecting = false, busy = false,
                                    hasTmuxSession = true, accountLabel = "默认", usageSummary = "57%·63%",
                                    onReturnToWorkbench = {}, onHosts = {}, onTmux = {}, onReconnect = {},
                                    onDisconnect = {}, onUsage = { usageClicks.incrementAndGet() },
                                )
                            }
                        }
                    }
                }
            } }
            instrumentation.waitForIdleSync()
            val actions = listOf(
                waitForNode("tmux 会话"),
                waitForClickableContaining("57%·63%"),
                waitForNode("返回工作台"),
                waitForNode("更多操作"),
            )
            val bounds = actions.map { Rect().also(it::getBoundsInScreen) }
            bounds.forEach {
                assertTrue("each action needs a full touch target", it.width() >= (48 * density).roundToInt() - 1)
                assertTrue("each action needs a full touch target", it.height() >= (48 * density).roundToInt() - 1)
            }
            bounds.zipWithNext().forEach { (left, right) ->
                assertTrue("neighboring touch targets must not overlap", left.right <= right.left)
            }

            val screenshot = instrumentation.uiAutomation.takeScreenshot()
            assertNotNull(screenshot)
            try {
                val background = bridgeSshColorScheme("dark").surfaceVariant.toArgb()
                val y = bounds.first().top + (8 * density).roundToInt()
                val runs = mutableListOf<IntRange>()
                var start = -1
                for (x in bounds.first().left until bounds.last().right) {
                    if (screenshot.getPixel(x, y) == background) {
                        if (start < 0) start = x
                    } else if (start >= 0) {
                        runs.add(start until x)
                        start = -1
                    }
                }
                if (start >= 0) runs.add(start until bounds.last().right)
                assertEquals("each action has its own background", 4, runs.size)
                val gaps = runs.zipWithNext { left, right -> right.first - left.last - 1 }
                assertTrue("backgrounds must remain separated", gaps.all { it > 0 })
                assertTrue("background gaps should be equal", gaps.all { abs(it - gaps.first()) <= (2 * density).roundToInt() })
            } finally {
                screenshot.recycle()
            }
            tap(actions[1])
            assertEquals(1, usageClicks.get())
        }
    }

    @Test
    fun sessionIconOpensUsageSortedPickerAndSelectedNameReplacesHost() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val preferences = instrumentation.targetContext.getSharedPreferences("bridge_ssh_usage_ui_test", 0)
        preferences.edit().clear().commit()
        val store = BridgeSshTmuxUsageStore(preferences)
        val key = BridgeSshAppConnectionKey.of("host.test", 22, "user")
        val zeta = BridgeSshTmuxSession("\$1", "zeta-session", 1, true, "/repo", 100)
        val alpha = BridgeSshTmuxSession("\$2", "alpha-session", 1, false, "/repo", 200)
        store.recordOpen(key, zeta, 1000)
        store.recordOpen(key, zeta, 1010)
        store.recordOpen(key, alpha, 1020)
        try {
            ActivityScenario.launch(BridgeConnectBotSshActivity::class.java).use { scenario ->
                scenario.onActivity { activity -> activity.setContent {
                    BridgeSshTheme("dark") {
                        var selected by remember { mutableStateOf<BridgeSshTmuxSession?>(null) }
                        var pickerOpen by remember { mutableStateOf(false) }
                        var revision by remember { mutableStateOf(0) }
                        val sessions = remember(revision) { store.sort(key, listOf(alpha, zeta)) }
                        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                            Column(Modifier.fillMaxSize().safeDrawingPadding()) {
                                BridgeSshTerminalHeader(
                                    title = selected?.name ?: "user@host.test",
                                    connected = true, reconnecting = false, busy = false,
                                    onReturnToWorkbench = {}, onHosts = {}, onTmux = { pickerOpen = true },
                                    onReconnect = {}, onDisconnect = {},
                                )
                            }
                        }
                        if (pickerOpen) BridgeSshTmuxPicker(
                            target = "user@host.test:22", sessions = sessions, refreshing = false,
                            canRefresh = true, message = null, errorDetails = null,
                            onRefresh = {}, onDismiss = { pickerOpen = false }, onCopyError = {},
                            onSelect = { chosen ->
                                store.recordOpen(key, chosen)
                                revision += 1
                                selected = chosen
                                pickerOpen = false
                            },
                        )
                    }
                } }
                assertNotNull(waitForNode("user@host.test"))
                tap(waitForNode("tmux 会话"))
                val zetaBounds = Rect().also(waitForNode("zeta-session")::getBoundsInScreen)
                val alphaBounds = Rect().also(waitForNode("alpha-session")::getBoundsInScreen)
                assertTrue("the most used session should appear first", zetaBounds.top < alphaBounds.top)
                tap(waitForNode("alpha-session"))
                repeat(20) {
                    if (hasText("tmux 会话")) Thread.sleep(100)
                }
                assertFalse("the picker should close after selection", hasText("tmux 会话"))
                assertNotNull(waitForNode("alpha-session"))
                assertFalse("the selected session name should replace the host title", hasText("user@host.test"))
                Thread.sleep(350) // Let the dialog exit animation finish before capturing the header.
                saveScreenshot("ssh-session-header.png")
                tap(waitForNode("tmux 会话"))
                val alphaAfter = Rect().also(waitForNode("alpha-session")::getBoundsInScreen)
                val zetaAfter = Rect().also(waitForNode("zeta-session")::getBoundsInScreen)
                assertTrue("the recent click breaks a usage-count tie", alphaAfter.top < zetaAfter.top)
            }
        } finally {
            preferences.edit().clear().commit()
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

    private fun waitForClickableContaining(label: String): AccessibilityNodeInfo {
        fun contains(node: AccessibilityNodeInfo?): Boolean {
            if (node == null) return false
            if (node.text?.toString()?.contains(label) == true || node.contentDescription?.toString()?.contains(label) == true) return true
            return (0 until node.childCount).any { contains(node.getChild(it)) }
        }
        fun findClickable(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
            if (node == null) return null
            if (node.isClickable && contains(node)) return node
            for (index in 0 until node.childCount) findClickable(node.getChild(index))?.let { return it }
            return null
        }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        repeat(80) {
            findClickable(instrumentation.uiAutomation.rootInActiveWindow)?.let { return it }
            Thread.sleep(100)
        }
        throw AssertionError("Missing clickable accessibility target containing: $label")
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
