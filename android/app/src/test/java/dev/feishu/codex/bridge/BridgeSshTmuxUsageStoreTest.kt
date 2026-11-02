package dev.feishu.codex.bridge

import android.content.SharedPreferences
import java.lang.reflect.Proxy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class BridgeSshTmuxUsageStoreTest {
    private fun session(id: String, name: String, createdAt: Long) =
        BridgeSshTmuxSession(id, name, 1, false, "/repo", createdAt)

    private fun preferences(values: MutableMap<String, String>): SharedPreferences {
        lateinit var editor: SharedPreferences.Editor
        editor = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(SharedPreferences.Editor::class.java)) { _, method, args ->
            when (method.name) {
                "putString" -> { values[args!![0] as String] = args[1] as String; editor }
                "apply" -> Unit
                else -> throw AssertionError("Unexpected editor operation: ${method.name}")
            }
        } as SharedPreferences.Editor
        return Proxy.newProxyInstance(javaClass.classLoader, arrayOf(SharedPreferences::class.java)) { _, method, args ->
            when (method.name) {
                "getString" -> values[args!![0] as String] ?: args[1]
                "edit" -> editor
                else -> throw AssertionError("Unexpected preference operation: ${method.name}")
            }
        } as SharedPreferences
    }

    @Test
    fun sortsByCountThenRecentOpenThenCreationAndPersistsAcrossStoreInstances() {
        val values = mutableMapOf<String, String>()
        val prefs = preferences(values)
        val store = BridgeSshTmuxUsageStore(prefs)
        val key = BridgeSshAppConnectionKey.of("host.test", 22, "user")
        val oldest = session("\$1", "zeta", 100)
        val middle = session("\$2", "alpha", 200)
        val newest = session("\$3", "beta", 300)
        val sessions = listOf(oldest, middle, newest)

        assertEquals(listOf(newest, middle, oldest), store.sort(key, sessions))
        store.recordOpen(key, oldest, 1000)
        store.recordOpen(key, oldest, 1010)
        store.recordOpen(key, middle, 1020)
        store.recordOpen(key, newest, 1030)
        assertEquals(listOf(oldest, newest, middle), store.sort(key, sessions))
        assertEquals(listOf(oldest, newest, middle), BridgeSshTmuxUsageStore(prefs).sort(key, sessions))
        assertFalse(values.keys.any { it.contains("host.test") || it.contains("user") })
    }

    @Test
    fun usageFollowsRenameButDoesNotLeakAcrossHostsUsersPortsOrRecreatedSessions() {
        val store = BridgeSshTmuxUsageStore(preferences(mutableMapOf()))
        val key = BridgeSshAppConnectionKey.of("host.test", 22, "user")
        val original = session("\$1", "old-name", 100)
        val renamed = original.copy(name = "new-name")
        val newer = session("\$2", "other", 200)
        store.recordOpen(key, original, 1000)

        assertEquals(listOf(renamed, newer), store.sort(key, listOf(newer, renamed)))
        for (otherKey in listOf(
            BridgeSshAppConnectionKey.of("other.test", 22, "user"),
            BridgeSshAppConnectionKey.of("host.test", 23, "user"),
            BridgeSshAppConnectionKey.of("host.test", 22, "other"),
        )) {
            assertEquals(listOf(newer, renamed), store.sort(otherKey, listOf(renamed, newer)))
        }
        val recreated = original.copy(createdAt = 150)
        assertEquals(listOf(newer, recreated), store.sort(key, listOf(recreated, newer)))
    }
}
