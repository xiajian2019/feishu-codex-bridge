package dev.feishu.codex.bridge

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.core.content.ContextCompat
import de.blinkt.openvpn.api.IOpenVPNAPIService
import de.blinkt.openvpn.api.IOpenVPNStatusCallback
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.CompletableFuture
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** Reuses a user-authorized OpenVPN for Android profile; never owns the VPN tunnel. */
internal class BridgeAutoVpnController(
    private val activity: MainActivity,
    private val onTargetReachable: Runnable,
    private val onTargetUnreachable: Runnable,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val resumed = MutableStateFlow(false)
    private val connectivity = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val preferences = activity.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    // Null means Web settings have not yet been synchronized on this installation.
    private var bypassWifiSsids: List<String>? = if (preferences.contains(BYPASS_WIFI_SSIDS)) {
        BridgeAutoVpnPolicy.normalizeWifiSsids(preferences.getStringSet(BYPASS_WIFI_SSIDS, emptySet()).orEmpty().toList())
    } else null
    private var networkDebounce: Job? = null
    private var targetProbe: Job? = null
    private var delayedStartCheck: Job? = null
    private val startThrottle = BridgeAutoVpnStartThrottle(START_RETRY_INTERVAL_MS)
    private val checkMutex = Mutex()
    private var activeTarget: BridgeVpnTarget? = null
    private var pendingAuthorization: CompletableDeferred<Boolean>? = null
    private var pendingLocationAuthorization: CompletableDeferred<Boolean>? = null
    private var userDeclinedPrompt = false
    private var resetPromptBlockOnResume = false
    private var lastNotice: String? = null
    private val globalChecks = BridgeAutoVpnCheckQueue(scope) {
        try {
            checkMutex.withLock { ensureVpnConnected() }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            Log.w(TAG, "Global check failed: ${error.javaClass.simpleName}")
            showMessageOnce("VPN 自动连接失败，请打开 OpenVPN for Android 检查。")
        }
    }
    private val authorization = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        pendingAuthorization?.complete(result.resultCode == Activity.RESULT_OK)
    }
    private val locationAuthorization = activity.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
        pendingLocationAuthorization?.complete(grants[Manifest.permission.ACCESS_FINE_LOCATION] == true)
    }
    private fun networkCallback() = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = scheduleNetworkCheck()
        override fun onLost(network: Network) = scheduleNetworkCheck()
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = scheduleNetworkCheck()
    }
    private val defaultNetworkCallback = networkCallback()
    private val underlyingNetworkCallback = networkCallback()
    private var defaultCallbackRegistered = false
    private var underlyingCallbackRegistered = false

    init {
        defaultCallbackRegistered = runCatching {
            connectivity.registerDefaultNetworkCallback(defaultNetworkCallback)
        }.isSuccess
        underlyingCallbackRegistered = runCatching {
            connectivity.registerNetworkCallback(
                NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(),
                underlyingNetworkCallback,
            )
        }.isSuccess
        scope.launch {
            while (isActive) {
                delay(KEEPALIVE_INTERVAL_MS)
                requestGlobalCheck()
            }
        }
    }

    fun onResume() {
        if (resetPromptBlockOnResume) {
            userDeclinedPrompt = false
            resetPromptBlockOnResume = false
            lastNotice = null
        }
        resumed.value = true
        requestGlobalCheck()
    }

    fun onPause() {
        resumed.value = false
        if (userDeclinedPrompt) resetPromptBlockOnResume = true
    }

    /** The same Wi-Fi exceptions apply before pairing and throughout the native SSH UI. */
    fun configure(rawBypassWifiSsids: List<String>) {
        storeWifiSettings(rawBypassWifiSsids)
        requestGlobalCheck()
    }

    private fun storeWifiSettings(rawBypassWifiSsids: List<String>) {
        val normalized = BridgeAutoVpnPolicy.normalizeWifiSsids(rawBypassWifiSsids)
        bypassWifiSsids = normalized
        preferences.edit().putStringSet(BYPASS_WIFI_SSIDS, normalized.toSet()).apply()
    }

    /** A manual check stays in Bridge and reports the actual provider request. */
    fun checkManually(rawBypassWifiSsids: List<String>): CompletableFuture<String> {
        val result = CompletableFuture<String>()
        storeWifiSettings(rawBypassWifiSsids)
        val job = scope.launch {
            try {
                result.complete(checkMutex.withLock {
                    userDeclinedPrompt = false
                    resetPromptBlockOnResume = false
                    ensureVpnConnected(manual = true)
                })
            } catch (cancelled: CancellationException) {
                result.cancel(false)
                throw cancelled
            } catch (error: Exception) {
                Log.w(TAG, "Manual check failed: ${error.javaClass.simpleName}")
                result.completeExceptionally(error)
            }
        }
        job.invokeOnCompletion { error ->
            if (!result.isDone) result.completeExceptionally(error ?: IllegalStateException("VPN check ended"))
        }
        return result
    }

    /** SSH transport failures use the same guarded check as a network change. */
    fun requestSshRecovery() {
        Log.i(TAG, "SSH transport unavailable; requesting a VPN check")
        requestGlobalCheck()
    }

    /** Probe the API target only to retry Bridge after it becomes reachable. */
    fun request(target: BridgeVpnTarget) {
        // A recovery request carries the Web Wi-Fi settings even if its initial
        // configure call failed. Never replace a newer native snapshot here.
        if (bypassWifiSsids == null) configure(target.bypassWifiSsids) else requestGlobalCheck()
        if (targetProbe?.isActive == true && activeTarget == target) return
        targetProbe?.cancel()
        activeTarget = target
        val probe = scope.launch(start = CoroutineStart.LAZY) {
            if (isReachable(target)) return@launch
            onTargetUnreachable.run()
            val deadline = SystemClock.elapsedRealtime() + TARGET_WAIT_MS
            while (SystemClock.elapsedRealtime() < deadline) {
                delay(TARGET_RETRY_MS)
                if (isReachable(target)) {
                    onTargetReachable.run()
                    return@launch
                }
            }
        }
        targetProbe = probe
        probe.invokeOnCompletion {
            if (targetProbe === probe) {
                targetProbe = null
                activeTarget = null
            }
        }
        probe.start()
    }

    private fun scheduleNetworkCheck() {
        scope.launch {
            networkDebounce?.cancel()
            networkDebounce = scope.launch {
                delay(NETWORK_DEBOUNCE_MS)
                requestGlobalCheck()
            }
        }
    }

    private fun requestGlobalCheck() {
        if (bypassWifiSsids != null) globalChecks.request()
        else Log.i(TAG, "VPN check deferred until network settings are synchronized")
    }

    fun readCurrentWifiSsid(): CompletableFuture<String?> {
        val result = CompletableFuture<String?>()
        scope.launch {
            try {
                var state = currentWifiState()
                if (state.connected && state.ssid == null && !hasWifiIdentityPermission() && requestWifiIdentityPermission()) {
                    state = currentWifiState()
                }
                result.complete(state.ssid)
            } catch (cancelled: CancellationException) {
                result.cancel(false)
            } catch (cause: Exception) {
                result.completeExceptionally(cause)
            }
        }
        return result
    }

    fun close() {
        if (defaultCallbackRegistered) runCatching { connectivity.unregisterNetworkCallback(defaultNetworkCallback) }
        if (underlyingCallbackRegistered) runCatching { connectivity.unregisterNetworkCallback(underlyingNetworkCallback) }
        pendingAuthorization?.cancel()
        pendingLocationAuthorization?.cancel()
        scope.cancel()
    }

    private suspend fun ensureVpnConnected(manual: Boolean = false): String {
        fun report(message: String): String {
            if (!manual) showMessageOnce(message)
            return message
        }
        val bypass = bypassWifiSsids ?: return report("VPN 网络设置尚未同步，请重试。")
        if (!hasNetwork()) {
            Log.i(TAG, "VPN check skipped: no active network")
            return report("当前没有可用网络，暂时无法连接 VPN。")
        }
        // Both automatic and user-initiated checks must honor Wi-Fi exemptions.
        wifiStartBlockReason(bypass, manual)?.let { return it }

        val bound = bindProvider() ?: run {
            Log.i(TAG, "VPN check skipped: OpenVPN provider unavailable")
            return report("未找到 OpenVPN for Android，无法连接 VPN。")
        }
        try {
            val service = bound.service
            var authorizationCompleted = false
            val accessIntent = withContext(Dispatchers.IO) { service.prepare(activity.packageName) }
            if (accessIntent != null) {
                if (!resumed.value || userDeclinedPrompt) return report("请回到 Bridge 并授权 OpenVPN 控制后重试。")
                if (!requestAuthorization(accessIntent)) {
                    userDeclinedPrompt = true
                    return report("未授权 OpenVPN 控制，VPN 未连接。")
                }
                authorizationCompleted = true
                // Activity results can arrive before the Activity is resumed.
                awaitResume()
            }

            val available = withContext(Dispatchers.IO) {
                service.profiles.mapNotNull { profile ->
                    val id = profile.mUUID?.trim().orEmpty()
                    if (id.isEmpty()) null else BridgeVpnProfile(id, profile.mName?.trim().orEmpty())
                }.distinctBy { it.id }
            }
            if (available.isEmpty()) return report("OpenVPN 中没有可用的 VPN 配置。")
            val selected = BridgeAutoVpnPolicy.selectedProfile(available, preferences.getString(PROFILE_ID, null))
                ?: run {
                    if (!resumed.value || userDeclinedPrompt) return report("请回到 Bridge 选择 VPN 配置。")
                    selectProfile(available) ?: run {
                        userDeclinedPrompt = true
                        return report("未选择 VPN 配置，VPN 未连接。")
                    }
                }
            preferences.edit().putString(PROFILE_ID, selected.id).apply()

            suspend fun startDecision(): Pair<BridgeVpnStartDecision, BridgeVpnStatus?> {
                val status = currentStatus(service)
                val systemVpnActive = hasSystemVpn()
                val decision = if (manual) BridgeAutoVpnPolicy.decideForManualCheck(selected.id, status, systemVpnActive)
                else BridgeAutoVpnPolicy.decide(selected.id, status, systemVpnActive)
                return decision to status
            }
            val (decision, initialStatus) = startDecision()
            Log.i(TAG, "VPN provider decision: $decision")
            if (!hasNetwork()) return report("当前没有可用网络，暂时无法连接 VPN。")
            wifiStartBlockReason(bypassWifiSsids ?: return "VPN 网络设置尚未同步。", manual)?.let { return it }
            when (decision) {
                BridgeVpnStartDecision.OTHER_VPN -> return report("其他 VPN 正在使用中，未自动切换。")
                BridgeVpnStartDecision.WAIT -> {
                    lastNotice = null
                    return if (manual) awaitConnection(service, selected.id, initialStatus)
                    else "VPN 已连接或正在连接。"
                }
                BridgeVpnStartDecision.AUTH_FAILED -> return report("VPN 认证失败，请检查 OpenVPN 配置后重试。")
                BridgeVpnStartDecision.START, BridgeVpnStartDecision.RESUME -> Unit
            }

            val vpnIntent = withContext(Dispatchers.IO) { service.prepareVPNService() }
            if (vpnIntent != null) {
                if (!resumed.value || userDeclinedPrompt) return report("请回到 Bridge 并授予系统 VPN 权限后重试。")
                if (!requestAuthorization(vpnIntent)) {
                    userDeclinedPrompt = true
                    return report("未授予系统 VPN 权限，VPN 未连接。")
                }
                authorizationCompleted = true
            }
            // OpenVPN may need to display its own credential prompt when starting.
            if (authorizationCompleted) awaitResume()
            if (!hasNetwork()) return report("当前没有可用网络，暂时无法连接 VPN。")
            val (finalDecision, finalStatus) = startDecision()
            // Authorization and provider status checks can outlive a network change.
            wifiStartBlockReason(bypassWifiSsids ?: return "VPN 网络设置尚未同步。", manual)?.let { return it }
            return when (finalDecision) {
                BridgeVpnStartDecision.OTHER_VPN -> report("其他 VPN 正在使用中，未自动切换。")
                BridgeVpnStartDecision.WAIT -> {
                    lastNotice = null
                    if (manual) awaitConnection(service, selected.id, finalStatus)
                    else "VPN 已连接或正在连接。"
                }
                BridgeVpnStartDecision.AUTH_FAILED -> report("VPN 认证失败，请检查 OpenVPN 配置后重试。")
                BridgeVpnStartDecision.RESUME -> if (mayRequestStart(selected.id, manual)) {
                    Log.i(TAG, "Requesting OpenVPN resume")
                    if (manual) awaitConnection(service, selected.id, finalStatus) { service.resume() }
                    else {
                        withContext(Dispatchers.IO) { service.resume() }
                        report("已发起 VPN 恢复连接。")
                    }
                } else "VPN 连接请求已发出，请稍候。"
                BridgeVpnStartDecision.START -> if (mayRequestStart(selected.id, manual)) {
                    Log.i(TAG, "Requesting OpenVPN profile start")
                    if (manual) awaitConnection(service, selected.id, finalStatus) { service.startProfile(selected.id) }
                    else {
                        withContext(Dispatchers.IO) { service.startProfile(selected.id) }
                        report("已发起 VPN 连接。")
                    }
                } else "VPN 连接请求已发出，请稍候。"
            }
        } finally {
            bound.close()
        }
    }

    private fun mayRequestStart(profileId: String, manual: Boolean = false): Boolean {
        val now = SystemClock.elapsedRealtime()
        val waitMs = if (manual) 0L else startThrottle.remainingDelay(profileId, now)
        if (waitMs > 0) {
            if (delayedStartCheck?.isActive != true) {
                delayedStartCheck = scope.launch {
                    delay(waitMs)
                    delayedStartCheck = null
                    requestGlobalCheck()
                }
            }
            return false
        }
        startThrottle.requested(profileId, now)
        return true
    }

    private suspend fun isReachable(target: BridgeVpnTarget): Boolean = withContext(Dispatchers.IO) {
        try {
            Socket().use { it.connect(InetSocketAddress(target.host, target.port), PROBE_TIMEOUT_MS) }
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun hasNetwork(): Boolean {
        val network = connectivity.activeNetwork ?: return false
        return connectivity.getNetworkCapabilities(network) != null
    }

    /** Return why a connection is blocked, including when the current SSID is unknown. */
    private suspend fun wifiStartBlockReason(bypass: List<String>, manual: Boolean): String? {
        fun blocked(message: String, notify: Boolean = true): String {
            if (!manual && notify) showMessageOnce(message)
            return message
        }
        var state = if (bypass.isEmpty()) BridgeCurrentWifi(false, null) else currentWifiState()
        Log.i(TAG, "Wi-Fi policy input: connected=${state.connected}, ssidKnown=${state.ssid != null}, exemptions=${bypass.size}")
        var decision = BridgeAutoVpnPolicy.networkDecision(true, state.connected, state.ssid, bypass, hasWifiIdentityPermission())
        if (decision == BridgeVpnNetworkDecision.REQUEST_LOCATION) {
            if (!resumed.value || userDeclinedPrompt) {
                return blocked("无法确认当前 Wi‑Fi，已跳过 VPN 连接。请允许精确位置权限后重试。", notify = false)
            }
            if (!requestWifiIdentityPermission()) {
                userDeclinedPrompt = true
                return blocked("无法识别当前 Wi‑Fi，已跳过 VPN 连接。请允许精确位置权限后重试。")
            }
            state = currentWifiState()
            decision = BridgeAutoVpnPolicy.networkDecision(true, state.connected, state.ssid, bypass, hasWifiIdentityPermission())
        }
        return when (decision) {
            BridgeVpnNetworkDecision.CHECK -> null
            BridgeVpnNetworkDecision.SKIP_WIFI -> {
                Log.i(TAG, "VPN check skipped: Wi-Fi is exempt")
                blocked("当前 Wi‑Fi 已在免 VPN 列表，已跳过 VPN 连接。", notify = false)
            }
            BridgeVpnNetworkDecision.UNKNOWN_WIFI, BridgeVpnNetworkDecision.REQUEST_LOCATION -> {
                Log.i(TAG, "VPN check skipped: Wi-Fi identity unavailable")
                blocked("无法识别当前 Wi‑Fi，已跳过 VPN 连接。请确认系统位置服务已开启。")
            }
            BridgeVpnNetworkDecision.NO_NETWORK -> blocked("当前没有可用网络，暂时无法连接 VPN。")
        }
    }

    private fun hasWifiIdentityPermission(): Boolean = ContextCompat.checkSelfPermission(
        activity,
        Manifest.permission.ACCESS_FINE_LOCATION,
    ) == PackageManager.PERMISSION_GRANTED

    private suspend fun requestWifiIdentityPermission(): Boolean {
        pendingLocationAuthorization?.let { return it.await() }
        awaitResume()
        val result = CompletableDeferred<Boolean>()
        pendingLocationAuthorization = result
        return try {
            // Android 12+ requires coarse and fine together to present the
            // precise-location choice. Only the SSID is read afterwards.
            locationAuthorization.launch(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION))
            result.await()
        } finally {
            if (pendingLocationAuthorization === result) pendingLocationAuthorization = null
        }
    }

    @Suppress("DEPRECATION")
    private fun currentWifiState(): BridgeCurrentWifi = BridgeWifiReader.read(activity)

    private fun hasSystemVpn(): Boolean {
        val manager = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        return manager.allNetworks.any { network ->
            manager.getNetworkCapabilities(network)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
        }
    }

    private suspend fun bindProvider(): BoundService? {
        val ready = CompletableDeferred<IOpenVPNAPIService>()
        val connection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
                if (binder == null) ready.completeExceptionally(IllegalStateException("VPN service unavailable"))
                else ready.complete(IOpenVPNAPIService.Stub.asInterface(binder))
            }
            override fun onServiceDisconnected(name: ComponentName?) {
                ready.completeExceptionally(IllegalStateException("VPN service disconnected"))
            }
            override fun onBindingDied(name: ComponentName?) {
                ready.completeExceptionally(IllegalStateException("VPN service binding died"))
            }
            override fun onNullBinding(name: ComponentName?) {
                ready.completeExceptionally(IllegalStateException("VPN service unavailable"))
            }
        }
        val intent = Intent(IOpenVPNAPIService::class.java.name).setPackage(OPENVPN_PACKAGE)
        val bound = try { activity.bindService(intent, connection, Context.BIND_AUTO_CREATE) }
        catch (_: SecurityException) { false }
        if (!bound) return null
        var handedOff = false
        try {
            val service = withTimeoutOrNull(SERVICE_TIMEOUT_MS) { ready.await() } ?: return null
            handedOff = true
            return BoundService(activity, connection, service)
        } finally {
            if (!handedOff) runCatching { activity.unbindService(connection) }
        }
    }

    private suspend fun currentStatus(service: IOpenVPNAPIService): BridgeVpnStatus? {
        val first = CompletableDeferred<BridgeVpnStatus>()
        val callback = object : IOpenVPNStatusCallback.Stub() {
            override fun newStatus(uuid: String?, state: String?, message: String?, level: String?) {
                first.complete(BridgeVpnStatus(uuid, level))
            }
        }
        var registered = false
        return try {
            withContext(Dispatchers.IO) { service.registerStatusCallback(callback) }
            registered = true
            withTimeoutOrNull(STATUS_TIMEOUT_MS) { first.await() }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            null
        } finally {
            if (registered) withContext(NonCancellable + Dispatchers.IO) { runCatching { service.unregisterStatusCallback(callback) } }
        }
    }

    /** Register before a manual start so the UI can wait for the provider's real result. */
    private suspend fun awaitConnection(
        service: IOpenVPNAPIService,
        profileId: String,
        initialStatus: BridgeVpnStatus?,
        start: (suspend () -> Unit)? = null,
    ): String {
        if (initialStatus?.level == "LEVEL_CONNECTED"
            && (initialStatus.profileId.isNullOrBlank() || initialStatus.profileId == profileId)
        ) return "VPN 连接成功"

        val result = CompletableDeferred<String>()
        var requestIssued = start == null
        var startSucceeded = start == null
        val callback = object : IOpenVPNStatusCallback.Stub() {
            override fun newStatus(uuid: String?, state: String?, message: String?, level: String?) {
                if (!uuid.isNullOrBlank() && uuid != profileId) return
                when (level) {
                    "LEVEL_CONNECTED" -> result.complete("VPN 连接成功")
                    "LEVEL_AUTH_FAILED" -> if (requestIssued) result.complete("VPN 认证失败，请检查 OpenVPN 配置后重试。")
                    "LEVEL_GENERAL_ERROR" -> if (requestIssued) result.complete("VPN 连接失败，请检查 OpenVPN 配置后重试。")
                    "LEVEL_NONETWORK" -> if (requestIssued) result.complete("VPN 当前没有可用网络，请稍后重试。")
                }
            }
        }
        var registered = false
        return try {
            withContext(Dispatchers.IO) { service.registerStatusCallback(callback) }
            registered = true
            if (start != null) {
                if (!hasNetwork()) return "当前没有可用网络，暂时无法连接 VPN。"
                wifiStartBlockReason(bypassWifiSsids ?: return "VPN 网络设置尚未同步。", manual = true)?.let { return it }
                withContext(Dispatchers.IO) { start() }
                startSucceeded = true
                // Ignore a stale status callback delivered while OpenVPN handled the start request.
                requestIssued = true
            }
            withTimeoutOrNull(MANUAL_CONNECT_TIMEOUT_MS) { result.await() }
                ?: "VPN 连接仍在建立，请稍后检查。"
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            if (startSucceeded) "VPN 已发起，但暂时无法确认连接状态。"
            else "VPN 启动失败，请检查网络和 OpenVPN 配置后重试。"
        } finally {
            if (registered) withContext(NonCancellable + Dispatchers.IO) {
                runCatching { service.unregisterStatusCallback(callback) }
            }
        }
    }

    private suspend fun requestAuthorization(intent: Intent): Boolean {
        awaitResume()
        val result = CompletableDeferred<Boolean>()
        pendingAuthorization = result
        return try {
            authorization.launch(intent)
            result.await()
        } finally {
            if (pendingAuthorization === result) pendingAuthorization = null
        }
    }

    private suspend fun selectProfile(profiles: List<BridgeVpnProfile>): BridgeVpnProfile? {
        awaitResume()
        return suspendCancellableCoroutine { continuation ->
            val labels = profiles.mapIndexed { index, profile -> profile.label.ifBlank { "VPN ${index + 1}" } }.toTypedArray()
            val dialog = AlertDialog.Builder(activity)
                .setTitle("选择自动连接的 VPN")
                .setItems(labels) { _, index -> if (continuation.isActive) continuation.resume(profiles[index]) }
                .setNegativeButton("取消") { _, _ -> if (continuation.isActive) continuation.resume(null) }
                .setOnCancelListener { if (continuation.isActive) continuation.resume(null) }
                .create()
            continuation.invokeOnCancellation { dialog.dismiss() }
            dialog.show()
        }
    }

    private suspend fun awaitResume() { resumed.first { it } }

    private fun showMessageOnce(message: String) {
        if (message != lastNotice && resumed.value && !activity.isFinishing && !activity.isDestroyed) {
            lastNotice = message
            Toast.makeText(activity, message, Toast.LENGTH_LONG).show()
        }
    }

    private class BoundService(
        private val context: Context,
        private val connection: ServiceConnection,
        val service: IOpenVPNAPIService,
    ) {
        fun close() { runCatching { context.unbindService(connection) } }
    }

    companion object {
        private const val TAG = "BridgeAutoVpn"
        private const val OPENVPN_PACKAGE = "de.blinkt.openvpn"
        private const val PREFERENCES = "bridge_auto_vpn"
        private const val PROFILE_ID = "profile_id"
        private const val BYPASS_WIFI_SSIDS = "bypass_wifi_ssids"
        private const val KEEPALIVE_INTERVAL_MS = 30_000L
        private const val START_RETRY_INTERVAL_MS = 30_000L
        private const val NETWORK_DEBOUNCE_MS = 1_000L
        private const val PROBE_TIMEOUT_MS = 1_500
        private const val SERVICE_TIMEOUT_MS = 5_000L
        private const val STATUS_TIMEOUT_MS = 1_500L
        private const val MANUAL_CONNECT_TIMEOUT_MS = 30_000L
        private const val TARGET_WAIT_MS = 60_000L
        private const val TARGET_RETRY_MS = 1_500L
    }
}
