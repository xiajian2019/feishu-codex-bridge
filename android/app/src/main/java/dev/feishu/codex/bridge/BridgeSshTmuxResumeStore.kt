package dev.feishu.codex.bridge

import android.content.Context
import android.content.SharedPreferences
import java.security.MessageDigest

internal data class BridgeSshTmuxIdentity(val id: String, val createdAt: Long) {
    fun matches(session: BridgeSshTmuxSession): Boolean = id == session.id && createdAt == session.createdAt
    companion object {
        fun of(session: BridgeSshTmuxSession) = BridgeSshTmuxIdentity(session.id, session.createdAt)
    }
}

/** Only the last tmux identity is persisted; SSH credentials are never stored here. */
internal class BridgeSshTmuxResumeStore(private val preferences: SharedPreferences) {
    constructor(context: Context) : this(context.applicationContext.getSharedPreferences("bridge_ssh_tmux_resume", Context.MODE_PRIVATE))

    fun save(key: BridgeSshAppConnectionKey, target: BridgeSshTmuxSession) {
        if (!validId(target.id) || target.createdAt < 0) return
        preferences.edit().putString(preferenceKey(key), "${target.id}:${target.createdAt}").apply()
    }

    fun load(key: BridgeSshAppConnectionKey): BridgeSshTmuxIdentity? {
        val value = preferences.getString(preferenceKey(key), null) ?: return null
        val id = value.substringBefore(':')
        val createdAt = value.substringAfter(':', "").toLongOrNull() ?: return null
        return if (validId(id) && createdAt >= 0) BridgeSshTmuxIdentity(id, createdAt) else null
    }

    fun clear(key: BridgeSshAppConnectionKey) { preferences.edit().remove(preferenceKey(key)).apply() }

    private fun preferenceKey(key: BridgeSshAppConnectionKey): String {
        val identity = "${key.host}\u0000${key.port}\u0000${key.username}".toByteArray(Charsets.UTF_8)
        return MessageDigest.getInstance("SHA-256").digest(identity).joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    private fun validId(id: String): Boolean = id.length > 1 && id[0] == '$' && id.drop(1).all(Char::isDigit)
}
