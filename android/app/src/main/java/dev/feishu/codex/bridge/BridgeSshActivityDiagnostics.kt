package dev.feishu.codex.bridge

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

/** App-scoped opt-in diagnostic capture. It never holds an Activity or SSH credentials. */
internal object BridgeSshActivityDiagnostics {
    @Volatile private var log: BridgeSshActivityLog? = null
    private var applicationContext: Context? = null
    private val nextSession = AtomicInteger()
    private val nextAttempt = AtomicInteger()
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var lastNetworkState: Triple<BridgeSshTraceDetail, Boolean, Boolean>? = null
    var recording by mutableStateOf(false)
        private set
    var hasCapture by mutableStateOf(false)
        private set

    @Synchronized
    fun initialize(context: Context) {
        if (log != null) return
        val app = context.applicationContext
        applicationContext = app
        val preferences = app.getSharedPreferences("bridge-ssh-activity-diagnostics", Context.MODE_PRIVATE)
        val loaded = BridgeSshActivityLog(object : BridgeSshActivityLogStorage {
            override fun load(): String? = preferences.getString("capture", null)
            override fun save(value: String) { preferences.edit().putString("capture", value).apply() }
        }, monotonicClock = SystemClock::elapsedRealtime)
        log = loaded
        recording = loaded.recording
        hasCapture = loaded.hasCapture
        if (loaded.recording) {
            recordProcessStart(BridgeSshTraceDetail.RESTORED)
            recordPreviousProcessExits(app, loaded.startedAt)
            startNetworkMonitor(app)
        }
    }

    fun start(context: Context) {
        initialize(context)
        val current = log ?: return
        current.start()
        recording = true
        hasCapture = true
        recordProcessStart(BridgeSshTraceDetail.NORMAL)
        applicationContext?.let(::startNetworkMonitor)
    }

    fun stop() {
        stopNetworkMonitor()
        log?.stop()
        recording = false
    }

    fun nextSessionId(): Int = nextSession.incrementAndGet()
    fun nextAttemptId(): Int = nextAttempt.incrementAndGet()

    fun record(event: BridgeSshTraceEvent, vararg fields: Pair<BridgeSshTraceField, Any?>) {
        log?.record(event, *fields, BridgeSshTraceField.PID to Process.myPid())
    }

    fun snapshot(context: Context): JSONObject {
        val app = context.applicationContext
        val info = runCatching { app.packageManager.getPackageInfo(app.packageName, 0) }.getOrNull()
        @Suppress("DEPRECATION")
        val versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info?.longVersionCode else info?.versionCode?.toLong()
        val power = app.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val batteryExempt = runCatching { power?.isIgnoringBatteryOptimizations(app.packageName) }.getOrNull()
        return JSONObject().put("recording", log?.recording == true)
            .put("startedAt", log?.startedAt ?: 0)
            .put("device", JSONObject()
                .put("androidApi", Build.VERSION.SDK_INT)
                .put("manufacturer", safeDeviceName(Build.MANUFACTURER))
                .put("model", safeDeviceName(Build.MODEL))
                .put("appVersion", info?.versionName ?: "unknown")
                .put("appVersionCode", versionCode ?: 0)
                .put("batteryOptimizationExempt", batteryExempt ?: JSONObject.NULL))
            .put("events", log?.snapshot()?.optJSONArray("events") ?: org.json.JSONArray())
    }

    private fun recordProcessStart(detail: BridgeSshTraceDetail) {
        val event = if (detail == BridgeSshTraceDetail.RESTORED) BridgeSshTraceEvent.PROCESS_STARTED else BridgeSshTraceEvent.PROCESS_OBSERVED
        record(event, BridgeSshTraceField.DETAIL to detail, BridgeSshTraceField.SDK to Build.VERSION.SDK_INT)
    }

