package dev.feishu.codex.bridge

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class BridgeSshKeyRecordsTest {
    @Test
    fun malformedVaultIsNeverRewrittenByImportOrDeletion() {
        for (broken in listOf("{broken-json", """[{"id":"old"},null]""")) {
            for (remove in listOf(false, true)) {
                var stored = broken
                var transformCalled = false
                try {
                    stored = BridgeSshKeyRecords.rewrite(stored) { records ->
                        transformCalled = true
                        if (remove) records.filterNot { it.optString("id") == "old" }
                        else records + JSONObject().put("id", "new")
                    }
                    throw AssertionError("Expected corrupt vault to reject mutation")
                } catch (_: IllegalStateException) {
                    assertFalse(transformCalled)
                    assertEquals(broken, stored)
                }
            }
        }
    }

    @Test
    fun rewritePreservesUnrelatedMetadata() {
        val raw = """[{"id":"old","futureField":"keep"}]"""
        val updated = BridgeSshKeyRecords.rewrite(raw) { it + JSONObject().put("id", "new") }
        val records = BridgeSshKeyRecords.parse(updated)
        assertEquals(2, records.size)
        assertEquals("keep", records.first().getString("futureField"))
    }
}
