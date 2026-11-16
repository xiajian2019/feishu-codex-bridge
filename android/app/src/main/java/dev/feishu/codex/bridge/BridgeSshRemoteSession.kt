package dev.feishu.codex.bridge

import java.io.InputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.connectbot.sshlib.SessionExit
import org.json.JSONArray
import org.json.JSONObject

private const val RESULT_PREFIX = "BRIDGE_SSH_RESULT:"
private const val DIAGNOSTIC_PREFIX = "BRIDGE_SSH_DIAG:"
private const val NATIVE_APP_ORIGIN = "capacitor://localhost"
private const val MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024
internal val BRIDGE_SSH_API_FIRST_ACTIONS = setOf(
    "accounts", "mark_account", "refresh_account", "usage",
    "git_list", "git_diff", "git_preview", "save", "suspend", "list_suspended", "restore", "end",
)

internal data class BridgeSshHttpResponse(val statusCode: Int, val body: String)

internal fun interface BridgeSshApiTransport {
    suspend fun request(
        method: String,
        url: String,
        headers: Map<String, String>,
        body: String?,
    ): BridgeSshHttpResponse
}

private class AndroidBridgeSshApiTransport : BridgeSshApiTransport {
    override suspend fun request(
        method: String,
        url: String,
        headers: Map<String, String>,
        body: String?,
    ): BridgeSshHttpResponse = withContext(Dispatchers.IO) {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 8_000
            readTimeout = 35_000
            // A Bridge Bearer token is origin-bound. Do not let the platform
            // follow a redirect to another host while carrying the request.
            instanceFollowRedirects = false
            useCaches = false
            doInput = true
            headers.forEach { (name, value) -> setRequestProperty(name, value) }
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
        }
        try {
            if (body != null) {
                connection.outputStream.use { output ->
                    output.write(body.toByteArray(Charsets.UTF_8))
                }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            BridgeSshHttpResponse(status, stream?.use(::readApiResponse).orEmpty())
        } finally {
            connection.disconnect()
        }
    }

    private fun readApiResponse(stream: InputStream): String {
        val output = ByteArray(MAX_API_RESPONSE_BYTES)
        var used = 0
        while (used < output.size) {
            val count = stream.read(output, used, output.size - used)
            if (count < 0) break
            used += count
        }
        if (stream.read() >= 0) throw IllegalStateException("Bridge API 响应过大。")
        return String(output, 0, used, Charsets.UTF_8)
    }
}

internal class BridgeSshApiFallbackException(val diagnostic: String) : Exception(diagnostic)

/** API errors outside the explicit fallback boundary must be shown to the user. */
internal class BridgeSshApiRequestException(message: String) : Exception(message)

