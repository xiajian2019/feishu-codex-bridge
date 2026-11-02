package dev.feishu.codex.bridge

import android.content.Context
import android.content.SharedPreferences
import java.util.Locale
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/**
 * The connection details needed to open one SSH session.
 *
 * A password is deliberately not a field of this model. Passwords are
 * session-only input and must never be passed to, or written by, this store.
 */
internal data class BridgeSshProfile(
    val id: String,
    val label: String,
    val host: String,
    val port: Int,
    val username: String,
    val keyId: String,
    val startupCommand: String,
    val createdAt: Long,
    val lastUsedAt: Long,
) {
    companion object {
        fun create(
            label: String,
            host: String,
            port: Int = 22,
            username: String,
            keyId: String = "",
            startupCommand: String = "",
            createdAt: Long = System.currentTimeMillis(),
        ): BridgeSshProfile = BridgeSshProfile(
            id = UUID.randomUUID().toString(),
            label = label,
            host = host,
            port = port,
            username = username,
            keyId = keyId,
            startupCommand = startupCommand,
            createdAt = createdAt,
            lastUsedAt = 0L,
        )
    }
}

/** Only reuse an unnamed connection when doing so leaves its saved settings intact. */
internal fun BridgeSshProfile.matchesConnection(
    host: String,
    port: Int,
    username: String,
    keyId: String,
    startupCommand: String,
): Boolean = this.host == host &&
    this.port == port &&
    this.username == username &&
    this.keyId == keyId &&
    this.startupCommand == startupCommand

/** Saved host identity and the key used for this connection are distinct. */
internal data class BridgeSshIdentitySelection(
    val profileKeyId: String? = null,
    val activeStoredKeyId: String? = null,
) {
    fun useStoredKey(keyId: String): BridgeSshIdentitySelection {
        require(keyId.isNotBlank())
        return BridgeSshIdentitySelection(profileKeyId = keyId, activeStoredKeyId = keyId)
    }

    fun useTemporaryKey(): BridgeSshIdentitySelection = copy(activeStoredKeyId = null)

    fun withoutKey(): BridgeSshIdentitySelection = BridgeSshIdentitySelection()

    fun restoreSavedKey(): BridgeSshIdentitySelection = copy(activeStoredKeyId = profileKeyId)
}

/**
 * Persistent, app-local SSH profile storage.
 *
 * Only connection metadata is persisted. In particular, this API has no
 * password parameter and the JSON schema has no password field. A caller may
 * collect a password for the active SSH connection, but it must keep that
 * value outside this store and discard it when the connection ends.
 */
