package dev.feishu.codex.bridge

import android.content.Context
import android.content.ContentResolver
import android.content.SharedPreferences
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/** A private, local copy selected by the user for one SSH composer draft. */
internal data class BridgeSshDraftAttachment(
    val id: String,
    val name: String,
    val mimeType: String,
)

internal data class BridgeSshComposerDraft(
    val text: String = "",
    val attachments: List<BridgeSshDraftAttachment> = emptyList(),
    // True when an SSH write started but its outcome was not durably recorded.
    val sendUncertain: Boolean = false,
)

/** Keep malformed metadata intact; the UI can report the failure to the user. */
internal class BridgeSshDraftCorruptException(cause: Throwable) :
    IllegalStateException("SSH 草稿数据损坏，原始数据已保留", cause)

/** Small persistence boundary so the metadata and scope rules can be tested on the JVM. */
internal interface BridgeSshDraftPreferences {
    fun get(scope: String): String?
    fun set(scope: String, value: String?, synchronous: Boolean): Boolean
}

private class AndroidSshDraftPreferences(private val preferences: SharedPreferences) : BridgeSshDraftPreferences {
    override fun get(scope: String): String? = preferences.getString(scope, null)
    override fun set(scope: String, value: String?, synchronous: Boolean): Boolean {
        val editor = preferences.edit()
        if (value == null) editor.remove(scope) else editor.putString(scope, value)
        return if (synchronous) editor.commit() else {
            editor.apply()
            true
        }
    }
}

/**
 * Composer drafts are scoped to the SSH account and the selected tmux target.
 * Attachment bytes stay in app-private, no-backup storage until an explicit
 * send. Paths are derived from generated IDs, never from the selected name.
 */
