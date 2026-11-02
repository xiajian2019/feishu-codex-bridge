package dev.feishu.codex.bridge

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class BridgeSshRemoteFilesUiTest {
    @Test
    fun directoryAndActionsShareOneRowAndRemainIndividuallyUsable() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val directory = AtomicReference<String>()
        val uploads = AtomicInteger()
        val dismissed = AtomicInteger()
        ActivityScenario.launch(BridgeConnectBotSshActivity::class.java).use { scenario ->
            scenario.onActivity { activity -> activity.setContent {
                BridgeSshTheme("dark") {
                    var path by remember { mutableStateOf("project/docs") }
                    var open by remember { mutableStateOf(true) }
                    if (open) BridgeSshRemoteFilesDialog(
                        root = "/fixture", relative = path, files = emptyList(), busy = false, error = null,
                        previewName = null, previewText = null, previewFile = null, previewPdf = false,
                        onDismiss = { dismissed.incrementAndGet(); open = false },
                        onDirectory = { directory.set(it); path = it },
                        onPreview = {}, onDownload = {}, onCopyPath = {}, onForward = {},
                        onUpload = { uploads.incrementAndGet() }, onClosePreview = {}, onCopyPreview = {},
                    )
                }
            } }
            instrumentation.waitForIdleSync()
            val names = listOf("上级目录", "刷新目录", "上传文件", "返回 Session")
            val bounds = names.map { name -> Rect().also(waitForNode(name)::getBoundsInScreen) }
            assertTrue("toolbar actions should share one row", bounds.maxOf { it.centerY() } - bounds.minOf { it.centerY() } <= 4)
            assertTrue("toolbar actions should be ordered left to right", bounds.zipWithNext().all { (a, b) -> a.right <= b.left })
            click("刷新目录")
            assertEquals("project/docs", directory.get())
            click("上传文件")
            assertEquals(1, uploads.get())
            click("上级目录")
            assertEquals("project", directory.get())
            click("返回 Session")
            assertEquals(1, dismissed.get())
        }
    }

    private fun click(label: String) {
        val node = waitForNode(label)
        val target = generateSequence(node as AccessibilityNodeInfo?) { it.parent }.take(5).firstOrNull { it.isClickable }
        assertTrue("$label must be clickable", target?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true)
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
    }

    private fun waitForNode(label: String): AccessibilityNodeInfo {
        repeat(200) {
            find(InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow, label)?.let { return it }
            Thread.sleep(50)
        }
        throw AssertionError("Missing accessibility target: $label")
    }

    private fun find(node: AccessibilityNodeInfo?, label: String): AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.contentDescription?.toString() == label || node.text?.toString() == label) return node
        for (i in 0 until node.childCount) find(node.getChild(i), label)?.let { return it }
        return null
    }
}
