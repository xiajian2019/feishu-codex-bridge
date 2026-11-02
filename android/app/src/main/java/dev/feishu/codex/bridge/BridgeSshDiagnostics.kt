package dev.feishu.codex.bridge

import org.json.JSONArray
import org.json.JSONObject

/** Bounded operational diagnostics; never record terminal bytes or user drafts. */
internal class BridgeSshDiagnostics {
    private val events = ArrayDeque<JSONObject>()
    var recording: Boolean = false
        private set

    @Synchronized
    fun start() {
        events.clear()
        recording = true
        record("start")
    }

    @Synchronized
    fun record(event: String, amount: Int? = null) {
        if (!recording) return
        if (events.size >= 500) events.removeFirst()
        events.addLast(JSONObject().put("time", System.currentTimeMillis()).put("event", event).apply {
            if (amount != null) put("bytes", amount)
        })
    }

    @Synchronized
    fun finish(snapshot: JSONObject): ByteArray {
        record("stop")
        recording = false
        return encode(snapshot, JSONArray(events.toList()))
    }

    @Synchronized
    fun snapshot(snapshot: JSONObject): ByteArray = encode(snapshot, JSONArray(events.toList()))

    private fun encode(snapshot: JSONObject, events: JSONArray): ByteArray = JSONObject()
        .put("version", 1).put("capturedAt", System.currentTimeMillis())
        .put("terminal", snapshot).put("events", events).toString(2).toByteArray(Charsets.UTF_8)
}
