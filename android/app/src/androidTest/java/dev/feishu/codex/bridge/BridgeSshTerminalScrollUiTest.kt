package dev.feishu.codex.bridge

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class BridgeSshTerminalScrollUiTest {
    @Test
    fun localScrollControlsPreserveHistoryWhileOutputContinues() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val controller = AtomicReference<BridgeSshScrollController>()
        val input = AtomicReference<ByteArray>()
        val transport = object : BridgeSshTerminalTransport {
            override val initialState = BridgeSshConnectionState.CONNECTED
            override fun attach(listener: BridgeSshTerminalTransport.Listener?) = Unit
            override fun writeToSsh(bytes: ByteArray, offset: Int, length: Int) { input.set(bytes.copyOfRange(offset, offset + length)) }
            override fun requestResize(size: BridgeSshTerminalSize) = Unit
            override fun close() = Unit
        }
        ActivityScenario.launch(BridgeConnectBotSshActivity::class.java).use { scenario ->
            lateinit var terminal: BridgeSshTerminalSession
            scenario.onActivity { activity ->
                terminal = BridgeSshTerminalSession(transport)
                activity.setContent {
                    BridgeSshTerminalView(terminal, Modifier.fillMaxSize(), keyboardEnabled = false, showSoftKeyboard = false,
                        onScrollControllerAvailable = { controller.set(it) })
                }
                val output = (1..160).joinToString("\r\n") { "line $it" }.toByteArray()
                terminal.acceptSshOutput(output)
            }
            instrumentation.waitForIdleSync()
            repeat(30) { if ((controller.get()?.maxScrollback ?: 0) <= 0) Thread.sleep(100) }
            val scroll = controller.get()
            assertNotNull(scroll)
            assertTrue("terminal should have local history", scroll!!.maxScrollback > 0)
            scenario.onActivity { scroll.scrollToTop() }
            instrumentation.waitForIdleSync()
            assertTrue(scroll.scrollbackPosition > 0)
            scenario.onActivity { terminal.acceptSshOutput("\r\nnew output".toByteArray()) }
            instrumentation.waitForIdleSync()
            assertTrue("new output must not jump to bottom", scroll.scrollbackPosition > 0)
            scenario.onActivity { scroll.scrollToBottom(); terminal.sendTerminalInput(byteArrayOf(3)) }
            instrumentation.waitForIdleSync()
            assertTrue(scroll.scrollbackPosition == 0)
            assertArrayEquals(byteArrayOf(3), input.get())
            scenario.onActivity { terminal.close() }
        }
    }
}
