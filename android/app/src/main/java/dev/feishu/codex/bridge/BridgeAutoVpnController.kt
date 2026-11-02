package dev.feishu.codex.bridge

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.IBinder
import android.os.SystemClock
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import de.blinkt.openvpn.api.IOpenVPNAPIService
import de.blinkt.openvpn.api.IOpenVPNStatusCallback
import java.net.InetSocketAddress
import java.net.Socket
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
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
    private var attempt: Job? = null
    private var activeTarget: BridgeVpnTarget? = null
    private var lastAttemptAt = -RETRY_COOLDOWN_MS
    private var pendingAuthorization: CompletableDeferred<Boolean>? = null
    private val authorization = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        pendingAuthorization?.complete(result.resultCode == Activity.RESULT_OK)
    }

    fun onResume() {
        resumed.value = true
        // The Web connection layer supplies the configured Bridge host and
        // port. Never probe a baked-in Mac IP from native startup.
        activeTarget?.let { request(it) }
    }

    /** Start a probe for the current Bridge API target from the global Web connection layer. */
    fun request(target: BridgeVpnTarget? = null, force: Boolean = false) {
        if (target != null && attempt?.isActive == true && target != activeTarget) {
            // A foreground startup probe may still be checking the SSH default. The API
            // failure carries the authoritative target, so let that probe take over.
            attempt?.cancel()
            attempt = null
        }
        if (attempt?.isActive == true) return
        val now = SystemClock.elapsedRealtime()
        if (!force && now - lastAttemptAt < RETRY_COOLDOWN_MS) return
        lastAttemptAt = now
        activeTarget = target
        attempt = scope.launch {
            try {
                ensureTargetNetwork(target)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                showMessage("VPN 自动连接失败，请打开 OpenVPN for Android 检查。")
            } finally {
                if (activeTarget === target) activeTarget = null
            }
        }
    }

    fun onPause() { resumed.value = false }

    fun close() {
        pendingAuthorization?.cancel()
        scope.cancel()
    }

    private suspend fun ensureTargetNetwork(requestedTarget: BridgeVpnTarget?) {
        val target = requestedTarget ?: return
        if (isReachable(target)) return
        if (!hasNetwork()) {
            showMessage("当前没有可用网络，暂时无法连接 VPN。")
            return
        }
        onTargetUnreachable.run()

        val bound = bindProvider() ?: run {
            showMessage("未找到 OpenVPN for Android，无法自动连接 VPN。")
            return
        }
        try {
            val service = bound.service
            val accessIntent = withContext(Dispatchers.IO) { service.prepare(activity.packageName) }
            if (accessIntent != null && !requestAuthorization(accessIntent)) {
                showMessage("未授权 OpenVPN 控制，VPN 未自动连接。")
                return
            }

            val available = withContext(Dispatchers.IO) {
                service.profiles.mapNotNull { profile ->
                    val id = profile.mUUID?.trim().orEmpty()
                    if (id.isEmpty()) null else BridgeVpnProfile(id, profile.mName?.trim().orEmpty())
                }.distinctBy { it.id }
            }
            if (available.isEmpty()) {
                showMessage("OpenVPN 中没有可用的 VPN 配置。")
                return
            }
            val prefs = activity.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            val selected = BridgeAutoVpnPolicy.selectedProfile(available, prefs.getString(PROFILE_ID, null))
                ?: selectProfile(available) ?: return
            prefs.edit().putString(PROFILE_ID, selected.id).apply()

            val current = currentStatus(service)
            when (BridgeAutoVpnPolicy.decide(selected.id, current, hasSystemVpn())) {
                BridgeVpnStartDecision.OTHER_VPN -> {
                    showMessage("其他 VPN 正在使用中，未自动切换。")
                    return
                }
                BridgeVpnStartDecision.WAIT -> {
                    showMessage("VPN 已连接或正在连接，正在检查目标主机。")
                }
                BridgeVpnStartDecision.START, BridgeVpnStartDecision.RESUME -> {
                    val vpnIntent = withContext(Dispatchers.IO) { service.prepareVPNService() }
                    if (vpnIntent != null && !requestAuthorization(vpnIntent)) {
                        showMessage("未授予系统 VPN 权限，VPN 未自动连接。")
                        return
                    }
                    // Starting a profile may itself open the provider's password screen.
                    awaitResume()
                    val decision = BridgeAutoVpnPolicy.decide(selected.id, currentStatus(service), hasSystemVpn())
                    when (decision) {
                        BridgeVpnStartDecision.OTHER_VPN -> {
                            showMessage("其他 VPN 正在使用中，未自动切换。")
                            return
                        }
                        BridgeVpnStartDecision.WAIT -> Unit
                        BridgeVpnStartDecision.RESUME -> withContext(Dispatchers.IO) { service.resume() }
                        BridgeVpnStartDecision.START -> withContext(Dispatchers.IO) { service.startProfile(selected.id) }
                    }
                    showMessage("正在连接 OpenVPN，并检查目标主机。")
                }
            }
        } finally {
            bound.close()
        }

        val deadline = SystemClock.elapsedRealtime() + TARGET_WAIT_MS
        while (SystemClock.elapsedRealtime() < deadline) {
            delay(TARGET_RETRY_MS)
            if (isReachable(target)) {
                onTargetReachable.run()
                showMessage("目标主机已可访问。")
                return
            }
        }
        showMessage("已请求 VPN 连接，但目标主机仍不可访问。")
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
        val manager = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = manager.activeNetwork ?: return false
        val capabilities = manager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

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

    private fun showMessage(message: String) {
        if (resumed.value && !activity.isFinishing && !activity.isDestroyed) {
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
        private const val OPENVPN_PACKAGE = "de.blinkt.openvpn"
        private const val PREFERENCES = "bridge_auto_vpn"
        private const val PROFILE_ID = "profile_id"
        private const val PROBE_TIMEOUT_MS = 1_500
        private const val SERVICE_TIMEOUT_MS = 5_000L
        private const val STATUS_TIMEOUT_MS = 1_500L
        private const val TARGET_WAIT_MS = 60_000L
        private const val TARGET_RETRY_MS = 1_500L
        private const val RETRY_COOLDOWN_MS = 30_000L
    }
}
