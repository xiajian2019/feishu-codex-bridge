package dev.feishu.codex.bridge

import android.app.ActivityManager
import android.content.Context
import android.content.ClipboardManager
import android.content.Intent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.atomic.AtomicReference

/** Uses only an explicitly supplied disposable emulator SSH fixture. */
@RunWith(AndroidJUnit4::class)
class BridgeSshLifecycleLiveTest {
    @Test
    fun connectionSurvivesPickerAndEmbeddedPageChanges() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        val keyPath = args.getString("fixtureKey")
        val root = args.getString("fixtureRoot")
        val username = args.getString("fixtureUser")
        val fixturePort = args.getString("fixturePort")?.toIntOrNull() ?: 22339
        assumeTrue(!keyPath.isNullOrBlank() && !root.isNullOrBlank() && !username.isNullOrBlank())
        require(root!!.startsWith("/private/tmp/bridge-native-composer-qa."))
        require(keyPath!!.startsWith("/data/local/tmp/bridge-composer-"))
        val context = instrumentation.targetContext
        BridgeSshCrypto.install()
        val secret = File(keyPath).readText().toCharArray()
        val key = try { BridgeSshKeyStore.importKey(context, secret, "temporary-lifecycle-key") } finally { secret.fill('\u0000') }
        val profiles = BridgeSshProfileStore(context)
        val profile = profiles.save(BridgeSshProfile.create(
            label = "temporary-lifecycle-host", host = "10.0.2.2", port = fixturePort,
            username = username!!, keyId = key.id,
        ))
        val connectionKey = BridgeSshAppConnectionKey.of(profile.host, profile.port, profile.username)
        val original = AtomicReference<BridgeSshAppSession>()
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    val request = Intent().putExtra(BridgeConnectBotSshActivity.EXTRA_HOST, profile.host)
                        .putExtra(BridgeConnectBotSshActivity.EXTRA_PORT, profile.port)
                        .putExtra(BridgeConnectBotSshActivity.EXTRA_USERNAME, profile.username)
                        .putExtra(BridgeConnectBotSshActivity.EXTRA_PROFILE_ID, profile.id)
                        .putExtra(BridgeConnectBotSshActivity.EXTRA_KEY_ID, key.id)
                    activity.openEmbeddedSshWorkspace(request)
                }
                waitForTerminal()
                assertTrue("connecting to the shell must not open the tmux picker automatically",
                    find(instrumentation.uiAutomation.rootInActiveWindow, "按名称、目录或 ID 筛选") == null)
                click("tmux 会话")
                waitForNode("按名称、目录或 ID 筛选")
                click("关闭")
                waitForTerminal()
                instrumentation.runOnMainSync { original.set(BridgeSshAppState.find(connectionKey)) }
                assertNotNull("the SSH session should be registered", original.get())
                assertAlive(original.get())

                // Exercise the same OpenMultipleDocuments handoff used to pick photos.
                click("添加附件")
                val appPackage = context.packageName
                var pickerVisible = false
                for (attempt in 0 until 100) {
                    val visiblePackage = instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString()
                    if (visiblePackage != null && visiblePackage != appPackage) { pickerVisible = true; break }
                    Thread.sleep(50)
                }
                assertTrue("the system document picker should be visible", pickerVisible)
                assertTrue("SSH should remain foreground protected while the picker is visible", waitForForegroundService(context, expected = true))
                val holdMs = args.getString("backgroundHoldMs")?.toLongOrNull()?.coerceIn(0, 45_000) ?: 0
                if (holdMs > 0) Thread.sleep(holdMs)
                assertSameSession(connectionKey, original.get())
                assertAlive(original.get())
                assertTrue(instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK))
                waitForTerminal()
                assertSameSession(connectionKey, original.get())
                assertAlive(original.get())

                // Returning to the workbench and reopening must preserve the same PTY.
                click("返回工作台")
                instrumentation.waitForIdleSync()
                assertSameSession(connectionKey, original.get())
                scenario.onActivity { it.openEmbeddedSshWorkspace(null) }
                waitForTerminal()
                assertSameSession(connectionKey, original.get())
                assertAlive(original.get())

                scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
                assertTrue("SSH should stay protected while its Activity is stopped", waitForForegroundService(context, expected = true))
                assertSameSession(connectionKey, original.get())
                assertAlive(original.get())
                scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
                waitForTerminal()
                scenario.recreate()
                waitForTerminal()
                assertSameSession(connectionKey, original.get())
                assertAlive(original.get())
                assertTrue("an active SSH connection must have a foreground service while the UI can leave",
                    waitForForegroundService(context, expected = true))
            }
        } finally {
            instrumentation.runOnMainSync { BridgeSshAppState.find(connectionKey)?.let(BridgeSshAppState::disconnect) }
            profiles.delete(profile.id)
            BridgeSshKeyStore.delete(context, key.id)
        }
        assertTrue("the SSH foreground service must stop after the last connection closes",
            waitForForegroundService(context, expected = false))
    }

    @Test
    fun diagnosticsCapturePickerDisconnectReconnectAndCopy() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        val keyPath = args.getString("fixtureKey")
        val root = args.getString("fixtureRoot")
        val username = args.getString("fixtureUser")
        val fixturePort = args.getString("fixturePort")?.toIntOrNull() ?: 22339
        assumeTrue(!keyPath.isNullOrBlank() && !root.isNullOrBlank() && !username.isNullOrBlank())
        require(root!!.startsWith("/private/tmp/bridge-native-composer-qa."))
        require(keyPath!!.startsWith("/data/local/tmp/bridge-composer-"))
        val context = instrumentation.targetContext
        BridgeSshCrypto.install()
        val secret = File(keyPath).readText().toCharArray()
        val key = try { BridgeSshKeyStore.importKey(context, secret, "temporary-diagnostics-key") } finally { secret.fill('\u0000') }
        val profiles = BridgeSshProfileStore(context)
        val profile = profiles.save(BridgeSshProfile.create(
            label = "temporary-diagnostics-host", host = "10.0.2.2", port = fixturePort, username = username!!, keyId = key.id,
        ))
        val connectionKey = BridgeSshAppConnectionKey.of(profile.host, profile.port, profile.username)
        val original = AtomicReference<BridgeSshAppSession>()
        val recovered = AtomicReference<BridgeSshAppSession>()
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    activity.openEmbeddedSshWorkspace(Intent()
                        .putExtra(BridgeConnectBotSshActivity.EXTRA_HOST, profile.host)
                        .putExtra(BridgeConnectBotSshActivity.EXTRA_PORT, profile.port)
                        .putExtra(BridgeConnectBotSshActivity.EXTRA_USERNAME, profile.username)
                        .putExtra(BridgeConnectBotSshActivity.EXTRA_PROFILE_ID, profile.id)
                        .putExtra(BridgeConnectBotSshActivity.EXTRA_KEY_ID, key.id))
                }
                waitForTerminal()
                instrumentation.runOnMainSync { original.set(BridgeSshAppState.find(connectionKey)) }
                assertNotNull(original.get())
                click("开始记录调试日志")
                assertTrue(BridgeSshActivityDiagnostics.recording)

                // The recording continues through Activity recreation and the real document picker.
                scenario.recreate()
                waitForTerminal()
                assertSameSession(connectionKey, original.get())
                assertTrue(BridgeSshActivityDiagnostics.recording)
                click("添加附件")
                val appPackage = context.packageName
                var pickerVisible = false
                for (attempt in 0 until 100) {
                    val visiblePackage = instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString()
                    if (visiblePackage != null && visiblePackage != appPackage) { pickerVisible = true; break }
                    Thread.sleep(50)
                }
                assertTrue(pickerVisible)
                val holdMs = args.getString("diagnosticHoldMs")?.toLongOrNull()?.coerceIn(0, 45_000) ?: 0
                if (holdMs > 0) Thread.sleep(holdMs)
                assertTrue(instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK))
                waitForTerminal()

                // The app-owned logical session must recover its physical transport even while the Activity is stopped.
                val oldTransport = AtomicReference<BridgeCbSshTransport>()
                val oldGeneration = java.util.concurrent.atomic.AtomicLong()
                instrumentation.runOnMainSync {
                    oldTransport.set(original.get().transport)
                    oldGeneration.set(original.get().bindingGeneration)
                }
                scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
                runBlocking { oldTransport.get().disconnect() }
                for (attempt in 0 until 200) {
                    instrumentation.runOnMainSync { recovered.set(BridgeSshAppState.find(connectionKey)) }
                    if (recovered.get() === original.get() && recovered.get().transport !== oldTransport.get() &&
                        recovered.get().bindingGeneration > oldGeneration.get() &&
                        recovered.get().terminalSession.status.state == BridgeSshConnectionState.CONNECTED) break
                    Thread.sleep(50)
                }
                assertSame("recovery should preserve the app-owned session and terminal", original.get(), recovered.get())
                assertTrue("automatic recovery should install a new transport", recovered.get().transport !== oldTransport.get())
                assertTrue("automatic recovery should finish before returning to the Activity", recovered.get().bindingGeneration > oldGeneration.get())
                assertAlive(recovered.get())
                scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
                waitForTerminal()
                instrumentation.runOnMainSync {
                    recovered.get().terminalSession.sendTerminalInput("printf diagnostic-secret-sentinel\r".toByteArray())
                }
                // Remove only this fixture key so a second drop stays in retry while diagnostics are copied.
                BridgeSshKeyStore.delete(context, key.id)
                runBlocking { recovered.get().transport.disconnect() }
                waitForFailed(recovered.get())
                click("停止并复制调试日志")
                assertFalse(BridgeSshActivityDiagnostics.recording)
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                val copied = clipboard.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString().orEmpty()
                assertTrue("the copied report should be JSON", copied.isNotBlank())
                val report = JSONObject(copied)
                assertEquals(2, report.getInt("version"))
                val activity = report.getJSONObject("activity")
                val events = activity.getJSONArray("events")
                val names = (0 until events.length()).map { events.getJSONObject(it).getString("event") }
                listOf("capture.started", "activity.created", "activity.destroyed", "picker.opened", "picker.returned",
                    "session.failed", "reconnect.started", "connection.started", "connection.succeeded", "capture.stopped")
                    .forEach { assertTrue("missing event: $it; got $names", it in names) }
                assertTrue("automatic reconnect should be identified", (0 until events.length()).any {
                    val row = events.getJSONObject(it)
                    row.optString("event") == "reconnect.started" && row.optString("detail") == "automatic"
                })
                assertTrue("network state should be recorded", "network.available" in names || "network.changed" in names)
                assertTrue("window focus changes should be recorded", "activity.focus.changed" in names)
                assertTrue("foreground service state should be recorded", (0 until events.length()).any {
                    val row = events.getJSONObject(it)
                    row.optString("event") == "service.snapshot" && row.optBoolean("foreground_running")
                })
                val sessionIds = (0 until events.length()).mapNotNull {
                    val row = events.getJSONObject(it)
                    if (row.has("session")) row.getInt("session") else null
                }.toSet()
                assertTrue("recovery events should retain the logical session id", original.get().diagnosticId in sessionIds)
                if (holdMs >= 32_000) assertTrue("background heartbeat should be recorded", "keepalive.result" in names)
                assertFalse(copied.contains("diagnostic-secret-sentinel"))
                assertFalse(copied.contains("10.0.2.2"))
                assertFalse(copied.contains(username))
                assertFalse(copied.contains("PRIVATE KEY"))
                // Existing file export remains available even after the SSH connection fails.
                click("导出滚动日志")
                var exportVisible = false
                for (attempt in 0 until 100) {
                    val visiblePackage = instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString()
                    if (visiblePackage != null && visiblePackage != appPackage) { exportVisible = true; break }
                    Thread.sleep(50)
                }
                assertTrue("file export should remain available", exportVisible)
                instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
            }
        } finally {
            instrumentation.runOnMainSync {
                if (BridgeSshActivityDiagnostics.recording) BridgeSshActivityDiagnostics.stop()
                BridgeSshAppState.find(connectionKey)?.let(BridgeSshAppState::disconnect)
            }
            profiles.delete(profile.id)
            BridgeSshKeyStore.delete(context, key.id)
        }
    }

    private fun waitForFailed(session: BridgeSshAppSession) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        for (attempt in 0 until 200) {
            val failed = AtomicReference(false)
            instrumentation.runOnMainSync { failed.set(session.terminalSession.status.state != BridgeSshConnectionState.CONNECTED) }
            if (failed.get()) return
            Thread.sleep(50)
        }
        throw AssertionError("SSH session did not report a disconnect")
    }

    @Test
    fun overlappingConnectionAttemptsKeepTheServiceUntilBothFinish() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        var pending = 0
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            try {
                scenario.onActivity { activity ->
                    BridgeSshAppState.beginConnection(activity); pending += 1
                    BridgeSshAppState.beginConnection(activity); pending += 1
                }
                assertTrue("a connection attempt should start foreground protection", waitForForegroundService(context, expected = true))
                scenario.onActivity { BridgeSshAppState.finishConnection(); pending -= 1 }
                assertTrue("one unfinished attempt must retain protection", waitForForegroundService(context, expected = true))
                scenario.onActivity { BridgeSshAppState.finishConnection(); pending -= 1 }
                assertTrue("protection should stop after the last attempt", waitForForegroundService(context, expected = false))
            } finally {
                if (pending > 0) scenario.onActivity { repeat(pending) { BridgeSshAppState.finishConnection() }; pending = 0 }
            }
        }
    }

    @Test
    fun disconnectingOneHostKeepsTheOtherHostProtected() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        val keyPath = args.getString("fixtureKey")
        val root = args.getString("fixtureRoot")
        val username = args.getString("fixtureUser")
        val fixturePort = args.getString("fixturePort")?.toIntOrNull() ?: 22339
        assumeTrue(!keyPath.isNullOrBlank() && !root.isNullOrBlank() && !username.isNullOrBlank())
        require(root!!.startsWith("/private/tmp/bridge-native-composer-qa."))
        require(keyPath!!.startsWith("/data/local/tmp/bridge-composer-"))
        val context = instrumentation.targetContext
        BridgeSshCrypto.install()
        val secret = File(keyPath).readText().toCharArray()
        val key = try { BridgeSshKeyStore.importKey(context, secret, "temporary-multi-key") } finally { secret.fill('\u0000') }
        val profiles = BridgeSshProfileStore(context)
        val first = profiles.save(BridgeSshProfile.create(label = "temporary-lifecycle-first", host = "10.0.2.2", port = fixturePort, username = username!!, keyId = key.id))
        val second = profiles.save(BridgeSshProfile.create(label = "temporary-lifecycle-second", host = "10.0.2.2", port = 22340, username = username, keyId = key.id))
        val firstKey = BridgeSshAppConnectionKey.of(first.host, first.port, first.username)
        val secondKey = BridgeSshAppConnectionKey.of(second.host, second.port, second.username)
        val other = AtomicReference<BridgeSshAppSession>()
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun open(profile: BridgeSshProfile) {
                    scenario.onActivity { activity ->
                        activity.openEmbeddedSshWorkspace(Intent()
                            .putExtra(BridgeConnectBotSshActivity.EXTRA_HOST, profile.host)
                            .putExtra(BridgeConnectBotSshActivity.EXTRA_PORT, profile.port)
                            .putExtra(BridgeConnectBotSshActivity.EXTRA_USERNAME, profile.username)
                            .putExtra(BridgeConnectBotSshActivity.EXTRA_PROFILE_ID, profile.id)
                            .putExtra(BridgeConnectBotSshActivity.EXTRA_KEY_ID, key.id))
                    }
                    waitForTerminal()
                }
                open(first)
                scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
                instrumentation.waitForIdleSync()
                open(second)
                instrumentation.runOnMainSync { other.set(BridgeSshAppState.find(secondKey)) }
                assertNotNull(other.get())
                assertTrue(waitForForegroundService(context, expected = true))
                instrumentation.runOnMainSync { BridgeSshAppState.find(firstKey)?.let(BridgeSshAppState::disconnect) }
                assertSameSession(secondKey, other.get())
                assertAlive(other.get())
                assertTrue("disconnecting another host must not stop foreground protection", waitForForegroundService(context, expected = true))
                instrumentation.runOnMainSync { BridgeSshAppState.find(secondKey)?.let(BridgeSshAppState::disconnect) }
                assertTrue("the last disconnect should stop foreground protection", waitForForegroundService(context, expected = false))
            }
        } finally {
            instrumentation.runOnMainSync {
                listOfNotNull(BridgeSshAppState.find(firstKey), BridgeSshAppState.find(secondKey)).forEach(BridgeSshAppState::disconnect)
            }
            profiles.delete(first.id)
            profiles.delete(second.id)
            BridgeSshKeyStore.delete(context, key.id)
        }
    }

    private fun assertAlive(session: BridgeSshAppSession) {
        assertEquals(BridgeSshConnectionState.CONNECTED, session.terminalSession.status.state)
        assertTrue(session.transport.isAuthenticated)
        val result = runBlocking { session.transport.exec("printf bridge_lifecycle_ok") }
        assertEquals("bridge_lifecycle_ok", result.stdout.toString(Charsets.UTF_8))
    }

    private fun assertSameSession(key: BridgeSshAppConnectionKey, expected: BridgeSshAppSession) {
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            assertSame("switching screens must retain the same SSH session", expected, BridgeSshAppState.find(key))
        }
    }

    private fun waitForForegroundService(context: Context, expected: Boolean): Boolean {
        val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        repeat(100) {
            @Suppress("DEPRECATION")
            val service = manager.getRunningServices(Int.MAX_VALUE).firstOrNull {
                it.service.className == "dev.feishu.codex.bridge.BridgeSshConnectionService"
            }
            if ((expected && service?.foreground == true) || (!expected && service == null)) return true
            Thread.sleep(50)
        }
        return false
    }

    private fun waitForTerminal() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        for (attempt in 0 until 200) {
            val visible = instrumentation.uiAutomation.rootInActiveWindow
            find(visible, "接受")?.let(::clickNode)
            if (find(visible, "SSH 消息输入") != null) return
            Thread.sleep(50)
        }
        waitForNode("SSH 消息输入")
    }

    private fun click(label: String) {
        val node = waitForNode(label)
        assertTrue("$label must have a click action", clickNode(node))
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
    }

    private fun clickNode(node: AccessibilityNodeInfo): Boolean {
        val target = generateSequence(node as AccessibilityNodeInfo?) { it.parent }.take(5).firstOrNull { it.isClickable }
        return target?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
    }

    private fun waitForNode(label: String): AccessibilityNodeInfo {
        repeat(200) {
            find(InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow, label)?.let { return it }
            Thread.sleep(50)
        }
        val labels = mutableListOf<String>()
        fun collect(node: AccessibilityNodeInfo?) {
            if (node == null) return
            (node.contentDescription ?: node.text)?.let { labels += it.toString() }
            for (i in 0 until node.childCount) collect(node.getChild(i))
        }
        collect(InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow)
        throw AssertionError("Missing accessibility target: $label; visible=${labels.joinToString()}")
    }

    private fun find(node: AccessibilityNodeInfo?, label: String): AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.contentDescription?.toString() == label || node.text?.toString() == label) return node
        for (i in 0 until node.childCount) find(node.getChild(i), label)?.let { return it }
        return null
    }
}
