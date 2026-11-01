package dev.feishu.codex.bridge

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Run in two separate instrumentation processes with -e phase prepare / restore. */
@RunWith(AndroidJUnit4::class)
class BridgeSshDiagnosticsProcessTest {
    @Test
    fun recordingPersistsAcrossARealProcessRestart() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val phase = InstrumentationRegistry.getArguments().getString("phase")
        assumeTrue(phase == "prepare" || phase == "restore")
        val context = instrumentation.targetContext
        if (phase == "prepare") {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    if (BridgeSshActivityDiagnostics.recording) BridgeSshActivityDiagnostics.stop()
                    BridgeSshActivityDiagnostics.start(activity)
                    BridgeSshActivityDiagnostics.record(BridgeSshTraceEvent.PICKER_OPENED)
                }
            }
            return
        }
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    assertTrue("recording should be restored from app-private storage", BridgeSshActivityDiagnostics.recording)
                    activity.openEmbeddedSshWorkspace(Intent().putExtra(BridgeConnectBotSshActivity.EXTRA_MANAGE, true))
                }
                click("停止并复制诊断日志")
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                val copied = clipboard.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString().orEmpty()
                val events = JSONObject(copied).getJSONObject("activity").getJSONArray("events")
                val rows = (0 until events.length()).map(events::getJSONObject)
                assertTrue(rows.any { it.optString("event") == "picker.opened" })
                assertTrue(rows.any { it.optString("event") == "activity.destroyed" })
                assertTrue(rows.any { it.optString("event") == "process.started" && it.optString("detail") == "restored" })
                assertTrue(rows.any { it.optString("event") == "capture.stopped" })
                assertFalse(BridgeSshActivityDiagnostics.recording)
            }
        } finally {
            instrumentation.runOnMainSync { if (BridgeSshActivityDiagnostics.recording) BridgeSshActivityDiagnostics.stop() }
        }
    }

    private fun click(label: String) {
        repeat(200) {
            val node = find(InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow, label)
            val target = generateSequence(node) { it.parent }.take(5).firstOrNull { it.isClickable }
            if (target?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true) {
                InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                return
            }
            Thread.sleep(50)
        }
        throw AssertionError("Missing clickable target: $label")
    }

    private fun find(node: AccessibilityNodeInfo?, label: String): AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.contentDescription?.toString() == label || node.text?.toString() == label) return node
        for (i in 0 until node.childCount) find(node.getChild(i), label)?.let { return it }
        return null
    }
}
