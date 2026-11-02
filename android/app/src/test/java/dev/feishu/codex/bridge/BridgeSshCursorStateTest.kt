package dev.feishu.codex.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeSshCursorStateTest {
    @Test
    fun remoteCursorVisibilitySurvivesFragmentedSequencesAndReset() {
        val cursor = BridgeSshCursorState()
        cursor.accept("\u001b[?2".toByteArray())
        cursor.accept("5;1000l".toByteArray())
        assertFalse(cursor.visible)
        cursor.accept("\u001b[?1000;25h".toByteArray())
        assertTrue(cursor.visible)
        cursor.accept("\u001b[?25l".toByteArray())
        cursor.accept("\u001bc".toByteArray())
        assertTrue(cursor.visible)
    }

    @Test
    fun escapeLikeTextInOscAndDcsDoesNotChangeCursorVisibility() {
        val cursor = BridgeSshCursorState()
        cursor.accept("\u001b]0;title \u001b[?25l\u0007".toByteArray())
        cursor.accept("\u001bPpayload \u001b[?25l\u001b\\".toByteArray())
        assertTrue(cursor.visible)
        cursor.accept("\u001b[?25l".toByteArray())
        assertFalse(cursor.visible)
    }
}