    private fun recordPreviousProcessExits(context: Context, startedAt: Long) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        try {
            val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            manager.getHistoricalProcessExitReasons(context.packageName, 0, 5)
                .filter { it.processName == context.packageName && it.timestamp >= startedAt }
                .forEach { exit ->
                    record(BridgeSshTraceEvent.PROCESS_EXIT_REPORTED,
                        BridgeSshTraceField.EXIT_REASON to exit.reason,
                        BridgeSshTraceField.DETAIL to exitReason(exit.reason),
                        BridgeSshTraceField.EXIT_TIME_MS to exit.timestamp,
                        BridgeSshTraceField.EXIT_IMPORTANCE to exit.importance,
                        BridgeSshTraceField.EXIT_STATUS to exit.status)
                }
        } catch (_: Exception) { /* Exit history is optional on individual devices. */ }
    }

    private fun exitReason(reason: Int): BridgeSshTraceDetail = when (reason) {
        ApplicationExitInfo.REASON_EXIT_SELF -> BridgeSshTraceDetail.EXIT_SELF
        ApplicationExitInfo.REASON_SIGNALED -> BridgeSshTraceDetail.EXIT_SIGNALED
        ApplicationExitInfo.REASON_LOW_MEMORY -> BridgeSshTraceDetail.EXIT_LOW_MEMORY
        ApplicationExitInfo.REASON_CRASH -> BridgeSshTraceDetail.EXIT_CRASH
        ApplicationExitInfo.REASON_CRASH_NATIVE -> BridgeSshTraceDetail.EXIT_NATIVE_CRASH
        ApplicationExitInfo.REASON_ANR -> BridgeSshTraceDetail.EXIT_ANR
        ApplicationExitInfo.REASON_USER_REQUESTED -> BridgeSshTraceDetail.EXIT_USER_REQUESTED
        ApplicationExitInfo.REASON_USER_STOPPED -> BridgeSshTraceDetail.EXIT_USER_STOPPED
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> BridgeSshTraceDetail.EXIT_RESOURCE_LIMIT
        ApplicationExitInfo.REASON_PERMISSION_CHANGE -> BridgeSshTraceDetail.EXIT_PERMISSION_CHANGE
        else -> BridgeSshTraceDetail.EXIT_OTHER
    }

    @Synchronized
    private fun startNetworkMonitor(context: Context) {
        if (networkCallback != null) return
        try {
            val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val callback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) { record(BridgeSshTraceEvent.NETWORK_AVAILABLE) }
                override fun onLost(network: Network) {
                    synchronized(this@BridgeSshActivityDiagnostics) { lastNetworkState = null }
                    record(BridgeSshTraceEvent.NETWORK_LOST)
                }
                override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                    val type = when {
                        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> BridgeSshTraceDetail.VPN
                        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> BridgeSshTraceDetail.WIFI
                        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> BridgeSshTraceDetail.CELLULAR
                        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> BridgeSshTraceDetail.ETHERNET
                        else -> BridgeSshTraceDetail.OTHER
                    }
                    val validated = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                    val metered = !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
                    val next = Triple(type, validated, metered)
                    val changed = synchronized(this@BridgeSshActivityDiagnostics) {
                        if (lastNetworkState == next) false else { lastNetworkState = next; true }
                    }
                    if (changed) record(BridgeSshTraceEvent.NETWORK_CHANGED,
                        BridgeSshTraceField.DETAIL to type, BridgeSshTraceField.NETWORK_VALIDATED to validated,
                        BridgeSshTraceField.NETWORK_METERED to metered)
                }
            }
            manager.registerDefaultNetworkCallback(callback)
            networkCallback = callback
        } catch (error: Exception) {
            record(BridgeSshTraceEvent.NETWORK_MONITOR_FAILED, BridgeSshTraceField.ERROR to error)
        }
    }

    @Synchronized
    private fun stopNetworkMonitor() {
        val callback = networkCallback ?: return
        networkCallback = null
        lastNetworkState = null
        val manager = applicationContext?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        runCatching { manager?.unregisterNetworkCallback(callback) }
    }

    private fun safeDeviceName(value: String): String = value
        .filter { it.isLetterOrDigit() || it in " ._-" }.take(80).ifBlank { "unknown" }
}