/** Native API-first implementation for operations shared with the Web dashboard. */
internal class BridgeSshApiClient(
    private val serverOrigin: String,
    private val bearerToken: String,
    private val transport: BridgeSshApiTransport = AndroidBridgeSshApiTransport(),
    private val files: BridgeSshApiFileTransport = AndroidBridgeSshApiFileTransport(),
) {
    suspend fun listSessions(): List<BridgeSshTmuxSession> {
        val token = requestActionToken()
        val result = requestJson("GET", "/tmux-dashboard/api/sessions?includeHomes=0", null, null, token)
        val sessions = result.optJSONArray("sessions") ?: throw BridgeSshApiFallbackException("Session 列表无效")
        return (0 until sessions.length()).mapNotNull { index ->
            val item = sessions.optJSONObject(index) ?: throw BridgeSshApiFallbackException("Session 列表无效")
            if (!item.isNull("endedAt") || !item.isNull("suspendedAt")) return@mapNotNull null
            val id = item.optString("id")
            val name = item.optString("name")
            val cwd = item.optString("cwd")
            val windows = item.optInt("windows", 0)
            val createdAt = item.optLong("createdAt", -1)
            if (id.length < 2 || id[0] != '$' || !id.drop(1).all(Char::isDigit) ||
                name.isBlank() || !cwd.startsWith('/') || windows < 1 || createdAt < 0) {
                throw BridgeSshApiFallbackException("Session 列表无效")
            }
            BridgeSshTmuxSession(id, name, windows, item.optInt("attachedClients", 0) > 0, cwd, createdAt)
        }
    }

    suspend fun listSkills(target: BridgeSshTmuxSession?): List<BridgeSshSkill> {
        // /api/skills deduplicates project skills before returning them and
        // is not scoped to this SSH shell's CODEX_HOME. Without a Session the
        // result can omit or misidentify global skills, so retain discovery.
        if (target == null) throw BridgeSshApiFallbackException("SSH shell 缺少 Session 技能作用域")
        val token = requestActionToken()
        sessionIdentity(target, token)
        val result = requestJson("GET", "${sessionPrefix(target)}/skills?all=1", target, null, token)
        val skills = result.optJSONArray("skills") ?: throw BridgeSshApiFallbackException("技能列表无效")
        return parseBridgeSshSkills(skills)
    }

    suspend fun listFiles(target: BridgeSshTmuxSession, relative: String, expectedRoot: String?): Pair<String, List<BridgeSshRemoteFile>> {
        // The Web file API treats backslashes as separators, while SFTP on
        // the SSH host accepts them as literal POSIX filename characters.
        if ('\\' in relative) throw BridgeSshApiFallbackException("路径需要 SFTP")
        val token = requestActionToken()
        val query = "path=${encodeQuery(relative)}" + (expectedRoot?.let { "&expectedRoot=${encodeQuery(it)}" } ?: "")
        val result = requestJson("GET", "${sessionPrefix(target)}/files?$query", target, null, token)
        // Older servers do not report whether their 2,000-entry list was
        // truncated. Preserve the complete SFTP listing in that case.
        if (result.opt("truncated") !is Boolean || result.optBoolean("truncated")) {
            throw BridgeSshApiFallbackException("目录结果不完整")
        }
        val root = result.optString("root").takeIf { it.startsWith('/') && it.none(Char::isISOControl) }
            ?: throw BridgeSshApiFallbackException("目录响应无效")
        val entries = result.optJSONArray("entries") ?: throw BridgeSshApiFallbackException("目录响应无效")
        val mapped = (0 until entries.length()).mapNotNull { index ->
            val item = entries.optJSONObject(index) ?: throw BridgeSshApiFallbackException("目录响应无效")
            val name = item.optString("name")
            val type = item.optString("type")
            if (!BridgeSshRemoteFiles.validName(name)) return@mapNotNull null
            if (type !in setOf("file", "directory")) throw BridgeSshApiFallbackException("目录响应无效")
            val path = if (relative.isEmpty()) name else "$relative/$name"
            val size = if (item.isNull("size")) null else item.optLong("size", -1).takeIf { it >= 0 }
            val modified = if (item.isNull("modifiedAt")) null else item.optLong("modifiedAt", -1).takeIf { it >= 0 }?.div(1_000)
            BridgeSshRemoteFile(name, path, type == "directory", size, modified)
        }
        return root to mapped
    }

    suspend fun downloadFile(
        target: BridgeSshTmuxSession,
        relative: String,
        root: String,
        output: java.io.OutputStream,
        maxBytes: Long? = null,
        git: Boolean = false,
    ): Boolean {
        if (!git && '\\' in relative) throw BridgeSshApiFallbackException("路径需要 SFTP")
        val token = requestActionToken()
        val suffix = if (git) "git-changes/download" else "files/download"
        val rootParameter = if (git) "expectedGitRoot" else "expectedRoot"
        val path = "${sessionPrefix(target)}/$suffix?path=${encodeQuery(relative)}&$rootParameter=${encodeQuery(root)}"
        return files.download(serverOrigin + path, fileHeaders(target, token), output, maxBytes)
    }

    suspend fun uploadFile(target: BridgeSshTmuxSession, relative: String, root: String, name: String, input: java.io.InputStream) {
        if ('\\' in relative || '\\' in name) throw BridgeSshApiFallbackException("文件名需要 SFTP")
        val token = requestActionToken()
        val path = "${sessionPrefix(target)}/files/upload?path=${encodeQuery(relative)}&expectedRoot=${encodeQuery(root)}"
        files.upload(serverOrigin + path, fileHeaders(target, token) + mapOf("X-File-Name" to encodeQuery(name)), input)
    }

    suspend fun uploadComposerAttachment(
        target: BridgeSshTmuxSession, name: String, mime: String, file: File, onProgress: (Long) -> Unit,
    ): BridgeSshUploadedAttachment = withContext(Dispatchers.IO) {
        val token = requestActionToken()
        sessionIdentity(target, token)
        val size = file.length()
        val created = requestJson(
            "POST", "/tmux-dashboard/api/attachments/uploads", null,
            JSONObject().put("fileName", name).put("contentType", mime).put("sizeBytes", size),
            token, fallbackWhenMissing = true,
        )
        val id = created.optString("id")
        if (!id.matches(Regex("[a-f0-9-]{1,64}"))) throw BridgeSshApiRequestException("附件上传记录无效，请检查后重试。")
        val serverChunkSize = created.optInt("chunkBytes", 0)
        if (serverChunkSize < 1 || created.optLong("offset", -1) != 0L) {
            throw BridgeSshApiRequestException("附件上传进度无效，请检查后重试。")
        }
        val buffer = ByteArray(minOf(serverChunkSize, 1024 * 1024))
        var offset = 0L
        file.inputStream().use { input ->
            while (offset < size) {
                currentCoroutineContext().ensureActive()
                val wanted = minOf(buffer.size.toLong(), size - offset).toInt()
                var count = 0
                while (count < wanted) {
                    val read = input.read(buffer, count, wanted - count)
                    if (read < 0) throw BridgeSshApiRequestException("手机上的附件已变化，请重新选择。")
                    if (read > 0) count += read
                }
                val path = "/tmux-dashboard/api/attachments/uploads/$id?offset=$offset"
                val response = try {
                    JSONObject(files.uploadChunk(serverOrigin + path, fileHeaders(target, token), buffer, count))
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: BridgeSshApiRequestException) { throw error }
                catch (_: Exception) { throw BridgeSshApiRequestException("附件上传进度未知，请检查连接后重试。") }
                offset += count
                if (response.optLong("offset", -1) != offset) {
                    throw BridgeSshApiRequestException("附件上传进度不一致，请检查后重试。")
                }
                onProgress(offset)
            }
            if (input.read() >= 0) throw BridgeSshApiRequestException("手机上的附件已变化，请重新选择。")
        }
        val result = requestJson("POST", "/tmux-dashboard/api/attachments/uploads/$id/complete", null, JSONObject(), token)
        val path = result.optString("filePath")
        if (!path.startsWith('/') || path.any(Char::isISOControl) || path.split('/').any { it == "." || it == ".." } ||
            result.optLong("sizeBytes", -1) != size) {
            throw BridgeSshApiRequestException("附件上传结果无效，请检查后重试。")
        }
        BridgeSshUploadedAttachment(name, path, size)
    }

    private fun fileHeaders(target: BridgeSshTmuxSession, actionToken: String): Map<String, String> = mapOf(
        "Authorization" to "Bearer $bearerToken",
        "Origin" to NATIVE_APP_ORIGIN,
        "X-Bridge-Client" to "android-native-ssh",
        "X-Bridge-Action-Token" to actionToken,
        "X-Bridge-Session-Created-At" to target.createdAt.toString(),
    )

    suspend fun call(
        action: String,
        target: BridgeSshTmuxSession? = null,
        arguments: Map<String, String> = emptyMap(),
        identity: BridgeSshTmuxIdentity? = null,
    ): JSONObject {
        val actionToken = requestActionToken()
        return when (action) {
            "accounts" -> accounts(target, actionToken)
            "mark_account" -> markAccount(requireTarget(target), arguments, actionToken)
            "refresh_account" -> refreshAccount(requireTarget(target), actionToken)
            "usage" -> usage(requireTarget(target), arguments, actionToken)
            "git_list", "git_diff", "git_preview" -> git(action, requireTarget(target), arguments, actionToken)
            "save", "suspend", "end" -> lifecycle(action, requireTarget(target), actionToken)
            "list_suspended" -> requestJson("GET", "/tmux-dashboard/api/sessions/suspended", null, null, actionToken)
            "restore" -> restore(requireNotNull(identity) { "当前 SSH 操作缺少 Session 身份。" }, actionToken, arguments["source"])
            else -> error("Bridge API 不支持该 SSH 操作。")
        }
    }

    private suspend fun requestActionToken(): String {
        val response = requestJson("GET", "/api/session", null, null, null)
        return response.optString("actionToken").takeIf { it.isNotBlank() }
            ?: throw BridgeSshApiFallbackException("操作令牌无效")
    }

    private suspend fun accounts(target: BridgeSshTmuxSession?, actionToken: String): JSONObject {
        val session = target?.let { sessionIdentity(it, actionToken) }
        val options = requestJson("GET", "/tmux-dashboard/api/codex-homes", null, null, actionToken)
        val history = requestJson("GET", "/api/codex/homes", null, null, actionToken)
        val knownPaths = mutableMapOf<String, String>()
        val historyHomes = history.optJSONArray("homes") ?: JSONArray()
        for (index in 0 until historyHomes.length()) {
            val home = historyHomes.optJSONObject(index) ?: continue
            val id = home.optString("id").takeIf { it.isNotBlank() } ?: continue
            knownPaths[id] = home.optString("path")
        }
        val homes = JSONArray()
        val availableHomes = options.optJSONArray("codexHomes") ?: JSONArray()
        for (index in 0 until availableHomes.length()) {
            val home = availableHomes.optJSONObject(index) ?: continue
            if (!home.optBoolean("available", false)) continue
            val id = home.optString("id").takeIf { it.isNotBlank() } ?: continue
            homes.put(JSONObject()
                .put("id", id)
                .put("path", knownPaths[id].orEmpty())
                .put("label", home.optString("label", id)))
        }
        return JSONObject()
            .put("homes", homes)
            .put("selected", session?.optString("codexHomeId").orEmpty())
    }

    private suspend fun markAccount(
        target: BridgeSshTmuxSession,
        arguments: Map<String, String>,
        actionToken: String,
    ): JSONObject {
        val home = arguments["home"]?.takeIf { it.isNotBlank() }
            ?: throw BridgeSshApiRequestException("请选择 Codex 账号。")
        val result = requestJson(
            "POST",
            "${sessionPrefix(target)}/codex-account",
            target,
            JSONObject().put("homeId", home),
            actionToken,
        )
        val session = result.optJSONObject("session")
            ?: throw BridgeSshApiRequestException("Bridge API 未返回 Session 账号标记。")
        return JSONObject().put("selected", session.optString("codexHomeId"))
    }

    private suspend fun refreshAccount(target: BridgeSshTmuxSession, actionToken: String): JSONObject {
        val result = requestJson(
            "POST",
            "${sessionPrefix(target)}/codex-account/check",
            target,
            JSONObject(),
            actionToken,
        )
        return when (result.optString("status")) {
            "matched" -> JSONObject().put("selected", result.optJSONObject("home")?.optString("id").orEmpty())
            "not-running" -> throw BridgeSshApiRequestException("当前 pane 没有运行中的 Codex，请手动选择账号。")
            "unmatched" -> throw BridgeSshApiRequestException("当前 Codex Home 不在账号列表中，请手动选择。")
            else -> throw BridgeSshApiRequestException("无法读取当前 Codex 的环境，请手动选择账号。")
        }
    }

    private suspend fun usage(
        target: BridgeSshTmuxSession,
        arguments: Map<String, String>,
        actionToken: String,
    ): JSONObject {
        val home = arguments["home"]?.takeIf { it.isNotBlank() }
            ?: throw BridgeSshApiRequestException("请选择 Codex 账号。")
        val session = sessionIdentity(target, actionToken)
        if (session.optString("codexHomeId") != home) {
            throw BridgeSshApiRequestException("Session 的 Codex 账号标记已变化，请刷新。")
        }
        val encodedHome = URLEncoder.encode(home, Charsets.UTF_8.name()).replace("+", "%20")
        val usage = requestJson("GET", "/api/codex/usage?home=$encodedHome", null, null, actionToken)
        val accounts = usage.optJSONArray("accounts") ?: JSONArray()
        val account = (0 until accounts.length())
            .mapNotNull { accounts.optJSONObject(it) }
            .firstOrNull { it.optString("homeId") == home }
            ?: throw BridgeSshApiRequestException("当前账号没有返回用量数据。")
        val quota = account.optJSONObject("quota")
            ?: throw BridgeSshApiRequestException("当前账号没有返回额度数据。")
        val buckets = quota.optJSONArray("buckets") ?: JSONArray()
        val byId = JSONObject()
        for (index in 0 until buckets.length()) {
            val bucket = buckets.optJSONObject(index) ?: continue
            val key = bucket.optString("limitId").takeIf { it.isNotBlank() } ?: "codex-${byId.length()}"
            val copy = JSONObject(bucket.toString())
            if (!copy.has("planType")) copy.put("planType", quota.optString("planType"))
            byId.put(key, copy)
        }
        return JSONObject().put("rateLimitsByLimitId", byId)
    }

    private suspend fun git(
        action: String,
        target: BridgeSshTmuxSession,
        arguments: Map<String, String>,
        actionToken: String,
    ): JSONObject {
        val prefix = sessionPrefix(target)
        val result = requestJson("GET", "$prefix/git-changes", target, null, actionToken)
        val root = result.optString("gitRoot").takeIf { it.isNotBlank() }
            ?: throw BridgeSshApiRequestException("Bridge API 未返回 Git 仓库。")
        val expectedRoot = arguments["root"]
        if (!expectedRoot.isNullOrBlank() && expectedRoot != root) {
            throw BridgeSshApiRequestException("Session 的 Git 仓库已变化，请刷新。")
        }
        val files = result.optJSONArray("files") ?: JSONArray()
        if (action == "git_list") {
            val mapped = JSONArray()
            for (index in 0 until files.length()) {
                val file = files.optJSONObject(index) ?: continue
                val status = when (file.optString("status")) {
                    "untracked" -> "??"
                    "added" -> " A"
                    "deleted" -> " D"
                    "renamed" -> " R"
                    "copied" -> " C"
                    else -> " M"
                }
                mapped.put(JSONObject()
                    .put("path", file.getString("path"))
                    .put("status", status)
                    .put("size", if (file.isNull("sizeBytes")) JSONObject.NULL else file.opt("sizeBytes")))
            }
            return JSONObject().put("root", root).put("branch", result.optString("branch")).put("files", mapped)
        }
        val path = arguments["path"]?.takeIf { it.isNotBlank() }
            ?: throw BridgeSshApiRequestException("文件路径无效。")
        val file = (0 until files.length()).mapNotNull(files::optJSONObject)
            .firstOrNull { it.optString("path") == path }
            ?: throw BridgeSshApiRequestException("文件已不在当前变更列表中，请刷新。")
        if (action == "git_preview") {
            val query = "path=${encodeQuery(path)}&expectedGitRoot=${encodeQuery(root)}"
            val preview = requestJson("GET", "$prefix/git-changes/content?$query", target, null, actionToken)
            if (preview.optString("kind") != "text" || preview.opt("text") !is String) {
                throw BridgeSshApiRequestException("此文件不是文本，请下载后打开。")
            }
            return JSONObject().put("text", preview.getString("text")).put("truncated", preview.optBoolean("truncated"))
        }
        val patch = result.optString("patch")
        val oldPath = file.optString("oldPath").takeIf { !file.isNull("oldPath") && it.isNotBlank() }
        val section = patch.split(Regex("(?=^diff --git )", RegexOption.MULTILINE))
            .firstOrNull { bridgeSshGitSectionMatches(it, path, oldPath) }
        val truncated = result.optBoolean("patchTruncated")
        return JSONObject().put("text", section ?: if (truncated) "Diff 已截断，请刷新或查看文件预览。" else "没有可显示的文本 Diff。")
            .put("truncated", truncated)
    }

    private suspend fun lifecycle(action: String, target: BridgeSshTmuxSession, actionToken: String): JSONObject {
        val session = sessionIdentity(target, actionToken)
        val prefix = sessionPrefix(target)
        when (action) {
            "save" -> requestJson("POST", "$prefix/resurrect/save", target, JSONObject(), actionToken)
            "suspend" -> requestJson("POST", "$prefix/suspend", target, JSONObject(), actionToken)
            "end" -> requestJson("DELETE", prefix, target, null, actionToken)
        }
        return JSONObject().put("name", session.optString("name", target.name))
    }

    private suspend fun restore(identity: BridgeSshTmuxIdentity, actionToken: String, source: String?): JSONObject {
        val suspended = requestJson("GET", "/tmux-dashboard/api/sessions/suspended", null, null, actionToken)
        val sessions = suspended.optJSONArray("sessions") ?: JSONArray()
        val match = (0 until sessions.length()).mapNotNull(sessions::optJSONObject).firstOrNull {
            it.optString("id") == identity.id && it.optLong("createdAt", -1L) == identity.createdAt &&
                (source != "ssh-fallback" || it.optString("source") == source)
        } ?: if (source == "ssh-fallback") throw BridgeSshApiFallbackException("Bridge 暂不支持该 SSH 快照")
            else throw BridgeSshApiRequestException("挂起的 Session 已变化，请刷新后重试。")
        val suffix = if (source == "ssh-fallback") "?source=ssh-fallback" else ""
        val result = requestJson("POST", "${sessionPrefix(identity.id)}/resume$suffix", null, JSONObject(), actionToken, identity)
        val name = result.optJSONObject("session")?.optString("name").orEmpty().ifBlank { match.optString("name") }
        return JSONObject().put("name", name)
    }

    private suspend fun sessionIdentity(target: BridgeSshTmuxSession, actionToken: String): JSONObject {
        val result = requestJson(
            "GET",
            "${sessionPrefix(target)}/identity",
            target,
            null,
            actionToken,
        )
        return result.optJSONObject("session")
            ?: throw BridgeSshApiRequestException("Bridge API 未返回 Session 身份。")
    }

    private suspend fun requestJson(
        method: String,
        path: String,
        target: BridgeSshTmuxSession?,
        body: JSONObject?,
        actionToken: String?,
        identity: BridgeSshTmuxIdentity? = null,
        fallbackWhenMissing: Boolean = false,
    ): JSONObject {
        val headers = linkedMapOf(
            "Accept" to "application/json",
            "Authorization" to "Bearer $bearerToken",
            "Origin" to NATIVE_APP_ORIGIN,
            "X-Bridge-Client" to "android-native-ssh",
        )
        if (actionToken != null) headers["X-Bridge-Action-Token"] = actionToken
        (identity?.createdAt ?: target?.createdAt)?.let { headers["X-Bridge-Session-Created-At"] = it.toString() }
        val mutating = method != "GET" && method != "HEAD"
        val response = try {
            transport.request(method, serverOrigin + path, headers, body?.toString())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            if (mutating) throw BridgeSshApiRequestException("API 操作结果未知，请先刷新核对，不会自动重复执行。")
            throw BridgeSshApiFallbackException("网络不可达")
        }
        if (!mutating && (response.statusCode == 401 || response.statusCode == 403 || response.statusCode == 404 || response.statusCode >= 500)) {
            throw BridgeSshApiFallbackException("HTTP ${response.statusCode}")
        }
        if (mutating && fallbackWhenMissing && response.statusCode in setOf(404, 405)) {
            throw BridgeSshApiFallbackException("HTTP ${response.statusCode}")
        }
        if (response.statusCode !in 200..299) {
            val detail = if (mutating && response.statusCode >= 500) "操作结果可能未知，请先刷新核对。" else "请检查当前 Session 和权限。"
            throw BridgeSshApiRequestException("Bridge API 请求失败（HTTP ${response.statusCode}）。$detail")
        }
        if (response.statusCode == 204 && response.body.isBlank()) return JSONObject()
        return try {
            JSONObject(response.body)
        } catch (_: Exception) {
            if (mutating) throw BridgeSshApiRequestException("API 操作结果未知，请先刷新核对，不会自动重复执行。")
            throw BridgeSshApiFallbackException("响应无效")
        }
    }

    private fun sessionPrefix(target: BridgeSshTmuxSession): String =
        sessionPrefix(target.id)

    private fun sessionPrefix(id: String): String = "/tmux-dashboard/api/sessions/${encodeQuery(id)}"

    private fun encodeQuery(value: String): String = URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")

    private fun requireTarget(target: BridgeSshTmuxSession?): BridgeSshTmuxSession =
        target ?: throw BridgeSshApiRequestException("当前 SSH 操作缺少 Session。")
}
/** Calls the Bridge CLI over the authenticated SSH exec channel. */
internal class BridgeSshRemoteSession internal constructor(
    private val execute: suspend (String, Int) -> BridgeCbSshExecResult,
    internal val apiClient: BridgeSshApiClient? = null,
) {
    constructor(transport: BridgeCbSshTransport, apiClient: BridgeSshApiClient? = null) :
        this({ command, maxBytes -> transport.exec(command, maxBytes) }, apiClient)

    suspend fun listSessions(fallback: suspend () -> List<BridgeSshTmuxSession>): List<BridgeSshTmuxSession> {
        if (apiClient != null) {
            try { return apiClient.listSessions() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: BridgeSshApiFallbackException) { /* Retain the SSH-only path when Bridge is unavailable. */ }
        }
        return fallback()
    }

    suspend fun listSkills(target: BridgeSshTmuxSession?, fallback: suspend () -> List<BridgeSshSkill>): List<BridgeSshSkill> {
        if (apiClient != null) {
            try { return apiClient.listSkills(target) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: BridgeSshApiFallbackException) { /* Retain remote discovery when Bridge is unavailable. */ }
        }
        return fallback()
    }

    suspend fun downloadGitFile(
        target: BridgeSshTmuxSession, root: String, path: String, output: java.io.OutputStream,
        fallback: suspend () -> Unit,
    ) {
        if (apiClient != null) {
            try { apiClient.downloadFile(target, path, root, output, git = true); return }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: BridgeSshApiFallbackException) { /* No response bytes were written; try SFTP. */ }
        }
        fallback()
    }

    suspend fun uploadComposerAttachment(
        target: BridgeSshTmuxSession?, name: String, mime: String, file: File,
        onProgress: (Long) -> Unit, canReadRemote: suspend (String) -> Boolean,
        fallback: suspend () -> BridgeSshUploadedAttachment,
    ): BridgeSshUploadedAttachment {
        if (apiClient != null && target != null) {
            try {
                val uploaded = apiClient.uploadComposerAttachment(target, name, mime, file, onProgress)
                if (!canReadRemote(uploaded.remotePath)) {
                    throw BridgeSshApiRequestException("附件已上传到 Bridge，但当前 SSH 主机无法读取；请核对两个连接的目标。")
                }
                return uploaded
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: BridgeSshApiFallbackException) { /* API unavailable before upload; retain SFTP. */ }
        }
        return fallback()
    }

    suspend fun call(
        action: String,
        target: BridgeSshTmuxSession? = null,
        arguments: Map<String, String> = emptyMap(),
        identity: BridgeSshTmuxIdentity? = null,
    ): JSONObject = withContext(Dispatchers.IO) {
        var apiFallback: String? = null
        if (action in BRIDGE_SSH_API_FIRST_ACTIONS && apiClient != null) {
            try {
                val result = apiClient.call(action, target, arguments, identity)
                if (action != "list_suspended") return@withContext result
                // Database-free fallback snapshots have their own files. Keep
                // them visible after the paired API becomes reachable again.
                val local = try { withTimeout(4_000) { callRemote(action, target, emptyMap(), identity) } }
                catch (_: TimeoutCancellationException) { null }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { null }
                return@withContext if (local == null) result else mergeBridgeSshSuspended(result, local)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (fallback: BridgeSshApiFallbackException) {
                apiFallback = fallback.diagnostic
            }
        }
        try {
            callRemote(action, target, arguments, identity)
        } catch (_: TimeoutCancellationException) {
            error("SSH 操作超时，结果未知；请刷新会话列表核对。")
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            if (apiFallback != null) {
                val message = sanitizeBridgeSshMessage(failure.message.orEmpty()).ifBlank { "SSH CLI 操作失败。" }
                error("$message（Bridge API 已回退：$apiFallback）")
            }
            throw failure
        }
    }

    private suspend fun callRemote(
        action: String,
        target: BridgeSshTmuxSession?,
        arguments: Map<String, String>,
        identity: BridgeSshTmuxIdentity?,
    ): JSONObject = withTimeout(45_000) {
        val request = JSONObject().put("action", action)
        target?.let { request.put("id", it.id).put("createdAt", it.createdAt).put("cwd", it.cwd) }
        identity?.let { request.put("id", it.id).put("createdAt", it.createdAt) }
        arguments.forEach { (key, value) -> request.put(key, value) }
        val result = execute(BridgeSshRemoteCommand.build(request), 1024 * 1024)
        parseBridgeSshRemoteResult(result)
    }

}

