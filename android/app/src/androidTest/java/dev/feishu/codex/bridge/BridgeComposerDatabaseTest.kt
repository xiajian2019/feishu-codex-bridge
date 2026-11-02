package dev.feishu.codex.bridge

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class BridgeComposerDatabaseTest {
    private lateinit var context: Context
    private lateinit var databaseName: String

    @Before
    fun setUp() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
        databaseName = "composer-test-${UUID.randomUUID()}.db"
    }

    @After
    fun tearDown() {
        context.deleteDatabase(databaseName)
    }

    @Test
    fun reopeningAndUnsupportedUpgradePreserveExistingData() {
        BridgeComposerDatabase(context, databaseName).use { database ->
            database.activate("source-a")
            database.saveActive("source-a", listOf(shortcutSnapshot("自定义")))
        }
        BridgeComposerDatabase(context, databaseName).use { database ->
            assertEquals("自定义", title(database.readActive(BridgeComposerDatabase.SHORTCUTS)))
        }
        BridgeComposerDatabase(context, databaseName, 2).use { database ->
            assertThrows(IllegalStateException::class.java) { database.writableDatabase }
        }
        BridgeComposerDatabase(context, databaseName).use { database ->
            assertEquals("自定义", title(database.readActive(BridgeComposerDatabase.SHORTCUTS)))
        }
    }

    @Test
    fun sourcesStayIsolatedAndAnOldWriteCannotReplaceTheActiveSource() {
        BridgeComposerDatabase(context, databaseName).use { database ->
            database.activate("source-a")
            database.saveActive("source-a", listOf(shortcutSnapshot("A")))
            database.activate("source-b")
            assertNull(database.readActive(BridgeComposerDatabase.SHORTCUTS))
            database.saveActive("source-b", listOf(shortcutSnapshot("B")))
            assertThrows(IllegalStateException::class.java) {
                database.saveActive("source-a", listOf(shortcutSnapshot("迟到")))
            }
            assertEquals("B", title(database.readActive(BridgeComposerDatabase.SHORTCUTS)))
            database.deactivate("source-a", null)
            database.deactivate(null, "source-b")
            assertEquals("B", title(database.readActive(BridgeComposerDatabase.SHORTCUTS)))
            database.deactivate(null, "source-c")
            assertNull(database.readActive(BridgeComposerDatabase.SHORTCUTS))
            database.activate("source-b")
            database.clearScope("source-a")
            assertEquals("B", title(database.readActive(BridgeComposerDatabase.SHORTCUTS)))
            database.activate("source-a")
            assertNull(database.readActive(BridgeComposerDatabase.SHORTCUTS))
        }
    }

    @Test
    fun invalidPartialDataCannotOverwriteTheLastCompleteSnapshot() {
        BridgeComposerDatabase(context, databaseName).use { database ->
            database.activate("source-a")
            database.saveActive("source-a", listOf(shortcutSnapshot("保留")))
            val invalid = BridgeComposerSnapshot(BridgeComposerDatabase.SKILLS, "", JSONObject().put("skills", "bad"))
            assertThrows(Exception::class.java) {
                database.saveActive("source-a", listOf(shortcutSnapshot("不应写入"), invalid))
            }
            assertEquals("保留", title(database.readActive(BridgeComposerDatabase.SHORTCUTS)))
        }
    }

    @Test
    fun nativeUsageSurvivesReopenAndServerSnapshotRefresh() {
        BridgeComposerDatabase(context, databaseName).use { database ->
            database.recordShortcutUse("offline", null)
            assertEquals(1L, database.readShortcutUsage()["offline"])
            database.activate("source-a")
            database.saveActive("source-a", listOf(shortcutSnapshot("A")))
            database.recordShortcutUse("custom", "source-a")
            database.recordShortcutUse("custom", "source-a")
            database.saveActive("source-a", listOf(shortcutSnapshot("updated")))
        }
        BridgeComposerDatabase(context, databaseName).use { database ->
            assertEquals(2L, database.readShortcutUsage()["custom"])
            assertEquals("updated", title(database.readActive(BridgeComposerDatabase.SHORTCUTS)))
            val loaded = database.readShortcutState()
            assertEquals("source-a", loaded.source)
            assertEquals(2L, loaded.usage["custom"])
            assertEquals("updated", title(loaded.snapshot))
            database.activate("source-b")
            assertThrows(IllegalStateException::class.java) { database.recordShortcutUse("custom", "source-a") }
            assertTrue(database.readShortcutUsage().isEmpty())
            database.activate("source-a")
            database.deactivate("source-a", null)
            assertEquals(1L, database.readShortcutUsage()["offline"])
        }
    }

    private fun shortcutSnapshot(title: String): BridgeComposerSnapshot {
        val group = JSONObject().put("id", "composer").put("title", "输入框")
        val shortcut = JSONObject().put("id", "custom").put("groupId", "composer").put("title", title)
            .put("value", "Ctrl+L").put("operationCount", 17)
        return BridgeComposerSnapshot(
            BridgeComposerDatabase.SHORTCUTS, "",
            JSONObject().put("groups", JSONArray().put(group)).put("shortcuts", JSONArray().put(shortcut)),
        )
    }

    private fun title(snapshot: BridgeComposerSnapshot?): String? =
        snapshot?.payload?.getJSONArray("shortcuts")?.getJSONObject(0)?.getString("title")
}
