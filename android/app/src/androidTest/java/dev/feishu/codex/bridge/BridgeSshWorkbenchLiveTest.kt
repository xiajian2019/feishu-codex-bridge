package dev.feishu.codex.bridge

import android.graphics.Rect
import android.os.SystemClock
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** End-to-end against a disposable Bridge HTTP fixture and SSH server. */
@RunWith(AndroidJUnit4::class)
class BridgeSshWorkbenchLiveTest {
    @Test
    fun webAndNativeReturnButtonsOpenTheWorkbenchAndKeepSshAlive() {
        val args = InstrumentationRegistry.getArguments()
        val keyPath = args.getString("fixtureKey")
        val root = args.getString("fixtureRoot")
        val username = args.getString("fixtureUser")
        val bridgePort = args.getString("fixtureBridgePort")?.toIntOrNull()
        val sshPort = args.getString("fixturePort")?.toIntOrNull()
        assumeTrue(!keyPath.isNullOrBlank() && !root.isNullOrBlank() && !username.isNullOrBlank() && bridgePort != null && sshPort != null)
        require(root!!.startsWith("/private/tmp/bridge-native-composer-qa."))
        require(keyPath!!.startsWith("/data/local/tmp/bridge-composer-"))
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        BridgeSshCrypto.install()
        val secret = File(keyPath).readText().toCharArray()
        val key = try { BridgeSshKeyStore.importKey(context, secret, "temporary-workbench-test") } finally { secret.fill('\u0000') }
        val profileStore = BridgeSshProfileStore(context)
        val profile = profileStore.save(BridgeSshProfile.create(
            label = "temporary-workbench-host", host = "10.0.2.2", port = sshPort!!,
            username = username!!, keyId = key.id,
        ))
        val connectionKey = BridgeSshAppConnectionKey.of(profile.host, profile.port, profile.username)
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                waitForJs(scenario, "!!window.Capacitor?.Plugins?.BridgeCredentials")
                val server = "http://10.0.2.2:$bridgePort"
                evaluate(scenario, """
                    (() => {
                        const server = '$server';
                        window.Capacitor.Plugins.BridgeCredentials.set({server, token:'fixture_test_token_012345678901234567890123456789'})
                          .then(() => {
                            localStorage.setItem('bridge.mobile.server', server);
                            localStorage.setItem('bridge.connection.mode', 'ssh');
                            window.location.replace('/ssh');
                          });
                        return true;
                    })()
                """.trimIndent())
                waitForJs(scenario, "location.pathname === '/ssh' && !!document.querySelector('.mobile-ssh-login') && !!document.querySelector('.mobile-connect-return')")
                tap(waitForNode("返回工作台"))
                waitForWorkbench(scenario)
                assertEquals("/", evaluate(scenario, "location.pathname").trim('"'))
                // Keep a non-root workbench route to ensure native return does
                // not merely land on the connection screen or a generic page.
                evaluate(scenario, "history.pushState({usr:null,key:'fixture',idx:1},'', '/demos?from=fixture'); window.dispatchEvent(new PopStateEvent('popstate')); true")
                waitForJs(scenario, "location.pathname === '/demos' && location.search === '?from=fixture' && !!document.querySelector('.web-navigation')")

                // Enter SSH from the real Web gate, then use the native header.
                evaluate(scenario, "window.dispatchEvent(new Event('bridge:mobile-settings')); true")
                waitForJs(scenario, "!!document.querySelector('.mobile-connection-center')")
                tap(waitForNode("SSH / Mac"))
                waitForJs(scenario, "!!document.querySelector('.mobile-ssh-login') && !!document.querySelector('.mobile-connect-return')")
                evaluate(scenario, """
                    window.Capacitor.Plugins.BridgeConnectBotSSH.openTerminal({
                      host:'10.0.2.2', port:$sshPort, username:'$username', bridgeServerOrigin:server, profileId:'${profile.id}', keyId:'${key.id}'
                    }); true
                """.trimIndent())
                waitForTerminal()
                val original = AtomicReference<BridgeSshAppSession>()
                instrumentation.runOnMainSync { original.set(BridgeSshAppState.find(connectionKey)) }
                assertNotNull(original.get())
                assertTrue(original.get().transport.isAuthenticated)
                tap(waitForNativeNode("返回工作台"))
                waitForWorkbench(scenario)
                assertEquals("/demos?from=fixture", evaluate(scenario, "location.pathname + location.search").trim('"'))
                instrumentation.runOnMainSync {
                    assertSame(original.get(), BridgeSshAppState.find(connectionKey))
                    assertTrue(original.get().transport.isAuthenticated)
                }

                // Recreate the listener gap reported when the Web layer is not
                // ready: the dedicated native return request must be retained.
                evaluate(scenario, "window.dispatchEvent(new Event('bridge:mobile-settings')); true")
                waitForJs(scenario, "!!document.querySelector('.mobile-connection-center')")
                tap(waitForNode("SSH / Mac"))
                waitForJs(scenario, "!!document.querySelector('.mobile-ssh-login')")
                evaluate(scenario, """
                    window.Capacitor.Plugins.BridgeConnectBotSSH.openTerminal({
                      host:'10.0.2.2', port:$sshPort, username:'$username', bridgeServerOrigin:server, profileId:'${profile.id}', keyId:'${key.id}'
                    }); true
                """.trimIndent())
                waitForTerminal()
                evaluate(scenario, """
                    window.__fixtureListenersRemoved = false;
                    window.Capacitor.Plugins.BridgeConnectBotSSH.removeAllListeners().then(() => { window.__fixtureListenersRemoved = true });
                    true
                """.trimIndent())
                waitForJs(scenario, "window.__fixtureListenersRemoved === true")
                tap(waitForNativeNode("返回工作台"))
                evaluate(scenario, "location.reload(); true")
                waitForWorkbench(scenario)
                instrumentation.runOnMainSync {
                    assertSame(original.get(), BridgeSshAppState.find(connectionKey))
                    assertTrue(original.get().transport.isAuthenticated)
                }
            }
        } finally {
            instrumentation.runOnMainSync { BridgeSshAppState.find(connectionKey)?.let(BridgeSshAppState::disconnect) }
            profileStore.delete(profile.id)
            BridgeSshKeyStore.delete(context, key.id)
        }
    }

    private fun waitForWorkbench(scenario: ActivityScenario<MainActivity>) {
        waitForJs(scenario, "!document.querySelector('.mobile-connection-center') && !!document.querySelector('.web-navigation')")
    }

    private fun waitForTerminal() {
        repeat(200) {
            val root = InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow
            find(root, "接受")?.let(::tap)
            if (find(root, "SSH 消息输入") != null) return
            Thread.sleep(100)
        }
        throw AssertionError("SSH terminal did not open")
    }

    private fun waitForJs(scenario: ActivityScenario<MainActivity>, expression: String) {
        repeat(160) {
            if (evaluate(scenario, expression) == "true") return
            Thread.sleep(100)
        }
        val detail = evaluate(scenario, "JSON.stringify({url:location.href,text:document.body?.innerText?.slice(0,1000)})")
        throw AssertionError("WebView did not satisfy $expression; $detail")
    }

    private fun evaluate(scenario: ActivityScenario<MainActivity>, script: String): String {
        val result = AtomicReference<String>()
        val latch = CountDownLatch(1)
        scenario.onActivity { activity ->
            activity.bridge.webView.evaluateJavascript(script) { value -> result.set(value); latch.countDown() }
        }
        assertTrue("WebView evaluation timed out", latch.await(5, TimeUnit.SECONDS))
        return result.get() ?: "null"
    }

    private fun waitForNativeNode(label: String): AccessibilityNodeInfo {
        repeat(100) {
            val nodes = mutableListOf<AccessibilityNodeInfo>()
            fun collect(node: AccessibilityNodeInfo?) {
                if (node == null) return
                if (node.contentDescription?.toString() == label || node.text?.toString() == label) nodes.add(node)
                for (index in 0 until node.childCount) collect(node.getChild(index))
            }
            collect(InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow)
            nodes.firstOrNull { node ->
                generateSequence(node as AccessibilityNodeInfo?) { it.parent }
                    .none { it.className?.toString() == "android.webkit.WebView" }
            }?.let { return it }
            Thread.sleep(100)
        }
        throw AssertionError("Missing native accessibility target: $label")
    }

    private fun waitForNode(label: String): AccessibilityNodeInfo {
        repeat(100) {
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

    private fun tap(node: AccessibilityNodeInfo) {
        val bounds = Rect().also(node::getBoundsInScreen)
        val now = SystemClock.uptimeMillis()
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, bounds.centerX().toFloat(), bounds.centerY().toFloat(), 0)
        val up = MotionEvent.obtain(now, now + 40, MotionEvent.ACTION_UP, bounds.centerX().toFloat(), bounds.centerY().toFloat(), 0)
        try { assertTrue(automation.injectInputEvent(down, true)); assertTrue(automation.injectInputEvent(up, true)) }
        finally { down.recycle(); up.recycle() }
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
    }
}
