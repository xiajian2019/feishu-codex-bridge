package dev.feishu.codex.bridge

/** Terminal key names and human-readable sequences share Web's PTY semantics. */
internal object BridgeSshShortcutEncoding {
    fun resolve(shortcut: BridgeSshShortcut, named: Map<String, String>): String? = when (shortcut.kind) {
        "terminal" -> named[shortcut.value]
        "sequence" -> parse(shortcut.value)
        else -> null
    }

    fun parse(input: String): String? {
        val source = input.trim()
        if (source.isEmpty() || source.length > 80) return null
        // A comma is a real key in Alt+,; otherwise commas delimit key groups.
        val groups = if (source.endsWith("+,") && !source.dropLast(2).contains(',')) listOf(source)
            else source.split(Regex("[\\s,]+" )).filter(String::isNotEmpty)
        val output = StringBuilder()
        for (group in groups) {
            var shift = false
            var alt = false
            var ctrl = false
            var key: String? = null
            for (part in group.split('+').filter(String::isNotEmpty)) {
                when (part.lowercase()) {
                    "shift" -> shift = true
                    "alt", "meta" -> alt = true
                    "ctrl", "control" -> ctrl = true
                    else -> if (key == null) key = part else return null
                }
            }
            val token = key ?: return null
            output.append(parseKey(token, shift, alt, ctrl) ?: return null)
        }
        return output.toString().ifEmpty { null }
    }

    private fun parseKey(key: String, shift: Boolean, alt: Boolean, ctrl: Boolean): String? {
        val lower = key.lowercase()
        val modifier = 1 + (if (shift) 1 else 0) + (if (alt) 2 else 0) + (if (ctrl) 4 else 0)
        val modified = shift || alt || ctrl
        when (lower) {
            "esc", "escape" -> return if (alt) "\u001b\u001b" else "\u001b"
            "tab" -> return if (shift && !alt && !ctrl) "\u001b[Z" else if (alt && !shift && !ctrl) "\u001b\t" else "\t"
            "enter", "return" -> return if (alt && !shift && !ctrl) "\u001b\r" else "\r"
            "backspace" -> return if (alt) "\u001b\u007f" else "\u007f"
            "space" -> return if (alt) "\u001b " else " "
        }
        val suffix = when (lower.removePrefix("arrow")) {
            "up" -> "A"; "down" -> "B"; "right" -> "C"; "left" -> "D"; else -> null
        }
        if (suffix != null) return if (modified) "\u001b[1;${modifier}${suffix}" else "\u001b[$suffix"
        val tilde = when (lower) {
            "delete", "del" -> 3; "insert", "ins" -> 2; "pageup", "page-up" -> 5
            "pagedown", "page-down" -> 6; else -> null
        }
        if (tilde != null) return if (modified) "\u001b[${tilde};${modifier}~" else "\u001b[${tilde}~"
        if (lower == "home" || lower == "end") {
            val end = if (lower == "home") "H" else "F"
            return if (modified) "\u001b[1;${modifier}${end}" else "\u001b[$end"
        }
        val function = Regex("^f(1[0-9]|2[0-4]|[1-9])$").matchEntire(lower)?.groupValues?.get(1)?.toInt()
        if (function != null) {
            if (function > 12 && !modified) return null
            val plain = mapOf(1 to "\u001bOP", 2 to "\u001bOQ", 3 to "\u001bOR", 4 to "\u001bOS",
                5 to "\u001b[15~", 6 to "\u001b[17~", 7 to "\u001b[18~", 8 to "\u001b[19~",
                9 to "\u001b[20~", 10 to "\u001b[21~", 11 to "\u001b[23~", 12 to "\u001b[24~")
            if (!modified) return plain[function]
            if (function <= 4) return "\u001b[1;${modifier}${('O'.code + function).toChar()}"
            val number = if (function <= 12) 13 + function * 2 else if (function == 13) 25 else 27 + (function - 14) * 2
            return "\u001b[${number};${modifier}~"
        }
        if (key.startsWith("^") && key.length > 1) return controlCode(key.drop(1))
        if (key.length != 1) return null
        if (ctrl) return controlCode(key)
        val character = if (shift) key.uppercase() else key
        return if (alt) "\u001b$character" else character
    }

    private fun controlCode(value: String): String? {
        if (value == "/") return "\u001f"
        if (value == "?") return "\u007f"
        if (value.length != 1) return null
        val code = value.uppercase()[0].code
        return if (code in 64..95) (code - 64).toChar().toString() else null
    }
}
