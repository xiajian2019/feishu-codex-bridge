package dev.feishu.codex.bridge

import org.json.JSONArray
import org.json.JSONObject
import java.util.Collections
import java.util.IdentityHashMap
import java.util.Locale

/** Fixed vocabulary keeps terminal contents, credentials and arbitrary exception messages out of reports. */
internal enum class BridgeSshTraceEvent {
    CAPTURE_STARTED, CAPTURE_STOPPED, PROCESS_OBSERVED, PROCESS_STARTED, PROCESS_EXIT_REPORTED,
    ACTIVITY_CREATED, ACTIVITY_STARTED, ACTIVITY_RESTARTED, ACTIVITY_RESUMED, ACTIVITY_PAUSED, ACTIVITY_STOPPED,
    ACTIVITY_SAVE_STATE, ACTIVITY_DESTROYED, ACTIVITY_NEW_INTENT, ACTIVITY_CONFIGURATION_CHANGED,
    ACTIVITY_FOCUS_CHANGED, ACTIVITY_TRIM_MEMORY, ACTIVITY_LOW_MEMORY,
    WORKSPACE_OPENED, WORKSPACE_CLOSED, PICKER_OPENED, PICKER_RETURNED,
    SESSION_ATTACHED, SESSION_DETACHED, SESSION_CREATED, SESSION_REUSED, SESSION_CLOSED, SESSION_FAILED,
    CONNECTION_STARTED, CONNECTION_PHASE, CONNECTION_SUCCEEDED, CONNECTION_FAILED, CONNECTION_CANCELLED,
    HOST_KEY_PROMPTED, HOST_KEY_DECIDED, RECONNECT_STARTED, RECONNECT_SKIPPED, RECONNECT_TARGET,
    TRANSPORT_DISCONNECTED, TERMINAL_EOF, TERMINAL_READ_FAILED, TERMINAL_WRITE_FAILED, TERMINAL_RESIZE_FAILED,
    KEEPALIVE_RESULT, KEEPALIVE_METHOD, SERVICE_SNAPSHOT, SERVICE_REQUESTED, SERVICE_STARTED, SERVICE_FAILED, SERVICE_STOPPED,
    NETWORK_AVAILABLE, NETWORK_LOST, NETWORK_CHANGED, NETWORK_MONITOR_FAILED,
}

internal enum class BridgeSshTraceField {
    SESSION, ATTEMPT, DETAIL, AUTH_METHOD, HOST_KEY_CHANGED, SAVED_STATE, EMBEDDED, FINISHING, CHANGING_CONFIGURATION, PICKER_ACTIVE, SELECTION_PRESENT,
    WINDOW_FOCUSED, MEMORY_LEVEL, ORIENTATION,
    AUTHENTICATED, SHELL_OPEN, PENDING_CONNECTIONS, ACTIVE_SESSIONS, FOREGROUND_REQUESTED, FOREGROUND_RUNNING, FAILURE_REASON,
    FAILURE_COUNT, DURATION_MS, PID, SDK, VERSION_CODE, NETWORK_VALIDATED, NETWORK_METERED,
    EXIT_REASON, EXIT_TIME_MS, EXIT_IMPORTANCE, EXIT_STATUS, ERROR,
}

internal enum class BridgeSshTraceDetail {
    USER, AUTOMATIC, RESTORED, NORMAL, ERROR, TIMEOUT, EXCEPTION, PUBLIC_KEY, PASSWORD,
    CONNECT, LOAD_KEY, AUTHENTICATE, OPEN_SHELL, REGISTERED, UNKNOWN,
    TRANSPORT, STDOUT, STDERR, WRITE, RESIZE, KEEPALIVE,
    PING, PTY_WINDOW, PING_UNSUPPORTED, NOT_AUTHENTICATED,
    THROTTLED, NO_SAVED_KEY, CONNECTING, HEALTHY, FAILED, CLOSED,
    ACCEPTED, REJECTED, TARGET_FOUND, TARGET_MISSING,
    ALGORITHM_MISMATCH, HOST_KEY_REJECTED, PROTOCOL_ERROR, TRANSPORT_ERROR, AUTH_REJECTED, AUTH_ERROR,
    EXIT_SELF, EXIT_SIGNALED, EXIT_LOW_MEMORY, EXIT_CRASH, EXIT_NATIVE_CRASH, EXIT_ANR,
    EXIT_USER_REQUESTED, EXIT_USER_STOPPED, EXIT_RESOURCE_LIMIT, EXIT_PERMISSION_CHANGE, EXIT_OTHER,
    WIFI, CELLULAR, ETHERNET, VPN, OTHER,
}

