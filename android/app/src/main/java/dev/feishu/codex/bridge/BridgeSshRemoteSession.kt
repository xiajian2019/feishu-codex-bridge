package dev.feishu.codex.bridge

import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.connectbot.sshlib.SessionExit
import org.json.JSONArray
import org.json.JSONObject

private const val RESULT_PREFIX = "BRIDGE_SSH_RESULT:"
private const val DIAGNOSTIC_PREFIX = "BRIDGE_SSH_DIAG:"
private const val NATIVE_APP_ORIGIN = "capacitor://localhost"
private const val MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024
private val API_FIRST_ACTIONS = setOf("accounts", "mark_account", "refresh_account", "usage")

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
private class BridgeSshApiRequestException(message: String) : Exception(message)

/** Native API-first implementation for the four account and usage operations. */
internal class BridgeSshApiClient(
    private val serverOrigin: String,
    private val bearerToken: String,
    private val transport: BridgeSshApiTransport = AndroidBridgeSshApiTransport(),
) {
    suspend fun call(
        action: String,
        target: BridgeSshTmuxSession? = null,
        arguments: Map<String, String> = emptyMap(),
    ): JSONObject {
        val actionToken = requestActionToken()
        return when (action) {
            "accounts" -> accounts(target, actionToken)
            "mark_account" -> markAccount(requireTarget(target), arguments, actionToken)
            "refresh_account" -> refreshAccount(requireTarget(target), actionToken)
            "usage" -> usage(requireTarget(target), arguments, actionToken)
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
    ): JSONObject {
        val headers = linkedMapOf(
            "Accept" to "application/json",
            "Authorization" to "Bearer $bearerToken",
            "Origin" to NATIVE_APP_ORIGIN,
        )
        if (actionToken != null) headers["X-Bridge-Action-Token"] = actionToken
        if (target != null) headers["X-Bridge-Session-Created-At"] = target.createdAt.toString()
        val response = try {
            transport.request(method, serverOrigin + path, headers, body?.toString())
        } catch (_: Exception) {
            throw BridgeSshApiFallbackException("网络不可达")
        }
        if (response.statusCode == 401 || response.statusCode == 403 || response.statusCode == 404 || response.statusCode >= 500) {
            throw BridgeSshApiFallbackException("HTTP ${response.statusCode}")
        }
        if (response.statusCode !in 200..299) {
            throw BridgeSshApiRequestException("Bridge API 请求失败（HTTP ${response.statusCode}）。")
        }
        return try {
            JSONObject(response.body)
        } catch (_: Exception) {
            throw BridgeSshApiFallbackException("响应无效")
        }
    }

    private fun sessionPrefix(target: BridgeSshTmuxSession): String =
        "/tmux-dashboard/api/sessions/${URLEncoder.encode(target.id, Charsets.UTF_8.name()).replace("+", "%20")}"

    private fun requireTarget(target: BridgeSshTmuxSession?): BridgeSshTmuxSession =
        target ?: throw BridgeSshApiRequestException("当前 SSH 操作缺少 Session。")
}
/** Calls the Bridge CLI over the authenticated SSH exec channel. */
internal class BridgeSshRemoteSession(
    private val transport: BridgeCbSshTransport,
    private val apiClient: BridgeSshApiClient? = null,
) {
    suspend fun call(
        action: String,
        target: BridgeSshTmuxSession? = null,
        arguments: Map<String, String> = emptyMap(),
        identity: BridgeSshTmuxIdentity? = null,
    ): JSONObject = withContext(Dispatchers.IO) {
        var apiFallback: String? = null
        if (action in API_FIRST_ACTIONS && apiClient != null) {
            try {
                return@withContext apiClient.call(action, target, arguments)
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
        target?.let { request.put("id", it.id).put("createdAt", it.createdAt) }
        identity?.let { request.put("id", it.id).put("createdAt", it.createdAt) }
        arguments.forEach { (key, value) -> request.put(key, value) }
        val result = transport.exec(BridgeSshRemoteCommand.build(request), 1024 * 1024)
        parseBridgeSshRemoteResult(result)
    }

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
