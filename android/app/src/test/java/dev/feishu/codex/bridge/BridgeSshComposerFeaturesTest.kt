package dev.feishu.codex.bridge

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeSshComposerFeaturesTest {
    @Test
    fun skillMetadataParsingUsesValidNamesAndMultilineDescriptions() {
        assertEquals(BridgeSshSkill("skill-a", "第一行 第二行"), BridgeSshRemoteSkills.parseSkill(
            "---\nname: skill-a\ndescription_zh: >\n  第一行\n  第二行\n---\nbody",
        ))
        assertEquals(BridgeSshSkill("skill-b", "English"), BridgeSshRemoteSkills.parseSkill(
            "---\nname: 'skill-b'\ndescription: \"English\"\n---\nbody",
        ))
        assertNull(BridgeSshRemoteSkills.parseSkill("---\nname: ../unsafe\n---"))
        assertNull(BridgeSshRemoteSkills.parseSkill("name: missing frontmatter"))
    }

    @Test
    fun catalogRespectsSyncedOrderingEnabledStateAndLocalUsage() {
        val payload = JSONObject().put("groups", JSONArray()
            .put(JSONObject().put("id", "favorites").put("surface", "palette").put("enabled", true))
            .put(JSONObject().put("id", "keyboard").put("surface", "palette").put("enabled", true))
            .put(JSONObject().put("id", "composer").put("surface", "composer").put("enabled", true)))
            .put("shortcuts", JSONArray()
                .put(JSONObject().put("id", "first").put("groupId", "keyboard").put("title", "F1").put("enabled", true).put("sortOrder", 3).put("operationCount", 2))
                .put(JSONObject().put("id", "second").put("groupId", "keyboard").put("title", "F2").put("enabled", true).put("sortOrder", 4).put("operationCount", 1))
                .put(JSONObject().put("id", "disabled").put("groupId", "keyboard").put("enabled", false))
                .put(JSONObject().put("id", "toolbar").put("groupId", "composer").put("enabled", true).put("displayMode", "expanded")))
        val catalog = BridgeSshShortcutCatalog.fromJson(payload, emptyMap())
        assertEquals(listOf("second", "first"), catalog.paletteItems("favorites", mapOf("second" to 5)).map { it.id })
        assertEquals(listOf("first", "second"), catalog.paletteItems("keyboard").map { it.id })
        assertTrue(catalog.toolbar(false).isEmpty())
        assertEquals(listOf("toolbar"), catalog.toolbar(true).map { it.id })
    }

    @Test
    fun remoteFileNamesRejectTraversalAndControlCharacters() {
        assertTrue(BridgeSshRemoteFiles.validName("文档 1.txt"))
        assertFalse(BridgeSshRemoteFiles.validName(".."))
        assertFalse(BridgeSshRemoteFiles.validName("a/b"))
        assertFalse(BridgeSshRemoteFiles.validName("bad\nname"))
    }

    @Test
    fun diagnosticExportContainsCountsButNotTerminalContents() {
        val diagnostics = BridgeSshDiagnostics()
        diagnostics.start()
        repeat(600) { diagnostics.record("output", 12) }
        val result = JSONObject(diagnostics.finish(JSONObject().put("rows", 24)).toString(Charsets.UTF_8))
        assertEquals(500, result.getJSONArray("events").length())
        assertFalse(result.toString().contains("secret terminal text"))
    }
}
