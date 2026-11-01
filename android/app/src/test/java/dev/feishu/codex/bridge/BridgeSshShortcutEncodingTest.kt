package dev.feishu.codex.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BridgeSshShortcutEncodingTest {
    @Test
    fun terminalAndKeyboardSequencesMatchTheWebPtyBytes() {
        assertEquals("\u001b[1;2D", BridgeSshShortcutEncoding.parse("Shift+Left"))
        assertEquals("\u001b[1;2C", BridgeSshShortcutEncoding.parse("Shift+Right"))
        assertEquals("\u001bOQ", BridgeSshShortcutEncoding.parse("F2"))
        assertEquals("\u001b[Z", BridgeSshShortcutEncoding.parse("Shift+Tab"))
        assertEquals("\u0002", BridgeSshShortcutEncoding.parse("^B"))
        assertEquals("\u0003", BridgeSshShortcutEncoding.parse("Ctrl+C"))
        assertEquals("\u001b,", BridgeSshShortcutEncoding.parse("Alt+,"))
        assertEquals("^", BridgeSshShortcutEncoding.parse("^"))
        assertEquals("\u0002\u001b[A", BridgeSshShortcutEncoding.parse("^B, ArrowUp"))
        assertNull(BridgeSshShortcutEncoding.parse("Ctrl+unknown"))
    }
}
