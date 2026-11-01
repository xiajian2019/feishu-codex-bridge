package dev.feishu.codex.bridge

import java.nio.charset.StandardCharsets
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeSshCommandComposerTest {
    @Test
    fun skillInsertionPreservesDraftSelectionAndPreparesCodexSubmit() {
        val state = BridgeSshCommandComposerState(initialText = "before after")
        state.replaceFieldValue(androidx.compose.ui.text.input.TextFieldValue("before after", androidx.compose.ui.text.TextRange(7, 12)))
        state.insertSkill("example-skill")
        assertEquals("before \$example-skill ", state.text)
        assertEquals("\$example-skill ", BridgeSshCommandEncoding.preparePrompt("\$example-skill"))
        assertEquals("already done ", BridgeSshCommandEncoding.preparePrompt("already done "))
        assertEquals("\$example-skill next", BridgeSshCommandEncoding.preparePrompt("\$example-skill next"))
    }

    @Test
    fun typedSkillTriggerReplacesOnlyTheInsertedDollarAndIgnoresImeComposition() {
        val before = TextFieldValue("before after", TextRange(7, 12))
        val after = TextFieldValue("before $", TextRange(8))
        val trigger = bridgeSshSkillTrigger(before, after)
        assertEquals(TextRange(7, 8), trigger)
        assertEquals(null, bridgeSshSkillTrigger(before, after.copy(composition = TextRange(7, 8))))
        assertEquals(null, bridgeSshSkillTrigger(before, TextFieldValue("before $$", TextRange(9))))
        val state = BridgeSshCommandComposerState(initialText = before.text)
        state.replaceFieldValue(after)
        state.setSkillTrigger(trigger)
        state.insertSkill("example-skill")
        assertEquals("before \$example-skill ", state.text)
    }
    @Test
    fun encodesUtf8AndBracketedPasteWithoutImplicitEnter() {
        val text = "echo 你好\n第二行"

        assertArrayEquals(
            text.toByteArray(StandardCharsets.UTF_8),
            BridgeSshCommandEncoding.utf8(text),
        )
        assertArrayEquals(
            (BridgeSshCommandEncoding.BRACKETED_PASTE_START + text +
                BridgeSshCommandEncoding.BRACKETED_PASTE_END).toByteArray(StandardCharsets.UTF_8),
            BridgeSshCommandEncoding.bracketedPaste(text),
        )
        assertFalse(
            BridgeSshCommandEncoding.bracketedPaste(text).contentEquals(
                (BridgeSshCommandEncoding.BRACKETED_PASTE_START + text +
                    BridgeSshCommandEncoding.BRACKETED_PASTE_END + "\r")
                    .toByteArray(StandardCharsets.UTF_8),
            ),
        )
        assertArrayEquals(byteArrayOf('\r'.code.toByte()), BridgeSshCommandEncoding.enter())
    }

    @Test
    fun tmuxDetachUsesTerminalControlBytesInsteadOfShellText() {
        assertArrayEquals(
            byteArrayOf(0x02.toByte(), 'd'.code.toByte()),
            BridgeSshCommandEncoding.tmuxDetach(),
        )
    }

    @Test
    fun submitPreservesDraftUntilTransportWritesAndThenRecordsHistory() {
        val state = BridgeSshCommandComposerState(initialText = "echo 你好")
        var received: BridgeSshCommandSubmission? = null
        var complete: ((BridgeSshCommandSendResult) -> Unit)? = null

        assertTrue(state.submit { submission, done -> received = submission; complete = done })

        assertEquals("echo 你好", received?.text)
        assertArrayEquals("echo 你好".toByteArray(StandardCharsets.UTF_8), received?.utf8)
        assertEquals("echo 你好", state.text)
        assertTrue(state.isSending)
        assertTrue(state.history.isEmpty())

        complete!!(BridgeSshCommandSendResult.Written)
        assertEquals(listOf("echo 你好"), state.history)
        assertEquals("", state.text)
        assertFalse(state.isSending)
        assertEquals(BridgeSshCommandSendResult.Written, state.feedback)
    }

    @Test
    fun blankTextIsNotSentOrStored() {
        val state = BridgeSshCommandComposerState(initialText = "  \n")
        var sendCount = 0

        assertFalse(state.submit { _, _ -> sendCount += 1 })

        assertEquals(0, sendCount)
        assertTrue(state.history.isEmpty())
        assertEquals("  \n", state.text)
    }

    @Test
    fun historyRestoresDraftWhenMovingPastNewestEntry() {
        val state = BridgeSshCommandComposerState()
        state.replaceText("first")
        state.submit { _, done -> done(BridgeSshCommandSendResult.Written) }
        state.replaceText("draft")
        state.submit { _, done -> done(BridgeSshCommandSendResult.Written) }
        state.replaceText("new draft")

        assertEquals("draft", state.previousHistory())
        assertEquals("first", state.previousHistory())
        assertEquals("draft", state.nextHistory())
        assertEquals("new draft", state.nextHistory())
        assertEquals("new draft", state.text)
    }

    @Test
    fun historyIsBoundedToConfiguredSize() {
        val state = BridgeSshCommandComposerState(maxHistoryEntries = 2)
        listOf("one", "two", "three").forEach { command ->
            state.replaceText(command)
            assertTrue(state.submit { _, done -> done(BridgeSshCommandSendResult.Written) })
        }

        assertEquals(listOf("two", "three"), state.history)
    }

    @Test
    fun failedAndUnknownWritesKeepDraftWithoutAddingToHistory() {
        val state = BridgeSshCommandComposerState(initialText = "你好")
        listOf(BridgeSshCommandSendResult.NotSent, BridgeSshCommandSendResult.Unknown).forEach { result ->
            assertTrue(state.submit { _, done -> done(result) })
            assertEquals("你好", state.text)
            assertEquals(result, state.feedback)
            assertFalse(state.isSending)
            assertTrue(state.history.isEmpty())
        }
    }

    @Test
    fun restoredUnknownSendIsShownUntilUserTriesAgain() {
        val state = BridgeSshCommandComposerState(initialText = "retained", initialSendUncertain = true)
        assertEquals(BridgeSshCommandSendResult.Unknown, state.feedback)
        state.replaceText("edited")
        assertEquals(BridgeSshCommandSendResult.Unknown, state.feedback)
        state.submit { _, done -> done(BridgeSshCommandSendResult.NotSent) }
        assertEquals(BridgeSshCommandSendResult.NotSent, state.feedback)
        assertEquals("edited", state.text)
    }

    @Test
    fun synchronousTransportExceptionHasUnknownOutcomeAndKeepsDraft() {
        val state = BridgeSshCommandComposerState(initialText = "keep me")
        assertTrue(state.submit { _, _ -> error("transport failed") })
        assertEquals("keep me", state.text)
        assertEquals(BridgeSshCommandSendResult.Unknown, state.feedback)
        assertFalse(state.isSending)
    }

    @Test
    fun editsMadeDuringSendAreNotClearedByCompletion() {
        val persisted = mutableListOf<String>()
        val state = BridgeSshCommandComposerState(initialText = "first", onDraftChanged = { persisted.add(it) })
        var complete: ((BridgeSshCommandSendResult) -> Unit)? = null
        assertTrue(state.submit { _, done -> complete = done })
        state.replaceText("second")
        assertFalse(state.submit { _, _ -> error("concurrent send") })

        complete!!(BridgeSshCommandSendResult.Written)

        assertEquals("second", state.text)
        assertEquals(listOf("first"), state.history)
        assertEquals(listOf("second"), persisted)
    }

    @Test
    fun returningToSameTextDoesNotClearANewerDraft() {
        val state = BridgeSshCommandComposerState(initialText = "same")
        var complete: ((BridgeSshCommandSendResult) -> Unit)? = null
        state.submit { _, done -> complete = done }
        state.replaceText("other")
        state.replaceText("same")

        complete!!(BridgeSshCommandSendResult.Written)
        assertEquals("same", state.text)
    }

    @Test
    fun lateCompletionOfDetachedEditorDoesNotOverwriteSavedDraft() {
        val saved = mutableListOf<String>()
        val state = BridgeSshCommandComposerState(initialText = "old", onDraftChanged = { saved.add(it) })
        var complete: ((BridgeSshCommandSendResult) -> Unit)? = null
        state.submit { _, done -> complete = done }
        state.detachEditor()
        saved.add("new draft from reopened session")

        complete!!(BridgeSshCommandSendResult.Written)

        assertEquals("old", state.text)
        assertEquals(listOf("new draft from reopened session"), saved)
    }

    @Test
    fun fieldValueRetainsImeCompositionAndSelection() {
        val state = BridgeSshCommandComposerState()
        val composing = TextFieldValue("中文", selection = TextRange(1), composition = TextRange(0, 1))
        state.replaceFieldValue(composing)
        assertEquals(composing, state.fieldValue)

        val moved = composing.copy(selection = TextRange(2))
        state.replaceFieldValue(moved)
        assertEquals(moved, state.fieldValue)
    }

    @Test
    fun staleCompletionCannotCompleteAnotherSend() {
        val state = BridgeSshCommandComposerState(initialText = "one")
        var first: ((BridgeSshCommandSendResult) -> Unit)? = null
        var second: ((BridgeSshCommandSendResult) -> Unit)? = null
        state.submit { _, done -> first = done }
        first!!(BridgeSshCommandSendResult.NotSent)
        state.replaceText("two")
        state.submit { _, done -> second = done }

        first!!(BridgeSshCommandSendResult.Written)
        assertTrue(state.isSending)
        assertEquals("two", state.text)
        second!!(BridgeSshCommandSendResult.Written)
        assertFalse(state.isSending)
        assertEquals("", state.text)
        assertEquals(listOf("two"), state.history)
    }

    @Test
    fun attachmentOnlySubmissionCanBeEnabledByHost() {
        val state = BridgeSshCommandComposerState()
        assertTrue(state.submit(allowEmptyText = true) { submission, done ->
            assertEquals("", submission.text)
            done(BridgeSshCommandSendResult.Written)
        })
        assertTrue(state.history.isEmpty())
    }
}
