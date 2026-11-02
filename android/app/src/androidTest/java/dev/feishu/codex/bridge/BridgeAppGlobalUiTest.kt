package dev.feishu.codex.bridge

import android.content.Intent
import android.graphics.Rect
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.compose.setContent
import androidx.compose.ui.platform.ComposeView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BridgeAppGlobalUiTest {
    @Test
    fun connectionCenterTemporarilyHidesTheSameSshWorkspace() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val request = Intent().putExtra(BridgeConnectBotSshActivity.EXTRA_MANAGE, true)
                activity.openEmbeddedSshWorkspace(request)
                val root = activity.findViewById<ViewGroup>(android.R.id.content)
                val workspace = root.getChildAt(root.childCount - 1)
                assertTrue(workspace is ComposeView)
                assertTrue(activity.setEmbeddedSshWorkspaceVisible(false))
                assertEquals(View.INVISIBLE, workspace.visibility)
                assertSame(root, workspace.parent)
                assertTrue(activity.setEmbeddedSshWorkspaceVisible(true))
                assertEquals(View.VISIBLE, workspace.visibility)
                assertSame(workspace, root.getChildAt(root.childCount - 1))
                activity.closeEmbeddedSshWorkspace()
                assertFalse(activity.setEmbeddedSshWorkspaceVisible(true))
            }
        }
    }

    @Test
    fun nativeUpdateBannerOffersTheSameThreeActions() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val request = Intent(context, BridgeConnectBotSshActivity::class.java)
            .putExtra(BridgeConnectBotSshActivity.EXTRA_MANAGE, true)
        val actions = mutableListOf<String>()
        ActivityScenario.launch<BridgeConnectBotSshActivity>(request).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    BridgeSshTheme("light") {
                        BridgeAppUpdateBanner(BridgeAppUpdateBannerState("0.5.0 (200) · 50 MB", "", "", false, false)) {
                            actions.add(it)
                        }
                    }
                }
            }
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            instrumentation.waitForIdleSync()
            waitForNode("发现新的 Bridge App")
            tap(waitForNode("更新"))
            tap(waitForNode("下载 APK"))
            tap(waitForNode("稍后"))
            assertEquals(listOf("install", "download", "dismiss"), actions)
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
        if (node.text?.toString() == label || node.contentDescription?.toString() == label) return node
        for (index in 0 until node.childCount) find(node.getChild(index), label)?.let { return it }
        return null
    }

    private fun tap(node: AccessibilityNodeInfo) {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val bounds = Rect().also(node::getBoundsInScreen)
        val now = SystemClock.uptimeMillis()
        val down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, bounds.centerX().toFloat(), bounds.centerY().toFloat(), 0)
        val up = MotionEvent.obtain(now, now + 40, MotionEvent.ACTION_UP, bounds.centerX().toFloat(), bounds.centerY().toFloat(), 0)
        try {
            assertTrue(automation.injectInputEvent(down, true))
            assertTrue(automation.injectInputEvent(up, true))
        } finally { down.recycle(); up.recycle() }
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
    }
}
