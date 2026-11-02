package dev.feishu.codex.bridge

import android.content.Context
import android.content.SharedPreferences
import java.security.MessageDigest

private data class BridgeSshTmuxUsage(val count: Long, val lastOpenedAt: Long)

/** Local usage belongs to one SSH identity and one tmux session incarnation. */
internal class BridgeSshTmuxUsageStore(private val preferences: SharedPreferences) {
    constructor(context: Context) : this(
        context.applicationContext.getSharedPreferences("bridge_ssh_tmux_usage", Context.MODE_PRIVATE),
    )

    fun recordOpen(key: BridgeSshAppConnectionKey, session: BridgeSshTmuxSession, now: Long = System.currentTimeMillis()) {
        require(now >= 0)
        synchronized(lock) {
            val preferenceKey = preferenceKey(key, session)
            val previous = read(preferenceKey)
            val nextCount = if (previous.count == Long.MAX_VALUE) Long.MAX_VALUE else previous.count + 1
            preferences.edit().putString(preferenceKey, "$nextCount:$now").apply()
        }
    }

    fun sort(key: BridgeSshAppConnectionKey, sessions: List<BridgeSshTmuxSession>): List<BridgeSshTmuxSession> =
        synchronized(lock) {
            val usage = sessions.associate { session ->
                BridgeSshTmuxIdentity.of(session) to read(preferenceKey(key, session))
            }
            sessions.sortedWith(
                compareByDescending<BridgeSshTmuxSession> { usage.getValue(BridgeSshTmuxIdentity.of(it)).count }
                    .thenByDescending { usage.getValue(BridgeSshTmuxIdentity.of(it)).lastOpenedAt }
                    .thenByDescending { it.createdAt },
            )
        }

    private fun read(key: String): BridgeSshTmuxUsage {
        val value = preferences.getString(key, null) ?: return BridgeSshTmuxUsage(0, 0)
        val count = value.substringBefore(':').toLongOrNull()?.takeIf { it >= 0 } ?: 0
        val lastOpenedAt = value.substringAfter(':', "").toLongOrNull()?.takeIf { it >= 0 } ?: 0
        return BridgeSshTmuxUsage(count, lastOpenedAt)
    }

    private fun preferenceKey(key: BridgeSshAppConnectionKey, session: BridgeSshTmuxSession): String {
        val identity = "${key.host}\u0000${key.port}\u0000${key.username}\u0000${session.id}\u0000${session.createdAt}"
        return MessageDigest.getInstance("SHA-256").digest(identity.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    companion object { private val lock = Any() }
}
