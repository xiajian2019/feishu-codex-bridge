package dev.feishu.codex.bridge

/** Track the remote cursor visibility without altering the PTY byte stream. */
internal class BridgeSshCursorState {
    var visible: Boolean = true
        private set

    private enum class State { TEXT, ESCAPE, CSI, STRING, STRING_ESCAPE }
    private var state = State.TEXT
    private val parameters = StringBuilder()
    private var osc = false

    fun accept(bytes: ByteArray) {
        for (raw in bytes) {
            val byte = raw.toInt() and 0xff
            when (state) {
                State.TEXT -> if (byte == ESC) state = State.ESCAPE
                State.ESCAPE -> when (byte) {
                    '['.code -> { parameters.setLength(0); state = State.CSI }
                    ']'.code, 'P'.code, '_'.code, '^'.code, 'X'.code -> {
                        osc = byte == ']'.code
                        state = State.STRING
                    }
                    'c'.code -> { visible = true; state = State.TEXT }
                    ESC -> Unit
                    else -> state = State.TEXT
                }
                State.CSI -> when {
                    byte == ESC -> state = State.ESCAPE
                    byte == 0x18 || byte == 0x1a -> state = State.TEXT
                    byte in 0x40..0x7e -> {
                        if ((byte == 'h'.code || byte == 'l'.code) && parameters.startsWith("?") &&
                            parameters.substring(1).split(';').any { it == "25" }) {
                            visible = byte == 'h'.code
                        }
                        state = State.TEXT
                    }
                    parameters.length < 96 && byte in 0x20..0x3f -> parameters.append(byte.toChar())
                    else -> state = State.TEXT
                }
                State.STRING -> when {
                    byte == ESC -> state = State.STRING_ESCAPE
                    byte == 0x18 || byte == 0x1a || (osc && byte == 0x07) -> state = State.TEXT
                }
                State.STRING_ESCAPE -> when (byte) {
                    '\\'.code -> state = State.TEXT
                    ESC -> Unit
                    else -> state = State.STRING
                }
            }
        }
    }

    private companion object { const val ESC = 0x1b }
}