internal interface BridgeSshActivityLogStorage {
    fun load(): String?
    fun save(value: String)
}

/** Bounded opt-in event stream, independent of a screen or a particular SSH session. */
internal class BridgeSshActivityLog(
    private val storage: BridgeSshActivityLogStorage,
    private val wallClock: () -> Long = System::currentTimeMillis,
    private val monotonicClock: () -> Long = { 0L },
    private val capacity: Int = 800,
) {
    private val events = ArrayDeque<JSONObject>()
    var recording: Boolean = false
        private set
    var startedAt: Long = 0
        private set
    val hasCapture: Boolean get() = startedAt > 0

    init {
        require(capacity > 0)
        runCatching {
            val saved = storage.load()?.let(::JSONObject) ?: return@runCatching
            recording = saved.optBoolean("recording", false)
            startedAt = saved.optLong("startedAt", 0).coerceAtLeast(0)
            val rows = saved.optJSONArray("events") ?: JSONArray()
            val first = (rows.length() - capacity).coerceAtLeast(0)
            for (index in first until rows.length()) rows.optJSONObject(index)?.let(events::addLast)
        }
    }

    @Synchronized
    fun start() {
        events.clear()
        startedAt = wallClock()
        recording = true
        record(BridgeSshTraceEvent.CAPTURE_STARTED)
    }

    @Synchronized
    fun stop() {
        if (!recording) return
        record(BridgeSshTraceEvent.CAPTURE_STOPPED)
        recording = false
        persist()
    }

    @Synchronized
    fun record(event: BridgeSshTraceEvent, vararg fields: Pair<BridgeSshTraceField, Any?>) {
        if (!recording) return
        val row = JSONObject().put("time", wallClock()).put("elapsedMs", monotonicClock())
            .put("event", event.name.lowercase(Locale.ROOT).replace('_', '.'))
        fields.forEach { (field, value) ->
            val safe = when (value) {
                is Boolean, is Int, is Long -> value
                is BridgeSshTraceDetail -> value.name.lowercase(Locale.ROOT)
                is Throwable -> safeErrorTypes(value)
                else -> null
            }
            if (safe != null) row.put(field.name.lowercase(Locale.ROOT), safe)
            if (field == BridgeSshTraceField.ERROR && value is Throwable) {
                safeErrorReason(value)?.let { row.put("error_reason", it) }
            }
        }
        if (events.size >= capacity) events.removeFirst()
        events.addLast(row)
        persist()
    }

    @Synchronized
    fun snapshot(): JSONObject = JSONObject()
        .put("recording", recording).put("startedAt", startedAt)
        .put("events", JSONArray(events.map { JSONObject(it.toString()) }))

    private fun persist() {
        // Preferences can fail on a damaged/full device; recording in memory still works.
        runCatching { storage.save(snapshot().toString()) }
    }

    private fun safeErrorReason(error: Throwable): String? {
        val visited = Collections.newSetFromMap(IdentityHashMap<Throwable, Boolean>())
        var current: Throwable? = error
        while (current != null && visited.add(current)) {
            val message = current.message.orEmpty().lowercase(Locale.ROOT)
            val reason = when {
                "econnreset" in message || "connection reset" in message -> "connection_reset"
                "econnaborted" in message || "connection abort" in message -> "connection_aborted"
                "broken pipe" in message || "epipe" in message -> "broken_pipe"
                "enetunreach" in message || "network is unreachable" in message -> "network_unreachable"
                "ehostunreach" in message || "no route to host" in message -> "host_unreachable"
                "econnrefused" in message || "connection refused" in message -> "connection_refused"
                "etimedout" in message || "timed out" in message || current is java.net.SocketTimeoutException -> "timeout"
                "socket closed" in message || "socket is closed" in message -> "socket_closed"
                current is java.io.EOFException -> "end_of_stream"
                current is java.net.UnknownHostException -> "dns_failure"
                current is SecurityException -> "security_exception"
                else -> null
            }
            if (reason != null) return reason
            current = current.cause
        }
        return null
    }

    private fun safeErrorTypes(error: Throwable): JSONArray {
        val visited = Collections.newSetFromMap(IdentityHashMap<Throwable, Boolean>())
        val names = JSONArray()
        var current: Throwable? = error
        while (current != null && names.length() < 5 && visited.add(current)) {
            val name = current.javaClass.simpleName.filter { it.isLetterOrDigit() || it == '_' || it == '$' }.take(80)
            names.put(name.ifBlank { "Exception" })
            current = current.cause
        }
        return names
    }
}