internal class BridgeSshComposerDraftStore private constructor(
    private val preferences: BridgeSshDraftPreferences,
    private val attachmentDirectory: File,
    private val contentResolver: ContentResolver?,
) {
    constructor(context: Context) : this(
        AndroidSshDraftPreferences(
            (context.applicationContext ?: context).getSharedPreferences("bridge_ssh_composer_drafts_v1", Context.MODE_PRIVATE),
        ),
        File((context.applicationContext ?: context).noBackupFilesDir, "ssh-composer-attachments"),
        (context.applicationContext ?: context).contentResolver,
    )

    internal constructor(preferences: BridgeSshDraftPreferences, attachmentDirectory: File) :
        this(preferences, attachmentDirectory, null)

    fun load(scope: String): BridgeSshComposerDraft = synchronized(metadataLock) {
        requireScope(scope)
        val raw = preferences.get(scope) ?: return@synchronized BridgeSshComposerDraft()
        try {
            val json = JSONObject(raw)
            val text = stringField(json, "text", "")
            val items = if (json.has("attachments")) {
                json.optJSONArray("attachments") ?: error("Invalid attachments")
            } else JSONArray()
            val ids = mutableSetOf<String>()
            val attachments = buildList {
                for (index in 0 until items.length()) {
                    val item = items.optJSONObject(index) ?: error("Invalid attachment")
                    val id = stringField(item, "id", "")
                    val name = stringField(item, "name", "")
                    require(isValidId(id) && name.isNotBlank() && ids.add(id)) { "Invalid draft attachment" }
                    add(BridgeSshDraftAttachment(id, name, stringField(item, "mimeType", "application/octet-stream")))
                }
            }
            val sendUncertain = if (json.has("sendUncertain")) {
                json.opt("sendUncertain") as? Boolean ?: error("Invalid sendUncertain")
            } else false
            BridgeSshComposerDraft(text, attachments, sendUncertain)
        } catch (error: Exception) {
            throw BridgeSshDraftCorruptException(error)
        }
    }

    fun updateText(scope: String, text: String) = synchronized(metadataLock) {
        write(scope, load(scope).copy(text = text))
    }

    fun updateAttachments(scope: String, attachments: List<BridgeSshDraftAttachment>) = synchronized(metadataLock) {
        write(scope, load(scope).copy(attachments = attachments))
    }

    /** Commit before starting SSH writes. A failure must stop the write. */
    fun markPending(scope: String) = synchronized(metadataLock) {
        write(scope, load(scope).copy(sendUncertain = true), synchronous = true)
    }

    /** Commit only after a known result, or an explicit user acknowledgment. */
    fun clearPending(scope: String) = synchronized(metadataLock) {
        write(scope, load(scope).copy(sendUncertain = false), synchronous = true)
    }

    private fun write(scope: String, draft: BridgeSshComposerDraft, synchronous: Boolean = false) {
        if (draft.text.isEmpty() && draft.attachments.isEmpty() && !draft.sendUncertain) {
            check(preferences.set(scope, null, synchronous)) { "无法保存 SSH 草稿状态" }
            return
        }
        val items = JSONArray()
        val ids = mutableSetOf<String>()
        draft.attachments.forEach { attachment ->
            require(isValidId(attachment.id) && attachment.name.isNotBlank() && ids.add(attachment.id)) {
                "Invalid draft attachment"
            }
            items.put(JSONObject().put("id", attachment.id).put("name", attachment.name).put("mimeType", attachment.mimeType))
        }
        val json = JSONObject().put("text", draft.text).put("attachments", items)
            .put("sendUncertain", draft.sendUncertain)
        check(preferences.set(scope, json.toString(), synchronous)) { "无法保存 SSH 草稿状态" }
    }

    /** Copy in bounded chunks; the source file is never modified or removed. */
    suspend fun stage(scope: String, uri: Uri): BridgeSshDraftAttachment = withContext(Dispatchers.IO) {
        requireScope(scope)
        val resolver = checkNotNull(contentResolver) { "Content resolver unavailable" }
        val name = runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
        }.getOrNull()?.takeIf(String::isNotBlank)?.take(512) ?: "attachment"
        val mimeType = runCatching { resolver.getType(uri) }.getOrNull().orEmpty()
            .ifBlank { "application/octet-stream" }
        stageContent(scope, name, mimeType) { resolver.openInputStream(uri) ?: error("无法读取所选附件") }
    }

    /** Source supplier is injected to verify copying and cancellation on the JVM. */
    internal suspend fun stageContent(
        scope: String,
        name: String,
        mimeType: String,
        openSource: () -> InputStream,
    ): BridgeSshDraftAttachment = withContext(Dispatchers.IO) {
        val scopeDirectory = directoryFor(scope)
        if (!scopeDirectory.isDirectory && !scopeDirectory.mkdirs() && !scopeDirectory.isDirectory) {
            error("无法创建附件草稿目录")
        }
        val attachment = BridgeSshDraftAttachment(
            UUID.randomUUID().toString(),
            name.takeIf(String::isNotBlank)?.take(512) ?: "attachment",
            mimeType.ifBlank { "application/octet-stream" },
        )
        val file = fileFor(scope, attachment.id)
        check(file.createNewFile()) { "无法创建附件草稿" }
        try {
            val input = openSource()
            input.use { source ->
                FileOutputStream(file).use { destination ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        coroutineContext.ensureActive()
                        val count = source.read(buffer)
                        if (count < 0) break
                        destination.write(buffer, 0, count)
                    }
                }
            }
            coroutineContext.ensureActive()
            attachment
        } catch (error: Throwable) {
            file.delete()
            throw error
        }
    }

    fun fileFor(scope: String, id: String): File {
        require(isValidId(id)) { "Invalid draft attachment id" }
        val directory = directoryFor(scope)
        val file = File(directory, "$id.data").canonicalFile
        require(file.parentFile == directory) { "Draft attachment escapes scope" }
        return file
    }

    /** Delete only a copy generated by this store, never the selected source. */
    fun deleteLocalCopy(scope: String, id: String): Boolean {
        val file = fileFor(scope, id)
        return !file.exists() || file.delete()
    }

    private fun directoryFor(scope: String): File {
        requireScope(scope)
        val root = attachmentDirectory.canonicalFile
        val directory = File(root, scope).canonicalFile
        require(directory.parentFile == root) { "Draft scope escapes attachment directory" }
        return directory
    }

    companion object {
        private val metadataLock = Any()

        fun scopeKey(host: String, port: Int, username: String, target: String?, tmuxCreatedAt: Long? = null): String {
            require(host.isNotBlank() && username.isNotBlank() && port in 1..65535) { "Invalid SSH draft host" }
            if (target == null) {
                require(tmuxCreatedAt == null) { "Shell scope cannot have tmux creation time" }
            } else {
                require(target.isNotBlank() && tmuxCreatedAt != null && tmuxCreatedAt >= 0) {
                    "A tmux draft requires a session ID and creation time"
                }
            }
            val parts = listOf(
                "bridge-ssh-draft-v2", host.trim().lowercase(), port.toString(), username.trim(),
                if (target == null) "shell" else "tmux", target.orEmpty(), tmuxCreatedAt?.toString().orEmpty(),
            )
            // A length prefix prevents delimiter characters inside components from colliding.
            val scope = parts.joinToString("") { "${it.toByteArray(Charsets.UTF_8).size}:$it" }
            val digest = MessageDigest.getInstance("SHA-256").digest(scope.toByteArray(Charsets.UTF_8))
            return digest.joinToString("") { "%02x".format(it) }
        }

        private fun requireScope(scope: String) {
            require(scope.length == 64 && scope.all { it in '0'..'9' || it in 'a'..'f' }) { "Invalid draft scope" }
        }

        private fun stringField(json: JSONObject, name: String, fallback: String): String {
            if (!json.has(name)) return fallback
            return json.opt(name) as? String ?: error("Invalid draft field: $name")
        }

        private fun isValidId(id: String): Boolean = runCatching { UUID.fromString(id).toString() == id }.getOrDefault(false)
    }
}