internal fun mergeBridgeSshSuspended(api: JSONObject, local: JSONObject): JSONObject {
    val merged = JSONArray()
    val seen = mutableSetOf<String>()
    for (list in listOf(api.optJSONArray("sessions"), local.optJSONArray("sessions"))) {
        for (index in 0 until (list?.length() ?: 0)) {
            val item = list?.optJSONObject(index) ?: continue
            val key = listOf(item.optString("id"), item.optLong("createdAt", -1).toString(), item.optString("source")).joinToString(":")
            if (seen.add(key)) merged.put(item)
        }
    }
    return JSONObject(api.toString()).put("sessions", merged)
}

/** Match the same per-file patch headers used by the SSH CLI adapter. */
internal fun bridgeSshGitSectionMatches(section: String, path: String, oldPath: String?): Boolean {
    for (line in section.lineSequence()) {
        if (line.startsWith("@@")) break
        if (!line.startsWith("+++ ") && !line.startsWith("--- ")) continue
        var candidate = line.substring(4).removeSuffix("\t")
        if (candidate.startsWith('"')) {
            candidate = runCatching { JSONArray("[$candidate]").getString(0) }.getOrNull() ?: continue
        }
        if (candidate == "b/$path" || candidate == "a/$path" || (oldPath != null && candidate == "a/$oldPath")) return true
    }
    return false
}

