package dev.feishu.codex.bridge

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.net.URLDecoder

/** A complete, authenticated Bridge snapshot; session data has a separate key. */
internal data class BridgeComposerSnapshot(
    val dataset: String,
    val key: String,
    val payload: JSONObject,
    val updatedAt: Long = System.currentTimeMillis(),
)

internal data class BridgeComposerShortcutState(
    val source: String?,
    val snapshot: BridgeComposerSnapshot?,
    val usage: Map<String, Long>,
)

/**
 * App-private SQLite data survives an in-place APK update. Configuration is
 * copied from a paired Bridge; drafts and attachment bytes have their own
 * host/session-scoped stores and are not merged into these snapshots.
 */
internal class BridgeComposerDatabase(
    context: Context,
    databaseName: String = DATABASE_NAME,
    version: Int = DATABASE_VERSION,
) : SQLiteOpenHelper(context.applicationContext ?: context, databaseName, null, version) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE composer_meta (
                name TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            )""".trimIndent(),
        )
        db.execSQL(
            """CREATE TABLE composer_snapshots (
                scope TEXT NOT NULL,
                dataset TEXT NOT NULL,
                item_key TEXT NOT NULL,
                format_version INTEGER NOT NULL,
                payload TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (scope, dataset, item_key)
            )""".trimIndent(),
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // Add explicit, data-preserving migrations before increasing the version.
        throw IllegalStateException("Unsupported Composer database migration: $oldVersion -> $newVersion")
    }

    override fun onDowngrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        throw IllegalStateException("Unsupported Composer database downgrade: $oldVersion -> $newVersion")
    }

    fun activate(scope: String) {
        validateScope(scope)
        val values = ContentValues().apply {
            put("name", ACTIVE_SCOPE)
            put("value", scope)
        }
        check(writableDatabase.insertWithOnConflict("composer_meta", null, values, SQLiteDatabase.CONFLICT_REPLACE) != -1L) {
            "Could not activate Composer source"
        }
    }

    /** Changing Bridge environments keeps old snapshots but stops selecting them. */
    fun deactivate(expectedScope: String?, keepScope: String?) {
        if (expectedScope != null) {
            validateScope(expectedScope)
            writableDatabase.delete("composer_meta", "name = ? AND value = ?", arrayOf(ACTIVE_SCOPE, expectedScope))
        } else if (keepScope != null) {
            validateScope(keepScope)
            writableDatabase.delete("composer_meta", "name = ? AND value <> ?", arrayOf(ACTIVE_SCOPE, keepScope))
        } else {
            writableDatabase.delete("composer_meta", "name = ?", arrayOf(ACTIVE_SCOPE))
        }
    }

    /** Commit all successfully fetched datasets together, only for the active device. */
    fun saveActive(scope: String, snapshots: List<BridgeComposerSnapshot>) {
        validateScope(scope)
        require(snapshots.isNotEmpty()) { "No Composer snapshots supplied" }
        snapshots.forEach(::validateSnapshot)
        val db = writableDatabase
        db.beginTransaction()
        try {
            check(readActiveScope(db) == scope) { "Composer source is no longer active" }
            for (snapshot in snapshots) {
                val values = ContentValues().apply {
                    put("scope", scope)
                    put("dataset", snapshot.dataset)
                    put("item_key", snapshot.key)
                    put("format_version", FORMAT_VERSION)
                    put("payload", snapshot.payload.toString())
                    put("updated_at", snapshot.updatedAt)
                }
                val result = db.insertWithOnConflict("composer_snapshots", null, values, SQLiteDatabase.CONFLICT_REPLACE)
                check(result != -1L) { "Could not save Composer snapshot" }
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    /** Native consumers never have to guess which Bridge environment is active. */
    fun readActive(dataset: String, key: String = ""): BridgeComposerSnapshot? {
        validateDatasetKey(dataset, key)
        val db = readableDatabase
        val scope = readActiveScope(db) ?: return null
        return readSnapshot(db, scope, dataset, key)
    }

    private fun readSnapshot(db: SQLiteDatabase, scope: String, dataset: String, key: String): BridgeComposerSnapshot? {
        db.query(
            "composer_snapshots", arrayOf("payload", "updated_at", "format_version"),
            "scope = ? AND dataset = ? AND item_key = ?", arrayOf(scope, dataset, key),
            null, null, null,
        ).use { cursor ->
            if (!cursor.moveToFirst()) return null
            check(cursor.getInt(2) == FORMAT_VERSION) { "Unsupported Composer snapshot format" }
            return BridgeComposerSnapshot(dataset, key, JSONObject(cursor.getString(0)), cursor.getLong(1))
        }
    }

    /** Local native usage is separate from the server snapshot, so sync cannot erase it. */
    fun recordShortcutUse(id: String, expectedSource: String?): Map<String, Long> {
        require(id.isNotBlank() && id.length <= 512 && id.none(Char::isISOControl)) { "Invalid shortcut ID" }
        val db = writableDatabase
        db.beginTransaction()
        try {
            val activeSource = readActiveScope(db)
            check(activeSource == expectedSource) { "Composer source is no longer active" }
            val scope = activeSource ?: OFFLINE_USAGE_SCOPE
            val counts = db.query(
                "composer_snapshots", arrayOf("payload"),
                "scope = ? AND dataset = ? AND item_key = ?", arrayOf(scope, LOCAL_USAGE, ""),
                null, null, null,
            ).use { cursor ->
                if (cursor.moveToFirst()) JSONObject(cursor.getString(0)).getJSONObject("counts") else JSONObject()
            }
            val old = counts.optLong(id, 0L).coerceAtLeast(0L)
            counts.put(id, if (old == Long.MAX_VALUE) old else old + 1)
            val values = ContentValues().apply {
                put("scope", scope); put("dataset", LOCAL_USAGE); put("item_key", "")
                put("format_version", FORMAT_VERSION); put("payload", JSONObject().put("counts", counts).toString())
                put("updated_at", System.currentTimeMillis())
            }
            check(db.insertWithOnConflict("composer_snapshots", null, values, SQLiteDatabase.CONFLICT_REPLACE) != -1L)
            db.setTransactionSuccessful()
            return counts.keys().asSequence().associateWith { counts.optLong(it, 0L).coerceAtLeast(0L) }
        } finally {
            db.endTransaction()
        }
    }

    fun readShortcutUsage(): Map<String, Long> {
        val db = readableDatabase
        val scope = readActiveScope(db) ?: OFFLINE_USAGE_SCOPE
        val counts = readSnapshot(db, scope, LOCAL_USAGE, "")?.payload?.optJSONObject("counts") ?: return emptyMap()
        return counts.keys().asSequence().associateWith { counts.optLong(it, 0L).coerceAtLeast(0L) }
    }

    /** Read configuration and native counts from the same authenticated source. */
    fun readShortcutState(): BridgeComposerShortcutState {
        val db = readableDatabase
        db.beginTransaction()
        try {
            val source = readActiveScope(db)
            val snapshot = source?.let { readSnapshot(db, it, SHORTCUTS, "") }
            val counts = readSnapshot(db, source ?: OFFLINE_USAGE_SCOPE, LOCAL_USAGE, "")
                ?.payload?.optJSONObject("counts")
            val usage = counts?.keys()?.asSequence()?.associateWith { counts.optLong(it, 0L).coerceAtLeast(0L) }.orEmpty()
            db.setTransactionSuccessful()
            return BridgeComposerShortcutState(source, snapshot, usage)
        } finally {
            db.endTransaction()
        }
    }

    /** Match a cached Bridge source to an SSH host without relying on aliases. */
    fun activeSourceHost(): String? {
        val scope = readActiveScope(readableDatabase) ?: return null
        val encodedOrigin = scope.substringBefore(':', "")
        if (encodedOrigin.isEmpty()) return null
        return runCatching { URI(URLDecoder.decode(encodedOrigin, "UTF-8")).host?.lowercase() }.getOrNull()
    }

    /** Revocation only removes this device/environment, never other snapshots. */
    fun clearScope(scope: String) {
        validateScope(scope)
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.delete("composer_snapshots", "scope = ?", arrayOf(scope))
            if (readActiveScope(db) == scope) db.delete("composer_meta", "name = ?", arrayOf(ACTIVE_SCOPE))
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    private fun readActiveScope(db: SQLiteDatabase): String? = db.query(
        "composer_meta", arrayOf("value"), "name = ?", arrayOf(ACTIVE_SCOPE), null, null, null,
    ).use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }

    companion object {
        internal const val DATABASE_NAME = "bridge-composer.db"
        private const val DATABASE_VERSION = 1
        private const val FORMAT_VERSION = 1
        private const val ACTIVE_SCOPE = "active_scope"
        private const val OFFLINE_USAGE_SCOPE = "native:ssh-offline"
        const val SHORTCUTS = "shortcuts"
        const val SKILLS = "skills"
        const val SESSION_SKILLS = "session-skills"
        private const val LOCAL_USAGE = "local-usage"

        private fun validateScope(scope: String) {
            require(scope.isNotBlank() && scope.length <= 4096 && scope.none(Char::isISOControl)) {
                "Invalid Composer source"
            }
        }

        private fun validateDatasetKey(dataset: String, key: String) {
            require(dataset in setOf(SHORTCUTS, SKILLS, SESSION_SKILLS, LOCAL_USAGE)) { "Invalid Composer dataset" }
            require(key.length <= 1024 && key.none(Char::isISOControl)) { "Invalid Composer dataset key" }
            require((dataset == SESSION_SKILLS && key.isNotBlank()) || (dataset != SESSION_SKILLS && key.isEmpty())) {
                "Invalid Composer dataset scope"
            }
        }

        private fun validateSnapshot(snapshot: BridgeComposerSnapshot) {
            validateDatasetKey(snapshot.dataset, snapshot.key)
            require(snapshot.updatedAt >= 0) { "Invalid Composer snapshot timestamp" }
            when (snapshot.dataset) {
                SHORTCUTS -> {
                    val groups = snapshot.payload.optJSONArray("groups") ?: error("Missing shortcut groups")
                    val shortcuts = snapshot.payload.optJSONArray("shortcuts") ?: error("Missing shortcuts")
                    validateItems(groups, "id")
                    validateItems(shortcuts, "id", "groupId")
                }
                SKILLS, SESSION_SKILLS -> {
                    val skills = snapshot.payload.optJSONArray("skills") ?: error("Missing skills")
                    validateItems(skills, "skillName")
                }
                LOCAL_USAGE -> require(snapshot.payload.optJSONObject("counts") != null) { "Missing shortcut usage" }
            }
        }

        private fun validateItems(items: JSONArray, vararg fields: String) {
            for (index in 0 until items.length()) {
                val item = items.optJSONObject(index) ?: error("Invalid Composer item")
                for (field in fields) {
                    val value = item.opt(field)
                    require(value is String && value.isNotBlank()) { "Invalid Composer item field" }
                }
            }
        }
    }
}
