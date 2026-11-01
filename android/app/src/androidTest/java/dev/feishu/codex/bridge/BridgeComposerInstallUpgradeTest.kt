package dev.feishu.codex.bridge

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters

/** Can be run in two phases with an APK update between the two methods. */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class BridgeComposerInstallUpgradeTest {
    private val context: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val databaseName = "composer-install-upgrade-test.db"

    @Test
    fun test1WriteBeforeInstall() {
        context.deleteDatabase(databaseName)
        BridgeComposerDatabase(context, databaseName).use { database ->
            database.activate("install-upgrade-test")
            val group = JSONObject().put("id", "composer")
            val item = JSONObject().put("id", "custom").put("groupId", "composer")
                .put("title", "更新后保留").put("value", "Ctrl+L").put("operationCount", 17)
            val payload = JSONObject().put("groups", JSONArray().put(group)).put("shortcuts", JSONArray().put(item))
            database.saveActive("install-upgrade-test", listOf(BridgeComposerSnapshot(BridgeComposerDatabase.SHORTCUTS, "", payload)))
        }
    }

    @Test
    fun test2ReadAfterInstall() {
        try {
            BridgeComposerDatabase(context, databaseName).use { database ->
                val item = database.readActive(BridgeComposerDatabase.SHORTCUTS)!!
                    .payload.getJSONArray("shortcuts").getJSONObject(0)
                assertEquals("更新后保留", item.getString("title"))
                assertEquals("Ctrl+L", item.getString("value"))
                assertEquals(17, item.getInt("operationCount"))
            }
        } finally {
            context.deleteDatabase(databaseName)
        }
    }
}