/** Parse the bounded SSH result before interpreting its exit status. */
internal fun parseBridgeSshRemoteResult(result: BridgeCbSshExecResult): JSONObject {
    val stdout = result.stdout.toString(Charsets.UTF_8)
    val stderr = result.stderr.toString(Charsets.UTF_8)
    val line = findLastBridgeSshLine(stdout, RESULT_PREFIX)
        ?: findLastBridgeSshLine(stderr, RESULT_PREFIX)
    val diagnostics = findLastBridgeSshLine(stderr, DIAGNOSTIC_PREFIX)
        ?: findLastBridgeSshLine(stdout, DIAGNOSTIC_PREFIX)
    val exit = describeBridgeSshExit(result.exitInfo)
    val context = "${diagnostics?.removePrefix(DIAGNOSTIC_PREFIX)?.take(240)?.ifBlank { null }?.let { ", $it" } ?: ""}, " +
        "$exit, resultLineFound=${line != null}"
    if (line == null) {
        error("远端 Bridge CLI 未返回结果（$context）；请检查安装、远端 shell 和 SSH 连接。")
    }
    val response = try {
        JSONObject(line.removePrefix(RESULT_PREFIX))
    } catch (_: Exception) {
        error("远端 Bridge CLI 返回了无效结果（$context）；请检查远端 CLI 版本。")
    }
    if (!response.optBoolean("ok") || exit != "exitCode=0") {
        val remoteError = sanitizeBridgeSshMessage(response.optString("error"))
            .takeIf { it.isNotEmpty() } ?: "远端操作失败。"
        error("$remoteError（$context）")
    }
    return response.optJSONObject("result")
        ?: error("远端 Bridge CLI 缺少 result（$context）；请检查远端 CLI 版本。")
}

