package dev.feishu.codex.bridge

import android.content.Intent
import android.view.ViewGroup
import androidx.compose.ui.platform.ComposeView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BridgeSshEmbeddedHostTest {
    @Test
    fun managerOverlaysTheSameWebViewAndCanBeOpenedAgain() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            repeat(2) {
                scenario.onActivity { activity ->
                    val webView = activity.bridge.webView
                    activity.openEmbeddedSshWorkspace(Intent().putExtra(BridgeConnectBotSshActivity.EXTRA_MANAGE, true))
                    assertSame(webView, activity.bridge.webView)
                    assertEquals(1, overlays(activity))
                }
                instrumentation.waitForIdleSync()
                scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
                instrumentation.waitForIdleSync()
                scenario.onActivity { activity ->
                    assertEquals(0, overlays(activity))
                    assertTrue(activity.bridge.webView.isAttachedToWindow)
                }
            }
        }
    }

    @Test
    fun visibleWorkspaceIsRestoredAfterActivityRecreation() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.openEmbeddedSshWorkspace(Intent().putExtra(BridgeConnectBotSshActivity.EXTRA_MANAGE, true))
            }
            scenario.recreate()
            scenario.onActivity { activity ->
                assertEquals(1, overlays(activity))
                assertTrue(activity.bridge.webView.isAttachedToWindow)
            }
        }
    }

    private fun overlays(activity: MainActivity): Int {
        val content = activity.findViewById<ViewGroup>(android.R.id.content)
        return (0 until content.childCount).count { content.getChildAt(it) is ComposeView }
    }
}
