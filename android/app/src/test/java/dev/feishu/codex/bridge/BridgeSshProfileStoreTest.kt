package dev.feishu.codex.bridge

import android.content.SharedPreferences
import java.util.Collections
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeSshProfileStoreTest {
    @Test
    fun temporaryIdentityDoesNotEraseOrChangeTheSavedHostAssociation() {
        val associated = BridgeSshIdentitySelection().useStoredKey("saved-key")
        val temporary = associated.useTemporaryKey()
        assertEquals("saved-key", temporary.profileKeyId)
        assertNull(temporary.activeStoredKeyId)
        assertEquals("saved-key", temporary.restoreSavedKey().activeStoredKeyId)
        val store = BridgeSshProfileStore(InMemorySharedPreferences())
        val original = profile(keyId = "saved-key")
        store.save(original, now = 200L)
        store.save(original.copy(keyId = temporary.profileKeyId.orEmpty()), now = 300L)
        assertEquals("saved-key", store.list().single().keyId)

        val newAssociation = temporary.useStoredKey("another-key")
        assertEquals("another-key", newAssociation.profileKeyId)
        assertEquals("another-key", newAssociation.activeStoredKeyId)
        assertNull(newAssociation.withoutKey().profileKeyId)
        assertNull(newAssociation.withoutKey().activeStoredKeyId)
        assertNull(BridgeSshIdentitySelection().useTemporaryKey().profileKeyId)
    }

    @Test
    fun equivalentConnectionRequiresSameKeyAndStartupCommand() {
        val saved = profile(startupCommand = "tmux attach -t work")
        assertTrue(saved.matchesConnection("192.0.2.10", 22, "testuser", "bridge-rsa-3072", "tmux attach -t work"))
        assertFalse(saved.matchesConnection("192.0.2.10", 22, "testuser", "", "tmux attach -t work"))
        assertFalse(saved.matchesConnection("192.0.2.10", 22, "testuser", "bridge-rsa-3072", ""))
        assertFalse(saved.matchesConnection("192.0.2.10", 2222, "testuser", "bridge-rsa-3072", "tmux attach -t work"))
    }

    @Test
    fun savesListsAndSortsByLastUsedThenCreated() {
        val preferences = InMemorySharedPreferences()
        val store = BridgeSshProfileStore(preferences)
        val older = profile(id = "older", label = "Mac", createdAt = 100L)
        val newer = profile(id = "newer", label = "Mac 2", createdAt = 200L)
        val used = profile(id = "used", label = "Mac 3", createdAt = 50L, lastUsedAt = 300L)

        store.save(older, now = 400L)
        store.save(newer, now = 400L)
        store.save(used, now = 400L)

        assertEquals(listOf("used", "newer", "older"), store.list().map { it.id })
        assertEquals("192.0.2.10", store.list()[0].host)
        assertEquals(22, store.list()[0].port)
        assertEquals("testuser", store.list()[0].username)
        assertEquals("bridge-rsa-3072", store.list()[0].keyId)
    }

    @Test
    fun savingExistingIdUpdatesMetadataAndPreservesCreationAndLastUse() {
        val store = BridgeSshProfileStore(InMemorySharedPreferences())
        val original = profile(id = "same", label = "Old label", createdAt = 100L, lastUsedAt = 300L)
        store.save(original, now = 400L)

        val updated = store.save(
            original.copy(
                label = "New label",
                host = "example.com",
                createdAt = 999L,
                lastUsedAt = 0L,
            ),
            now = 500L,
        )

        assertEquals("New label", updated.label)
        assertEquals("example.com", updated.host)
        assertEquals(100L, updated.createdAt)
        assertEquals(300L, updated.lastUsedAt)
        assertEquals(1, store.list().size)
    }

    @Test
    fun markUsedUpdatesTimestampAndDeleteRemovesOnlyRequestedProfile() {
        val store = BridgeSshProfileStore(InMemorySharedPreferences())
        store.save(profile(id = "first", label = "First", createdAt = 100L), now = 400L)
        store.save(profile(id = "second", label = "Second", createdAt = 200L), now = 400L)

        assertNotNull(store.markUsed("first", at = 500L))
        assertEquals(listOf("first", "second"), store.list().map { it.id })
        assertEquals(500L, store.list().first().lastUsedAt)
        assertTrue(store.delete("first"))
        assertFalse(store.delete("first"))
        assertEquals(listOf("second"), store.list().map { it.id })
        assertNull(store.markUsed("missing", at = 600L))
    }

    @Test
    fun serializedRecordContainsNoPasswordAndOnlyConnectionMetadata() {
        val preferences = InMemorySharedPreferences()
        val store = BridgeSshProfileStore(preferences)

        store.save(
            profile(
                id = "safe",
                label = "Safe",
                startupCommand = "tmux attach -t work",
                createdAt = 100L,
            ),
            now = 200L,
        )

        val serialized = preferences.getString("records", "")
        assertNotNull(serialized)
        assertTrue(serialized!!.contains("startupCommand"))
        assertFalse(serialized.contains("password"))
        assertFalse(serialized.contains("super-secret"))
    }

    @Test
    fun rejectsInvalidBoundaries() {
        val store = BridgeSshProfileStore(InMemorySharedPreferences())

        assertIllegalArgument { store.save(profile(label = " "), now = 100L) }
        assertIllegalArgument { store.save(profile(host = "bad host"), now = 100L) }
        assertIllegalArgument { store.save(profile(port = 0), now = 100L) }
        assertIllegalArgument { store.save(profile(port = 65_536), now = 100L) }
        assertIllegalArgument { store.save(profile(username = "user\nname"), now = 100L) }
        assertIllegalArgument { store.save(profile(startupCommand = "bad\u0000command"), now = 100L) }
        assertIllegalArgument { store.delete(" ") }
        assertIllegalArgument { store.markUsed("id", at = 0L) }
    }

    @Test
    fun ignoresMalformedRecordsWhenListing() {
        val preferences = InMemorySharedPreferences()
        preferences.edit().putString("records", "[{\"id\":\"broken\",\"port\":0}]").commit()

        assertTrue(BridgeSshProfileStore(preferences).list().isEmpty())
    }

    private fun profile(
        id: String = "profile-id",
        label: String = "Mac",
        host: String = "192.0.2.10",
        port: Int = 22,
        username: String = "testuser",
        keyId: String = "bridge-rsa-3072",
        startupCommand: String = "",
        createdAt: Long = 100L,
        lastUsedAt: Long = 0L,
    ) = BridgeSshProfile(
        id = id,
        label = label,
        host = host,
        port = port,
        username = username,
        keyId = keyId,
        startupCommand = startupCommand,
        createdAt = createdAt,
        lastUsedAt = lastUsedAt,
    )

    private fun assertIllegalArgument(block: () -> Unit) {
        try {
            block()
        } catch (_: IllegalArgumentException) {
            return
        }
        throw AssertionError("Expected IllegalArgumentException")
    }

    private class InMemorySharedPreferences : SharedPreferences {
        private val values = linkedMapOf<String, Any?>()

        override fun getAll(): Map<String, *> = Collections.unmodifiableMap(values)

        override fun getString(key: String, defValue: String?): String? =
            values[key] as? String ?: defValue

        @Suppress("UNCHECKED_CAST")
        override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? =
            (values[key] as? Set<String>)?.toMutableSet() ?: defValues

        override fun getInt(key: String, defValue: Int): Int = values[key] as? Int ?: defValue

        override fun getLong(key: String, defValue: Long): Long = values[key] as? Long ?: defValue

        override fun getFloat(key: String, defValue: Float): Float =
            values[key] as? Float ?: defValue

        override fun getBoolean(key: String, defValue: Boolean): Boolean =
            values[key] as? Boolean ?: defValue

        override fun contains(key: String): Boolean = values.containsKey(key)

        override fun edit(): SharedPreferences.Editor = Editor()

        override fun registerOnSharedPreferenceChangeListener(
            listener: SharedPreferences.OnSharedPreferenceChangeListener,
        ) = Unit

        override fun unregisterOnSharedPreferenceChangeListener(
            listener: SharedPreferences.OnSharedPreferenceChangeListener,
        ) = Unit

        private inner class Editor : SharedPreferences.Editor {
            private val pending = linkedMapOf<String, Any?>()
            private val removals = linkedSetOf<String>()
            private var clear = false

            override fun putString(key: String, value: String?): SharedPreferences.Editor {
                pending[key] = value
                removals.remove(key)
                return this
            }

            override fun putStringSet(
                key: String,
                values: MutableSet<String>?,
            ): SharedPreferences.Editor {
                pending[key] = values?.toMutableSet()
                removals.remove(key)
                return this
            }

            override fun putInt(key: String, value: Int): SharedPreferences.Editor {
                pending[key] = value
                removals.remove(key)
                return this
            }

            override fun putLong(key: String, value: Long): SharedPreferences.Editor {
                pending[key] = value
                removals.remove(key)
                return this
            }

            override fun putFloat(key: String, value: Float): SharedPreferences.Editor {
                pending[key] = value
                removals.remove(key)
                return this
            }

            override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor {
                pending[key] = value
                removals.remove(key)
                return this
            }

            override fun remove(key: String): SharedPreferences.Editor {
                removals += key
                pending.remove(key)
                return this
            }

            override fun clear(): SharedPreferences.Editor {
                clear = true
                pending.clear()
                removals.clear()
                return this
            }

            override fun commit(): Boolean {
                if (clear) values.clear()
                removals.forEach(values::remove)
                values.putAll(pending)
                return true
            }

            override fun apply() {
                commit()
            }
        }
    }
}