private fun findLastBridgeSshLine(output: String, prefix: String): String? = output.lineSequence()
    .map { it.trimEnd('\r') }
    .lastOrNull { it.startsWith(prefix) }

private fun describeBridgeSshExit(exit: SessionExit): String = when (exit) {
    is SessionExit.Status -> "exitCode=${exit.code}"
    is SessionExit.Signal -> "signal=${exit.signalName}"
    else -> "exit=unknown"
}

private fun sanitizeBridgeSshMessage(value: String): String = value
    .replace(Regex("(?i)\\b(password|token|secret|cookie|authorization)\\s*([=:])\\s*[^\\s,;]+")) {
        "${it.groupValues[1]}${it.groupValues[2]}<redacted>"
    }
    .replace(Regex("\\s+"), " ")
    .trim()
    .take(240)

internal object BridgeSshRemoteCommand {
    fun build(request: JSONObject): String {
        val encoded = Base64.getEncoder().encodeToString(request.toString().toByteArray(Charsets.UTF_8))
        val requestArg = quote(encoded)
        val cliVariable = "\$FEISHU_CODEX_BRIDGE_SSH_CLI"
        val portable = "\$HOME/Applications/Feishu Codex Bridge/current/feishu-codex-bridge"
        val missing = "BRIDGE_SSH_RESULT:{\"ok\":false,\"error\":\"未找到 Bridge CLI，请安装新版 Bridge 或配置 FEISHU_CODEX_BRIDGE_SSH_CLI。\"}"
        val inner = "cli=''; " +
            "if [ -n \"$cliVariable\" ] && [ -x \"$cliVariable\" ]; then cli=\"$cliVariable\"; " +
            "elif candidate=\$(command -v feishu-codex-bridge 2>/dev/null) && [ -n \"\$candidate\" ] && [ -x \"\$candidate\" ]; then cli=\"\$candidate\"; " +
            "elif [ -x \"$portable\" ]; then cli=\"$portable\"; fi; " +
            "safe_cli=\$(printf '%s' \"\$cli\" | tr -c 'A-Za-z0-9_./ -' '_'); " +
            "printf 'BRIDGE_SSH_DIAG:shell=/bin/zsh;executable=%s\\n' \"\$safe_cli\" >&2; " +
            "if [ -n \"\$cli\" ]; then \"\$cli\" ssh-session --offline --request $requestArg; exit \"\$?\"; " +
            "else printf '%s\\n' ${quote(missing)}; exit 127; fi"
        return "/bin/zsh -lic ${quote(inner)}"
    }

    private fun quote(value: String): String = "'" + value.replace("'", "'\"'\"'") + "'"
}
