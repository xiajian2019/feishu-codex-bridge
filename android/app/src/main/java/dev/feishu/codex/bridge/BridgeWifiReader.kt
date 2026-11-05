package dev.feishu.codex.bridge

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.net.wifi.SupplicantState
import android.os.Build

internal data class BridgeCurrentWifi(val connected: Boolean, val ssid: String?)

internal object BridgeWifiReader {
    @Suppress("DEPRECATION")
    fun read(context: Context): BridgeCurrentWifi {
        val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        val manager = context.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val managerInfo = runCatching { manager?.connectionInfo }.getOrNull()
        val networks = buildList {
            connectivity?.activeNetwork?.let(::add)
            connectivity?.allNetworks?.forEach { if (!contains(it)) add(it) }
        }
        val capabilities = networks
            .mapNotNull { network -> connectivity?.getNetworkCapabilities(network) }
            .firstOrNull { it.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) }
        val transportInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) capabilities?.transportInfo as? WifiInfo else null
        val ssid = BridgeAutoVpnPolicy.normalizeWifiSsid(transportInfo?.ssid)
            ?: BridgeAutoVpnPolicy.normalizeWifiSsid(managerInfo?.ssid)
        // A VPN can become activeNetwork and hide the Wi-Fi network from the
        // old activeNetwork-only lookup. Preserve the Wi-Fi transport signal
        // even when Android redacts the SSID until the proper permission is held.
        val managerConnected = managerInfo != null && (
            ssid != null
                || managerInfo.supplicantState == SupplicantState.COMPLETED
                || managerInfo.networkId != -1
            )
        return BridgeCurrentWifi(capabilities != null || managerConnected, ssid)
    }
}
