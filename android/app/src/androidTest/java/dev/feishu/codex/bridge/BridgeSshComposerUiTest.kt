package dev.feishu.codex.bridge

import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import android.graphics.pdf.PdfDocument
import android.graphics.Rect
import android.os.SystemClock
import android.view.KeyCharacterMap
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class BridgeSshComposerUiTest {
    @Test
    fun typingDollarOpensSkillSelectionAndReplacesTheTrigger() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val composer = AtomicReference<BridgeSshCommandComposerState>()
        val triggered = AtomicInteger()
        ActivityScenario.launch(BridgeConnectBotSshActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    val state = rememberBridgeSshCommandComposerState(initialText = "hello ")
                    composer.set(state)
                    BridgeSshCommandComposer(state = state, onSend = { _, _ -> },
                        onSkillTrigger = { triggered.incrementAndGet() })
                }
            }
            instrumentation.waitForIdleSync()
            val inputBounds = Rect().also(waitForNode("SSH 消息输入")::getBoundsInScreen)
            tap(inputBounds.right - 10, inputBounds.centerY())
            instrumentation.waitForIdleSync()
            val keys = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(charArrayOf('$'))
            assertNotNull(keys)
            keys.forEach { assertTrue(instrumentation.uiAutomation.injectInputEvent(it, true)) }
            instrumentation.waitForIdleSync()
            assertEquals(1, triggered.get())
            scenario.onActivity { composer.get().insertSkill("sample") }
            assertEquals("hello \$sample ", composer.get().text)
        }
    }

    @Test
    fun compactComposerAndKeyboardPanelHaveSeparateWorkingTargets() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val selected = AtomicReference<String>()
        val sent = AtomicInteger()
        val added = AtomicInteger()
        val composer = AtomicReference<BridgeSshCommandComposerState>()
        val composerHeight = AtomicInteger()
        val defaults = JSONObject(context.assets.open("composer-defaults.json").bufferedReader().use { it.readText() })
        val catalog = BridgeSshShortcutCatalog.fromJson(defaults, BridgeSshShortcutCatalog.sequences(defaults))
        ActivityScenario.launch(BridgeConnectBotSshActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    BridgeSshTheme("dark") {
                        var open by remember { mutableStateOf(false) }
                        var category by remember { mutableStateOf("keyboard") }
                        val state = rememberBridgeSshCommandComposerState(initialText = "待发送内容")
                        composer.set(state)
                        Column(Modifier.fillMaxSize().background(Color.Black).safeDrawingPadding()) {
                            Box(Modifier.weight(1f).fillMaxWidth()) {
                                if (open) BridgeSshShortcutPanel(
                                    catalog, category, emptyMap(), true, { category = it }, { open = false },
                                    { selected.set(it.id) }, Modifier.align(Alignment.BottomCenter),
                                )
                            }
                            BridgeSshCommandComposer(
                                state = state, onSend = { _, complete -> sent.incrementAndGet(); complete(BridgeSshCommandSendResult.Written) },
                                modifier = Modifier.fillMaxWidth().onSizeChanged { composerHeight.set(it.height) },
                                onAddAttachment = { added.incrementAndGet() },
                                shortcuts = {
                                    BridgeSshComposerToolbar(catalog, open, category, true, false,
                                        onShortcut = { shortcut ->
                                            when (shortcut.actionKey) {
                                                "codex-panel" -> { category = "codex-tui"; open = true }
                                                "keyboard-panel" -> { category = "keyboard"; open = true }
                                                "ctrl-panel" -> { category = "ctrl"; open = true }
                                                "close-panel" -> open = false
                                                else -> selected.set(shortcut.id)
                                            }
                                        },
                                        onKeyboardFallback = { category = "keyboard"; open = !open },
                                    )
                                },
                            )
                        }
                    }
                }
            }
            instrumentation.waitForIdleSync()
            val field = waitForNode("SSH 消息输入")
            val send = waitForNode("发送")
            val fieldRect = Rect().also(field::getBoundsInScreen)
            val sendRect = Rect().also(send::getBoundsInScreen)
            val density = context.resources.displayMetrics.density
            assertTrue("input should show at least three lines", fieldRect.height() >= 58 * density)
            assertTrue("send should keep right inset", context.resources.displayMetrics.widthPixels - sendRect.right >= 6 * density)
            val initialHeight = composerHeight.get()
            saveScreenshot("composer-collapsed.png")
            scenario.onActivity { composer.get().replaceText("一\n二\n三\n四\n五\n六") }
            instrumentation.waitForIdleSync()
            Thread.sleep(350)
            saveScreenshot("composer-multiline.png")
            // Read the measured Compose surface rather than sampling a fixed
            // screenshot pixel, which can fall in the navigation bar on small screens.
            val expandedHeight = composerHeight.get()
            assertTrue("input should grow upward for multiple lines: $initialHeight -> $expandedHeight",
                expandedHeight - initialHeight > 20 * density)
            scenario.onActivity { composer.get().replaceText("待发送内容") }
            instrumentation.waitForIdleSync()
            Thread.sleep(350) // Wait for the editor to shrink before reading button bounds.

            val tuiBounds = Rect().also(waitForNode("打开 Codex TUI 按键")::getBoundsInScreen)
            tap(tuiBounds.centerX(), tuiBounds.centerY())
            instrumentation.waitForIdleSync()
            Thread.sleep(350)
            val keyboardBounds = Rect().also(waitForNode("键盘")::getBoundsInScreen)
            tap(keyboardBounds.centerX(), keyboardBounds.centerY())
            instrumentation.waitForIdleSync()
            Thread.sleep(350)
            val escape = waitForNode("esc escape")
            saveScreenshot("composer-keyboard.png")
            val escapeBounds = Rect().also(escape::getBoundsInScreen)
            val lineage = generateSequence(escape as AccessibilityNodeInfo?) { it.parent }.take(4)
                .joinToString { "desc=${it.contentDescription}, clickable=${it.isClickable}, enabled=${it.isEnabled}" }
            assertTrue("escape is visible: $escapeBounds $lineage", escape.isVisibleToUser)
            val accessibleTarget = generateSequence(escape as AccessibilityNodeInfo?) { it.parent }.take(4).firstOrNull { it.isClickable }
            assertNotNull("escape should have an accessible click action: $lineage", accessibleTarget)
            tap(escapeBounds.centerX(), escapeBounds.centerY())
            instrumentation.waitForIdleSync()
            assertEquals("keyboard-escape", selected.get())
            val nextBounds = Rect().also(waitForNode("下一页快捷键")::getBoundsInScreen)
            tap(nextBounds.centerX(), nextBounds.centerY())
            instrumentation.waitForIdleSync()
            assertNotNull(waitForNode("F6 function"))
            val closeBounds = Rect().also(waitForNode("关闭快捷键")::getBoundsInScreen)
            tap(closeBounds.centerX(), closeBounds.centerY())
            instrumentation.waitForIdleSync()
            val files = waitForNode("浏览 Session 文件")
            assertTrue(files.isVisibleToUser)
            Rect().also(files::getBoundsInScreen).let { tap(it.centerX(), it.centerY()) }
            instrumentation.waitForIdleSync()
            assertEquals("composer-session-files", selected.get())
            val toolbarBounds = Rect().also(waitForNode("SSH 快捷键，可左右滑动")::getBoundsInScreen)
            swipe(toolbarBounds.right - 10, toolbarBounds.left + 10, toolbarBounds.centerY())
            instrumentation.waitForIdleSync()
            Thread.sleep(350) // Allow the fling to settle before tapping an item.
            saveScreenshot("composer-after-swipe.png")
            for ((description, id) in listOf(
                "cancel" to "composer-escape",
                "上一条输入" to "composer-up",
                "下一条输入" to "composer-down",
            )) {
                val target = waitForNode(description)
                assertTrue("$description should be visible after swiping", target.isVisibleToUser)
                val targetBounds = Rect().also(target::getBoundsInScreen)
                assertTrue("$description is inside the toolbar: $targetBounds vs $toolbarBounds", toolbarBounds.contains(targetBounds.centerX(), targetBounds.centerY()))
                tap(targetBounds.centerX(), targetBounds.centerY())
                instrumentation.waitForIdleSync()
                assertEquals("$description at $targetBounds in $toolbarBounds", id, selected.get())
            }
            saveScreenshot("composer-shortcuts-scrolled.png")
            repeat(3) {
                swipe(toolbarBounds.left + 10, toolbarBounds.right - 10, toolbarBounds.centerY())
                instrumentation.waitForIdleSync()
                Thread.sleep(200)
            }
            val addBounds = Rect().also(waitForNode("添加附件")::getBoundsInScreen)
            tap(addBounds.centerX(), addBounds.centerY())
            assertEquals(1, added.get())
            val sendBounds = Rect().also(waitForNode("发送")::getBoundsInScreen)
            tap(sendBounds.centerX(), sendBounds.centerY())
            assertEquals(1, sent.get())
        }
    }

    @Test
    fun composerStaysAboveTheSoftKeyboard() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        ActivityScenario.launch(BridgeConnectBotSshActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    BridgeSshTheme("dark") {
                        Column(Modifier.fillMaxSize().background(Color.Black).safeDrawingPadding()) {
                            Box(Modifier.weight(1f))
                            BridgeSshCommandComposer(
                                state = rememberBridgeSshCommandComposerState(initialText = "待发送内容"),
                                onSend = { _, _ -> },
                            )
                        }
                    }
                }
            }
            instrumentation.waitForIdleSync()
            val field = Rect().also(waitForNode("SSH 消息输入")::getBoundsInScreen)
            tap(field.centerX(), field.centerY())
            instrumentation.waitForIdleSync()
            Thread.sleep(400)
            val imeBottom = AtomicInteger()
            val windowHeight = AtomicInteger()
            scenario.onActivity { activity ->
                imeBottom.set(activity.window.decorView.rootWindowInsets.getInsets(android.view.WindowInsets.Type.ime()).bottom)
                windowHeight.set(activity.windowManager.currentWindowMetrics.bounds.height())
            }
            assertTrue("soft keyboard should be visible", imeBottom.get() > 0)
            val send = Rect().also(waitForNode("发送")::getBoundsInScreen)
            assertTrue("send should remain above the soft keyboard: $send", send.bottom <= windowHeight.get() - imeBottom.get())
            saveScreenshot("composer-soft-keyboard.png")
        }
    }

    @Test
    fun skillPickerUsesCompactRowsAndStillSupportsManualInsertion() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val selected = AtomicReference<String>()
        ActivityScenario.launch(BridgeConnectBotSshActivity::class.java).use { scenario ->
            fun showPicker() = scenario.onActivity { activity ->
                activity.setContent {
                    BridgeSshTheme("dark") {
                        BridgeSshSkillPicker(
                            listOf(BridgeSshSkill("first-skill", "A long description that stays on one row"),
                                BridgeSshSkill("second-skill", "Another description")), null,
                            onDismiss = {}, onSelect = { selected.set(it) },
                        )
                    }
                }
            }
            showPicker()
            instrumentation.waitForIdleSync()
            assertNotNull(waitForNode("搜索技能"))
            val first = waitForNode("first-skill")
            saveScreenshot("ssh-skill-picker.png")
            Rect().also(first::getBoundsInScreen).let { tap(it.centerX(), it.centerY()) }
            instrumentation.waitForIdleSync()
            assertEquals("first-skill", selected.get())
            showPicker()
            instrumentation.waitForIdleSync()
            val input = Rect().also(waitForNode("搜索技能")::getBoundsInScreen)
            tap(input.centerX(), input.centerY())
            val keys = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents("custom-skill".toCharArray())
            assertNotNull(keys)
            keys.forEach { assertTrue(instrumentation.uiAutomation.injectInputEvent(it, true)) }
            instrumentation.waitForIdleSync()
            val manual = waitForNode("插入 \$custom-skill")
            Rect().also(manual::getBoundsInScreen).let { tap(it.centerX(), it.centerY()) }
            instrumentation.waitForIdleSync()
            assertEquals("custom-skill", selected.get())
        }
    }

    @Test
    fun imageAndPdfPreviewRenderInsideTheNativePage() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val cache = instrumentation.targetContext.cacheDir
        val imageFile = File.createTempFile("composer-image-test", ".png", cache)
        val pdfFile = File.createTempFile("composer-pdf-test", ".pdf", cache)
        try {
            Bitmap.createBitmap(40, 24, Bitmap.Config.ARGB_8888).also { bitmap ->
                bitmap.eraseColor(AndroidColor.GREEN)
                FileOutputStream(imageFile).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
            }
            val document = PdfDocument()
            try {
                val page = document.startPage(PdfDocument.PageInfo.Builder(120, 160, 1).create())
                page.canvas.drawColor(AndroidColor.WHITE)
                document.finishPage(page)
                FileOutputStream(pdfFile).use(document::writeTo)
            } finally { document.close() }
            ActivityScenario.launch(BridgeConnectBotSshActivity::class.java).use { scenario ->
                scenario.onActivity { activity -> activity.setContent { BridgeSshRemotePreview(imageFile, false, null) } }
                instrumentation.waitForIdleSync()
                assertNotNull(waitForNode("图片预览"))
                scenario.onActivity { activity -> activity.setContent { BridgeSshRemotePreview(pdfFile, true, null) } }
                instrumentation.waitForIdleSync()
                assertNotNull(waitForNode("PDF 第 1 页"))
            }
        } finally {
            imageFile.delete()
            pdfFile.delete()
        }
    }

    private fun waitForNode(description: String): AccessibilityNodeInfo {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        repeat(40) {
            val root = instrumentation.uiAutomation.rootInActiveWindow
            val found = find(root, description)
            if (found != null) return found
            Thread.sleep(100)
        }
        throw AssertionError("Missing accessibility target: $description")
    }

    private fun find(node: AccessibilityNodeInfo?, description: String): AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.contentDescription?.toString() == description || node.text?.toString() == description) return node
        for (index in 0 until node.childCount) find(node.getChild(index), description)?.let { return it }
        return null
    }

    private fun saveScreenshot(name: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val image = instrumentation.uiAutomation.takeScreenshot() ?: return
        val directory = instrumentation.targetContext.getExternalFilesDir(null) ?: return
        FileOutputStream(File(directory, name)).use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
        image.recycle()
    }

    private fun swipe(startX: Int, endX: Int, y: Int) {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val start = SystemClock.uptimeMillis()
        fun event(time: Long, action: Int, x: Int) = MotionEvent.obtain(start, time, action, x.toFloat(), y.toFloat(), 0)
        event(start, MotionEvent.ACTION_DOWN, startX).let { try { assertTrue(automation.injectInputEvent(it, true)) } finally { it.recycle() } }
        for (step in 1..10) {
            val x = startX + (endX - startX) * step / 10
            event(start + step * 20L, MotionEvent.ACTION_MOVE, x).let { try { assertTrue(automation.injectInputEvent(it, true)) } finally { it.recycle() } }
        }
        event(start + 240, MotionEvent.ACTION_UP, endX).let { try { assertTrue(automation.injectInputEvent(it, true)) } finally { it.recycle() } }
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
    }
}
