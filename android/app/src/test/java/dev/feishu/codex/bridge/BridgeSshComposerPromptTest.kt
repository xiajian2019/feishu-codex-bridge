package dev.feishu.codex.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeSshComposerPromptTest {
    @Test
    fun textOnlyPreservesTerminalInputExactly() {
        assertEquals("  echo hi\n", BridgeSshComposerPrompt.build("  echo hi\n", emptyList()))
    }

    @Test
    fun attachmentsUseRemotePathsAndEscapeAttributeValues() {
        val prompt = BridgeSshComposerPrompt.build(
            "请检查",
            listOf(
                BridgeSshComposerRemoteAttachment("照片.jpg", "image/jpeg", "/Users/me/图片.jpg"),
                BridgeSshComposerRemoteAttachment("a\"<b>.txt", "text/plain", "/Users/me/a&b.txt"),
            ),
        )
        assertTrue(prompt.contains("<image name=[Image #1] path=\"/Users/me/图片.jpg\">"))
        assertTrue(prompt.contains("<file name=\"a&quot;&lt;b&gt;.txt\" path=\"/Users/me/a&amp;b.txt\">"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun relativeRemotePathsAreRejected() {
        BridgeSshComposerPrompt.build("", listOf(BridgeSshComposerRemoteAttachment("a", "text/plain", "relative/a")))
    }
}