internal class BridgeSshProfileStore internal constructor(
    private val preferences: SharedPreferences,
) {
    constructor(context: Context) : this(
        (context.applicationContext ?: context).getSharedPreferences(
            PREFERENCES,
            Context.MODE_PRIVATE,
        ),
    )

    @Synchronized
    fun save(
        profile: BridgeSshProfile,
        now: Long = System.currentTimeMillis(),
    ): BridgeSshProfile {
        requireTimestamp(now, "now")
        val normalized = normalize(profile, now)
        val records = readRecords()
        val existing = records.firstOrNull { it.optString(KEY_ID) == normalized.id }
        val saved = normalized.copy(
            // Updating a profile must not make its creation time jump.
            createdAt = existing
                ?.optLong(KEY_CREATED_AT, normalized.createdAt)
                ?.takeIf { it > 0L }
                ?: normalized.createdAt,
            // Updating connection metadata must not erase a previous use time.
            lastUsedAt = maxOf(
                existing?.optLong(KEY_LAST_USED_AT, 0L) ?: 0L,
                normalized.lastUsedAt,
            ),
        )
        val updatedRecords = buildList(records.size + 1) {
            records.forEach { record ->
                if (record.optString(KEY_ID) != saved.id) add(record)
            }
            add(toJson(saved))
        }
        writeRecords(updatedRecords)
        return saved
    }

    @Synchronized
    fun list(): List<BridgeSshProfile> = readRecords()
        .mapNotNull(::toProfile)
        .distinctBy { it.id }
        .sortedWith(
            compareByDescending<BridgeSshProfile> { it.lastUsedAt }
                .thenByDescending { it.createdAt }
                .thenBy { it.label.lowercase(Locale.ROOT) }
                .thenBy { it.id },
        )

    @Synchronized
    fun delete(id: String): Boolean {
        val normalizedId = normalizeIdentifier(id, "id")
        val records = readRecords()
        val remaining = records.filterNot { it.optString(KEY_ID) == normalizedId }
        if (remaining.size == records.size) return false
        writeRecords(remaining)
        return true
    }

    /** Records a successful use without accepting or persisting a password. */
    @Synchronized
    fun markUsed(
        id: String,
        at: Long = System.currentTimeMillis(),
    ): BridgeSshProfile? {
        val normalizedId = normalizeIdentifier(id, "id")
        requireTimestamp(at, "at")
        val records = readRecords()
        val target = records.firstOrNull { it.optString(KEY_ID) == normalizedId } ?: return null
        val profile = toProfile(target) ?: return null
        val updated = profile.copy(lastUsedAt = at)
        writeRecords(
            records.map { record ->
                if (record.optString(KEY_ID) == normalizedId) toJson(updated) else record
            },
        )
        return updated
    }

    private fun normalize(profile: BridgeSshProfile, now: Long): BridgeSshProfile {
        val createdAt = when {
            profile.createdAt < 0L -> throw IllegalArgumentException("createdAt must be non-negative")
            profile.createdAt == 0L -> now
            else -> profile.createdAt
        }
        requireTimestamp(createdAt, "createdAt")
        require(profile.lastUsedAt >= 0L) { "lastUsedAt must be non-negative" }
        return profile.copy(
            id = normalizeIdentifier(profile.id, "id"),
            label = normalizeLabel(profile.label),
            host = normalizeRequired(profile.host, "host", MAX_HOST_LENGTH),
            port = validatePort(profile.port),
            username = normalizeRequired(profile.username, "username", MAX_USERNAME_LENGTH),
            keyId = normalizeOptional(profile.keyId, "keyId", MAX_KEY_ID_LENGTH),
            startupCommand = normalizeStartupCommand(profile.startupCommand),
            createdAt = createdAt,
            lastUsedAt = profile.lastUsedAt,
        )
    }

    private fun toProfile(record: JSONObject): BridgeSshProfile? {
        return try {
            val createdAt = record.optLong(KEY_CREATED_AT, 0L)
            val lastUsedAt = record.optLong(KEY_LAST_USED_AT, 0L)
            if (createdAt <= 0L || lastUsedAt < 0L) return null
            BridgeSshProfile(
                id = normalizeIdentifier(record.optString(KEY_ID), "id"),
                label = normalizeLabel(record.optString(KEY_LABEL)),
                host = normalizeRequired(record.optString(KEY_HOST), "host", MAX_HOST_LENGTH),
                port = validatePort(record.optInt(KEY_PORT, -1)),
                username = normalizeRequired(
                    record.optString(KEY_USERNAME),
                    "username",
                    MAX_USERNAME_LENGTH,
                ),
                keyId = normalizeOptional(record.optString(KEY_KEY_ID), "keyId", MAX_KEY_ID_LENGTH),
                startupCommand = normalizeStartupCommand(record.optString(KEY_STARTUP_COMMAND)),
                createdAt = createdAt,
                lastUsedAt = lastUsedAt,
            )
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    private fun toJson(profile: BridgeSshProfile): JSONObject = JSONObject()
        .put(KEY_ID, profile.id)
        .put(KEY_LABEL, profile.label)
        .put(KEY_HOST, profile.host)
        .put(KEY_PORT, profile.port)
        .put(KEY_USERNAME, profile.username)
        .put(KEY_KEY_ID, profile.keyId)
        .put(KEY_STARTUP_COMMAND, profile.startupCommand)
        .put(KEY_CREATED_AT, profile.createdAt)
        .put(KEY_LAST_USED_AT, profile.lastUsedAt)

    private fun readRecords(): List<JSONObject> {
        val raw = preferences.getString(RECORDS, EMPTY_ARRAY) ?: EMPTY_ARRAY
        return try {
            val records = JSONArray(raw)
            buildList(records.length()) {
                for (index in 0 until records.length()) {
                    records.optJSONObject(index)?.let(::add)
                }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun writeRecords(records: List<JSONObject>) {
        val array = JSONArray()
        records.forEach(array::put)
        check(preferences.edit().putString(RECORDS, array.toString()).commit()) {
            "Unable to persist SSH profiles"
        }
    }

    private fun normalizeIdentifier(value: String, field: String): String =
        normalizeRequired(value, field, MAX_ID_LENGTH)

    private fun normalizeRequired(value: String, field: String, maxLength: Int): String {
        val normalized = value.trim()
        require(normalized.isNotEmpty()) { "$field must not be blank" }
        require(normalized.length <= maxLength) { "$field is too long" }
        require(normalized.none { it.isWhitespace() || it.isISOControl() }) {
            "$field must not contain whitespace or control characters"
        }
        return normalized
    }

    private fun normalizeLabel(value: String): String {
        val normalized = value.trim()
        require(normalized.isNotEmpty()) { "label must not be blank" }
        require(normalized.length <= MAX_LABEL_LENGTH) { "label is too long" }
        require(normalized.none(Char::isISOControl)) { "label must not contain control characters" }
        return normalized
    }

    private fun normalizeOptional(value: String, field: String, maxLength: Int): String {
        val normalized = value.trim()
        if (normalized.isEmpty()) return ""
        require(normalized.length <= maxLength) { "$field is too long" }
        require(normalized.none { it.isWhitespace() || it.isISOControl() }) {
            "$field must not contain whitespace or control characters"
        }
        return normalized
    }

    private fun normalizeStartupCommand(value: String): String {
        require(value.length <= MAX_STARTUP_COMMAND_LENGTH) {
            "startupCommand is too long"
        }
        require('\u0000' !in value) { "startupCommand must not contain NUL" }
        return value
    }

    private fun validatePort(port: Int): Int {
        require(port in MIN_PORT..MAX_PORT) { "port must be between $MIN_PORT and $MAX_PORT" }
        return port
    }

    private fun requireTimestamp(value: Long, field: String) {
        require(value > 0L) { "$field must be positive" }
    }

    private companion object {
        const val PREFERENCES = "bridge_ssh_profiles"
        const val RECORDS = "records"
        const val EMPTY_ARRAY = "[]"
        const val KEY_ID = "id"
        const val KEY_LABEL = "label"
        const val KEY_HOST = "host"
        const val KEY_PORT = "port"
        const val KEY_USERNAME = "username"
        const val KEY_KEY_ID = "keyId"
        const val KEY_STARTUP_COMMAND = "startupCommand"
        const val KEY_CREATED_AT = "createdAt"
        const val KEY_LAST_USED_AT = "lastUsedAt"
        const val MIN_PORT = 1
        const val MAX_PORT = 65_535
        const val MAX_ID_LENGTH = 128
        const val MAX_LABEL_LENGTH = 80
        const val MAX_HOST_LENGTH = 255
        const val MAX_USERNAME_LENGTH = 128
        const val MAX_KEY_ID_LENGTH = 128
        const val MAX_STARTUP_COMMAND_LENGTH = 4_096
    }
}
