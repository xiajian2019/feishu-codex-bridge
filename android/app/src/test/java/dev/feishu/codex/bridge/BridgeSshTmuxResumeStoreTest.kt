package dev.feishu.codex.bridge

import android.content.SharedPreferences
import java.lang.reflect.Proxy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeSshTmuxResumeStoreTest {
    @Test
    fun remembersOnlyTheSessionIdentityForTheSameHostAndRejectsRecreatedSessions() {
        val values = mutableMapOf<String, String>()
        lateinit var editor: SharedPreferences.Editor
        editor = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(SharedPreferences.Editor::class.java)) { _, method, args ->
            when (method.name) {
                "putString" -> { values[args!![0] as String] = args[1] as String; editor }
                "remove" -> { values.remove(args!![0] as String); editor }
                "apply" -> Unit
                else -> throw AssertionError("Unexpected editor operation: ${method.name}")
            }
        } as SharedPreferences.Editor
        val preferences = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(SharedPreferences::class.java)) { _, method, args ->
            when (method.name) {
                "getString" -> values[args!![0] as String] ?: args[1]
                "edit" -> editor
                else -> throw AssertionError("Unexpected preference operation: ${method.name}")
            }
        } as SharedPreferences
        val store = BridgeSshTmuxResumeStore(preferences)
        val key = BridgeSshAppConnectionKey.of("host.test", 22, "user")
        val session = BridgeSshTmuxSession("\$5", "private-name", 1, true, "/private/path", 123)
        store.save(key, session)
        val target = store.load(key)!!
        assertTrue(target.matches(session))
        assertFalse(target.matches(session.copy(createdAt = 124)))
        assertNull(store.load(BridgeSshAppConnectionKey.of("other.test", 22, "user")))
        assertEquals("\$5:123", values.values.single())
        assertFalse(values.keys.single().contains("host.test"))
        store.clear(key)
        assertNull(store.load(key))
    }
}
