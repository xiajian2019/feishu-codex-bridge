package dev.feishu.codex.bridge

import android.os.Bundle
import android.os.SystemClock
import android.graphics.Rect
import android.graphics.Bitmap
import android.view.KeyCharacterMap
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject

/** Exercises the actual Activity with an explicitly supplied disposable SSH fixture. */
@RunWith(AndroidJUnit4::class)
class BridgeSshActivityLiveTest {
    @Test
    fun appOwnsConnectionsAcrossPagesAndKeepsHostsIndependent() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        val keyPath = args.getString("fixtureKey")
        val root = args.getString("fixtureRoot")
        val username = args.getString("fixtureUser")
        val fixturePort = args.getString("fixturePort")?.toIntOrNull() ?: 22339
        val secondFixturePort = args.getString("secondFixturePort")?.toIntOrNull() ?: 22340
        assumeTrue(!keyPath.isNullOrBlank() && !root.isNullOrBlank() && !username.isNullOrBlank())
        require(root!!.startsWith("/private/tmp/bridge-native-composer-qa."))
        require(keyPath!!.startsWith("/data/local/tmp/bridge-composer-"))
        val context = instrumentation.targetContext
        BridgeSshCrypto.install()
        val secret = File(keyPath).readText().toCharArray()
        val key = try { BridgeSshKeyStore.importKey(context, secret, "temporary-ssh-qa") } finally { secret.fill('\u0000') }
        val profiles = BridgeSshProfileStore(context)
        val profile = profiles.save(BridgeSshProfile.create(
            label = "temporary-ssh-qa", host = "10.0.2.2", port = fixturePort,
            username = username!!, keyId = key.id,
        ))
        val secondProfile = profiles.save(BridgeSshProfile.create(
            label = "temporary-ssh-qa-second", host = "10.0.2.2", port = secondFixturePort,
            username = username, keyId = key.id,
        ))
        val firstKey = BridgeSshAppConnectionKey.of(profile.host, profile.port, profile.username)
        val secondKey = BridgeSshAppConnectionKey.of(secondProfile.host, secondProfile.port, secondProfile.username)
        val first = AtomicReference<BridgeSshAppSession>()
        val second = AtomicReference<BridgeSshAppSession>()
        try {
            ActivityScenario.launch(BridgeConnectBotSshActivity::class.java).use {
                tap(waitForNode("temporary-ssh-qa"))
                for (attempt in 0 until 200) {
                    val rootNode = instrumentation.uiAutomation.rootInActiveWindow
                    val accept = find(rootNode, "接受")
                    if (accept != null) tap(accept)
                    if (find(instrumentation.uiAutomation.rootInActiveWindow, "SSH 消息输入") != null) break
                    Thread.sleep(50)
                }
                assertTrue("connecting to the shell must not open tmux automatically",
                    find(instrumentation.uiAutomation.rootInActiveWindow, "tmux 会话") == null)
                tap(waitForNode("tmux"))
                waitForNode("tmux 会话")
                tap(waitForNode("关闭"))
                waitForNode("SSH 消息输入")
                setInput("ll")
                tap(waitForNode("发送"))
                waitForNode("已写入 SSH，执行情况请查看终端")
                setInput("$")
                waitForNode("搜索技能")
                tap(waitForNode("fixture-global"))
                setInput("printf bridge-activity-second")
                tap(waitForNode("发送"))
                waitForNode("已写入 SSH，执行情况请查看终端")
                Thread.sleep(500)
                assertTrue("SSH should remain connected after both sends and skill discovery", waitForNode("tmux").isEnabled)
                instrumentation.runOnMainSync { first.set(BridgeSshAppState.find(firstKey)) }
                assertNotNull(first.get())
                setInput("sleep 4; printf bridge-hidden-output")
                clickAccessible("发送")
                waitForNode("已写入 SSH，执行情况请查看终端")
                first.get().diagnostics.start()
                setInput("draft-preserved")
            }
            instrumentation.runOnMainSync {
                assertSame("the App must retain the session after Activity destruction", first.get(), BridgeSshAppState.find(firstKey))
                assertTrue(first.get().transport.isAuthenticated)
            }
            val outputBefore = outputEvents(first.get())
            Thread.sleep(4_500)
            assertTrue("terminal output must continue while no SSH Activity exists", outputEvents(first.get()) > outputBefore)
            val firstScope = BridgeSshComposerDraftStore.scopeKey(profile.host, profile.port, profile.username, null, null)
            assertEquals("draft-preserved", BridgeSshComposerDraftStore(context).load(firstScope).text)

            ActivityScenario.launch(BridgeConnectBotSshActivity::class.java).use {
                waitForNode("SSH 消息输入")
                assertNotNull(waitForNode("draft-preserved"))
                instrumentation.runOnMainSync { assertSame(first.get(), BridgeSshAppState.mostRecent()) }
                tap(waitForNode("更多操作"))
                tap(waitForNode("主机"))
                tap(waitForNode("temporary-ssh-qa-second"))
                for (attempt in 0 until 200) {
                    val rootNode = instrumentation.uiAutomation.rootInActiveWindow
                    find(rootNode, "接受")?.let(::tap)
                    if (find(instrumentation.uiAutomation.rootInActiveWindow, "SSH 消息输入") != null) break
                    Thread.sleep(50)
                }
                waitForNode("SSH 消息输入")
                instrumentation.runOnMainSync {
                    second.set(BridgeSshAppState.find(secondKey))
                    assertNotNull(second.get())
                    assertTrue(first.get() !== second.get())
                    assertTrue(first.get().transport.isAuthenticated)
                }
                setInput("second-draft")
                tap(waitForNode("更多操作"))
                tap(waitForNode("主机"))
                tap(waitForNode("temporary-ssh-qa"))
                instrumentation.runOnMainSync { assertSame(first.get(), BridgeSshAppState.mostRecent()) }
                assertNotNull(waitForNode("draft-preserved"))
                tap(waitForNode("更多操作"))
                tap(waitForNode("断开"))
            }
            instrumentation.runOnMainSync {
                assertTrue(BridgeSshAppState.find(firstKey) == null)
                assertSame(second.get(), BridgeSshAppState.find(secondKey))
                assertTrue(second.get().transport.isAuthenticated)
            }
            ActivityScenario.launch(BridgeConnectBotSshActivity::class.java).use {
                waitForNode("SSH 消息输入")
                assertNotNull(waitForNode("second-draft"))
                setInput("printf bridge-second-host")
                tap(waitForNode("发送"))
                waitForNode("已写入 SSH，执行情况请查看终端")
                tap(waitForNode("更多操作"))
                tap(waitForNode("断开"))
            }
            instrumentation.runOnMainSync { assertTrue(BridgeSshAppState.find(secondKey) == null) }
        } finally {
            instrumentation.runOnMainSync {
                listOfNotNull(BridgeSshAppState.find(firstKey), BridgeSshAppState.find(secondKey))
                    .forEach(BridgeSshAppState::disconnect)
            }
            profiles.delete(profile.id)
            profiles.delete(secondProfile.id)
            BridgeSshKeyStore.delete(context, key.id)
        }
    }

    private fun outputEvents(session: BridgeSshAppSession): Int {
        val events = JSONObject(session.diagnostics.snapshot(JSONObject()).toString(Charsets.UTF_8)).getJSONArray("events")
        return (0 until events.length()).count { events.getJSONObject(it).optString("event") == "output" }
    }

    private fun setInput(value: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        // A previous send may still be finishing even while its old notice is visible.
        waitForNode("发送")
        tap(waitForNode("SSH 消息输入"))
        // Compose may expose the label and the editable field as separate nodes.
        val input = findEditable(instrumentation.uiAutomation.rootInActiveWindow)
        assertNotNull("the SSH input must expose an editable accessibility node", input)
        if (!input!!.text.isNullOrEmpty()) {
            val clear = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, "")
            }
            assertTrue("input must support replacing the entire draft",
                input.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, clear))
        }
        val keys = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(value.toCharArray())
        assertNotNull(keys)
        keys.forEach { assertTrue(instrumentation.uiAutomation.injectInputEvent(it, true)) }
        instrumentation.waitForIdleSync()
        Thread.sleep(350) // Wait for keyboard and feedback layout changes before tapping send.
    }

    private fun waitForNode(value: String): AccessibilityNodeInfo {
        repeat(200) {
            find(InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow, value)?.let { return it }
            Thread.sleep(50)
        }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.takeScreenshot()?.let { screenshot ->
            instrumentation.targetContext.getExternalFilesDir(null)?.let { directory ->
                FileOutputStream(File(directory, "ssh-activity-test-failure.png")).use { screenshot.compress(Bitmap.CompressFormat.PNG, 100, it) }
            }
            screenshot.recycle()
        }
        val texts = mutableListOf<String>()
        fun collect(node: AccessibilityNodeInfo?) {
            if (node == null) return
            val label = node.contentDescription ?: node.text
            if (label != null) texts.add("$label (enabled=${node.isEnabled})")
            for (i in 0 until node.childCount) collect(node.getChild(i))
        }
        collect(instrumentation.uiAutomation.rootInActiveWindow)
        throw AssertionError("Missing accessibility target: $value; visible=${texts.joinToString()}")
    }

    private fun findEditable(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.isEditable) return node
        for (i in 0 until node.childCount) findEditable(node.getChild(i))?.let { return it }
        return null
    }

    private fun find(node: AccessibilityNodeInfo?, value: String): AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.contentDescription?.toString() == value || node.text?.toString() == value) return node
        for (i in 0 until node.childCount) find(node.getChild(i), value)?.let { return it }
        return null
    }

    private fun clickAccessible(value: String) {
        val node = waitForNode(value)
        val target = generateSequence(node as AccessibilityNodeInfo?) { it.parent }.take(5).firstOrNull { it.isClickable }
        assertNotNull("$value must have a click action", target)
        assertTrue(target!!.performAction(AccessibilityNodeInfo.ACTION_CLICK))
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
    }

    private fun tap(node: AccessibilityNodeInfo) {
        assertNotNull(node)
        val rect = Rect().also(node::getBoundsInScreen)
        val now = SystemClock.uptimeMillis()
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, rect.centerX().toFloat(), rect.centerY().toFloat(), 0)
        val up = MotionEvent.obtain(now, now + 40, MotionEvent.ACTION_UP, rect.centerX().toFloat(), rect.centerY().toFloat(), 0)
        try {
            assertTrue(automation.injectInputEvent(down, true))
            assertTrue(automation.injectInputEvent(up, true))
        } finally { down.recycle(); up.recycle() }
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
    }
}
