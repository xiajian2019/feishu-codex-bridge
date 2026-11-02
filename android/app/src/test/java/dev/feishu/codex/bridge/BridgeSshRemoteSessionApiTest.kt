package dev.feishu.codex.bridge

import java.io.IOException
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeSshRemoteSessionApiTest {
    private val target = BridgeSshTmuxSession(
        id = "\$7",
        name = "alpha",
        windows = 1,
        attached = true,
        cwd = "/fixture",
        createdAt = 42L,
    )

    @Test
    fun accountAndUsageOperationsUseBridgeApiWithTokenAndSessionGuard() = runBlocking {
        val transport = RecordingApiTransport { method, path, body ->
            when {
                path == "https://bridge.example/api/session" -> response(200, "{\"actionToken\":\"action-token\"}")
                path.endsWith("/sessions/%247/identity") -> response(200, "{\"session\":{\"id\":\"\$7\",\"codexHomeId\":\"second\"}}")
                path.endsWith("/api/codex-homes") -> response(200, "{\"codexHomes\":[{\"id\":\"second\",\"label\":\"Second\",\"available\":true}]}" )
                path == "https://bridge.example/api/codex/homes" -> response(200, "{\"homes\":[{\"id\":\"second\",\"path\":\"/home/.codex/accounts/second\",\"label\":\"Second\"}]}" )
                path == "https://bridge.example/api/codex/usage?home=second" -> response(200, "{\"accounts\":[{\"homeId\":\"second\",\"quota\":{\"planType\":\"plus\",\"buckets\":[{\"limitId\":\"codex\",\"primary\":{\"usedPercent\":16}}]}}]}" )
                method == "POST" && path.endsWith("/codex-account") -> response(200, "{\"session\":{\"codexHomeId\":\"second\"}}")
                method == "POST" && path.endsWith("/codex-account/check") -> response(200, "{\"status\":\"matched\",\"home\":{\"id\":\"second\"}}")
                else -> error("unexpected request: $method $path body=$body")
            }
        }
        val client = BridgeSshApiClient("https://bridge.example", "bridge-token", transport)

        assertEquals("second", client.call("accounts", target).getString("selected"))
        assertEquals("second", client.call("mark_account", target, mapOf("home" to "second")).getString("selected"))
        assertEquals("second", client.call("refresh_account", target).getString("selected"))
        assertEquals(16, client.call("usage", target, mapOf("home" to "second"))
            .getJSONObject("rateLimitsByLimitId").getJSONObject("codex")
            .getJSONObject("primary").getInt("usedPercent"))

        assertTrue(transport.requests.isNotEmpty())
        transport.requests.forEach { request ->
            assertEquals("Bearer bridge-token", request.headers["Authorization"])
            assertEquals("capacitor://localhost", request.headers["Origin"])
            if (request.path != "https://bridge.example/api/session") {
                assertEquals("action-token", request.headers["X-Bridge-Action-Token"])
            }
        }
        val sessionRequests = transport.requests.filter { it.path.endsWith("/sessions/%247/identity") }
        assertTrue(sessionRequests.isNotEmpty())
        assertTrue(sessionRequests.all { it.headers["X-Bridge-Session-Created-At"] == "42" })
        val mark = transport.requests.first { it.method == "POST" && it.path.endsWith("/codex-account") }
        assertEquals("{\"homeId\":\"second\"}", mark.body)
        assertEquals("42", mark.headers["X-Bridge-Session-Created-At"])
    }

    @Test
    fun networkAuthMissingAndServerErrorsAreFallbackSignals() = runBlocking {
        listOf(401, 403, 404, 500).forEach { status ->
            val client = BridgeSshApiClient(
                "https://bridge.example",
                "bridge-token",
                RecordingApiTransport { _, _, _ -> response(status, "{}") },
            )
            val failure = runCatching { client.call("accounts", target) }.exceptionOrNull()
            assertTrue(failure is BridgeSshApiFallbackException)
            assertEquals("HTTP $status", (failure as BridgeSshApiFallbackException).diagnostic)
        }

        val network = BridgeSshApiClient(
            "https://bridge.example",
            "bridge-token",
            object : BridgeSshApiTransport {
                override suspend fun request(method: String, url: String, headers: Map<String, String>, body: String?) =
                    throw IOException("untrusted network detail")
            },
        )
        val networkFailure = runCatching { network.call("accounts", target) }.exceptionOrNull()
        assertTrue(networkFailure is BridgeSshApiFallbackException)
        assertEquals("网络不可达", (networkFailure as BridgeSshApiFallbackException).diagnostic)

        val malformed = BridgeSshApiClient(
            "https://bridge.example",
            "bridge-token",
            RecordingApiTransport { _, _, _ -> response(200, "not-json") },
        )
        assertTrue(runCatching { malformed.call("accounts", target) }.exceptionOrNull() is BridgeSshApiFallbackException)
    }

    private fun response(status: Int, body: String) = BridgeSshHttpResponse(status, body)

    private data class Request(
        val method: String,
        val path: String,
        val headers: Map<String, String>,
        val body: String?,
    )

    private class RecordingApiTransport(
        private val handler: suspend (method: String, path: String, body: String?) -> BridgeSshHttpResponse,
    ) : BridgeSshApiTransport {
        val requests = mutableListOf<Request>()

        override suspend fun request(
            method: String,
            url: String,
            headers: Map<String, String>,
            body: String?,
        ): BridgeSshHttpResponse {
            requests += Request(method, url, headers.toMap(), body)
            return handler(method, url, body)
        }
    }
}
