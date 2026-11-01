package dev.feishu.codex.bridge

/** A completed upload on the same SSH target as the terminal. */
internal data class BridgeSshComposerRemoteAttachment(
    val name: String,
    val mimeType: String,
    val remotePath: String,
)

/** Build the same plain-text attachment instructions used by the Web composer. */
internal object BridgeSshComposerPrompt {
    fun build(text: String, attachments: List<BridgeSshComposerRemoteAttachment>): String {
        if (attachments.isEmpty()) return text
        attachments.forEach {
            require(it.remotePath.startsWith('/') && it.remotePath.none(Char::isISOControl)) {
                "SSH attachment path must be an absolute path without control characters"
            }
        }
        val images = attachments.filter { it.mimeType.startsWith("image/", ignoreCase = true) }
        val files = attachments.filterNot { it.mimeType.startsWith("image/", ignoreCase = true) }
        val sections = mutableListOf<String>()
        if (text.isNotBlank()) sections.add(text)
        if (images.isNotEmpty()) {
            sections.add(
                "请打开并查看我附上的图片，再结合上面的文字处理：\n" +
                    images.mapIndexed { index, image ->
                        "<image name=[Image #${index + 1}] path=\"${escapeAttribute(image.remotePath)}\">"
                    }.joinToString("\n"),
            )
        }
        if (files.isNotEmpty()) {
            sections.add(
                "请读取我附上的文件，再结合上面的文字处理：\n" +
                    files.joinToString("\n") { file ->
                        "<file name=\"${escapeAttribute(file.name)}\" path=\"${escapeAttribute(file.remotePath)}\">"
                    },
            )
        }
        return sections.joinToString("\n\n")
    }

    private fun escapeAttribute(value: String): String = buildString {
        value.forEach { character ->
            when {
                character.isISOControl() -> append(' ')
                character == '&' -> append("&amp;")
                character == '"' -> append("&quot;")
                character == '<' -> append("&lt;")
                character == '>' -> append("&gt;")
                else -> append(character)
            }
        }
    }
}
