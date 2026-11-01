package dev.feishu.codex.bridge

import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class BridgeSshComposerDraftStoreTest {
    @get:Rule val temporaryFolder = TemporaryFolder()

    private class MemoryPreferences : BridgeSshDraftPreferences {
        val values = mutableMapOf<String, String>()
        val synchronousWrites = mutableListOf<String>()
        var failSynchronousWrites = false

        override fun get(scope: String): String? = values[scope]

        override fun set(scope: String, value: String?, synchronous: Boolean): Boolean {
            if (synchronous) {
                synchronousWrites.add(scope)
                if (failSynchronousWrites) return false
            }
            if (value == null) values.remove(scope) else values[scope] = value
            return true
        }
    }

    private fun shell(host: String = "example.com", user: String = "alice") =
        BridgeSshComposerDraftStore.scopeKey(host, 22, user, null)

    @Test
    fun scopeSeparatesShellHostsAccountsAndTmuxSessionLifetimes() {
        val shellScope = shell()
        val tmux = BridgeSshComposerDraftStore.scopeKey("example.com", 22, "alice", "ssh-shell", 42)
        assertEquals(shellScope, shell("EXAMPLE.COM"))
        assertNotEquals(shellScope, shell("another.example.com"))
        assertNotEquals(shellScope, shell(user = "bob"))
        assertNotEquals(shellScope, tmux)
        assertNotEquals(tmux, BridgeSshComposerDraftStore.scopeKey("example.com", 22, "alice", "ssh-shell", 43))
        assertNotEquals(tmux, BridgeSshComposerDraftStore.scopeKey("example.com", 22, "alice", "another", 42))
        assertThrows(IllegalArgumentException::class.java) {
            BridgeSshComposerDraftStore.scopeKey("example.com", 22, "alice", "session-without-creation-time")
        }
    }

    @Test
    fun metadataUpdatesDoNotLeakAcrossScopesOrLoseOtherFields() {
        val preferences = MemoryPreferences()
        val store = BridgeSshComposerDraftStore(preferences, temporaryFolder.newFolder())
        val first = shell()
        val second = shell(user = "bob")
        val attachment = BridgeSshDraftAttachment(UUID.randomUUID().toString(), "文档.txt", "text/plain")

        store.updateText(first, "中文草稿")
        store.updateAttachments(first, listOf(attachment))
        store.updateText(second, "另一份")
        store.updateText(first, "更新")

        assertEquals(BridgeSshComposerDraft("更新", listOf(attachment)), store.load(first))
        assertEquals(BridgeSshComposerDraft("另一份"), store.load(second))
    }

    @Test
    fun malformedMetadataIsNotOverwrittenByAnyUpdate() {
        val preferences = MemoryPreferences()
        val store = BridgeSshComposerDraftStore(preferences, temporaryFolder.newFolder())
        val scope = shell()
        val corrupt = "{\"text\":\"原文\",\"attachments\":[{\"id\":\"../escape\",\"name\":\"x\"}]}"
        preferences.values[scope] = corrupt

        assertThrows(BridgeSshDraftCorruptException::class.java) { store.load(scope) }
        assertThrows(BridgeSshDraftCorruptException::class.java) { store.updateText(scope, "new") }
        assertThrows(BridgeSshDraftCorruptException::class.java) { store.updateAttachments(scope, emptyList()) }
        assertThrows(BridgeSshDraftCorruptException::class.java) { store.markPending(scope) }
        assertEquals(corrupt, preferences.values[scope])
    }

    @Test
    fun pendingIsDurablyMarkedAndPreservedAcrossOtherUpdates() {
        val preferences = MemoryPreferences()
        val store = BridgeSshComposerDraftStore(preferences, temporaryFolder.newFolder())
        val scope = shell()
        store.updateText(scope, "message")

        store.markPending(scope)
        store.updateText(scope, "edited")
        assertTrue(store.load(scope).sendUncertain)
        assertEquals(listOf(scope), preferences.synchronousWrites)

        store.clearPending(scope)
        assertFalse(store.load(scope).sendUncertain)
        assertEquals("edited", store.load(scope).text)
        assertEquals(listOf(scope, scope), preferences.synchronousWrites)
    }

    @Test
    fun failedSynchronousMarkReportsFailureAndMustPreventSend() {
        val preferences = MemoryPreferences()
        val store = BridgeSshComposerDraftStore(preferences, temporaryFolder.newFolder())
        val scope = shell()
        store.updateText(scope, "message")
        preferences.failSynchronousWrites = true

        assertThrows(IllegalStateException::class.java) { store.markPending(scope) }
        assertFalse(store.load(scope).sendUncertain)
        assertEquals("message", store.load(scope).text)
    }

    @Test
    fun stagedCopiesAreScopedAndNeverUseTheSelectedFilename() = runBlocking {
        val preferences = MemoryPreferences()
        val directory = temporaryFolder.newFolder()
        val store = BridgeSshComposerDraftStore(preferences, directory)
        val first = shell()
        val second = shell(user = "bob")
        val bytes = "中文内容".toByteArray(Charsets.UTF_8)
        val attachment = store.stageContent(first, "../../原文件.txt", "text/plain") { ByteArrayInputStream(bytes) }

        assertArrayEquals(bytes, store.fileFor(first, attachment.id).readBytes())
        assertEquals("${attachment.id}.data", store.fileFor(first, attachment.id).name)
        assertFalse(store.fileFor(second, attachment.id).exists())
        assertTrue(store.deleteLocalCopy(second, attachment.id))
        assertTrue(store.fileFor(first, attachment.id).exists())
        assertThrows(IllegalArgumentException::class.java) { store.fileFor("../outside", attachment.id) }
        assertThrows(IllegalArgumentException::class.java) { store.fileFor(first, "../outside") }
        assertTrue(store.deleteLocalCopy(first, attachment.id))
        assertFalse(store.fileFor(first, attachment.id).exists())
    }

    @Test
    fun failedCopyRemovesOnlyItsIncompleteGeneratedFile() = runBlocking {
        val directory = temporaryFolder.newFolder()
        val store = BridgeSshComposerDraftStore(MemoryPreferences(), directory)
        val scope = shell()
        val good = store.stageContent(scope, "keep.txt", "text/plain") { ByteArrayInputStream(byteArrayOf(7)) }
        val failing = object : InputStream() {
            override fun read(): Int = throw IOException("source failed")
            override fun read(bytes: ByteArray, offset: Int, length: Int): Int = throw IOException("source failed")
        }
        try {
            store.stageContent(scope, "fail.txt", "text/plain") { failing }
            throw AssertionError("expected failure")
        } catch (_: IOException) {
            // expected
        }

        assertTrue(store.fileFor(scope, good.id).exists())
        assertEquals(listOf("${good.id}.data"), store.fileFor(scope, good.id).parentFile!!.list()!!.toList())
    }
}
