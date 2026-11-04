package dev.feishu.codex.bridge

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Build

internal data class BridgeCurrentWifi(val connected: Boolean, val ssid: String?)

internal object BridgeWifiReader {
    @Suppress("DEPRECATION")
    fun read(context: Context): BridgeCurrentWifi {
        val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return BridgeCurrentWifi(false, null)
        val network = connectivity.activeNetwork ?: return BridgeCurrentWifi(false, null)
        val active = connectivity.getNetworkCapabilities(network) ?: return BridgeCurrentWifi(false, null)
        val capabilities = when {
            active.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> active
            // A VPN can be the default network while Wi-Fi is its underlying transport.
            // Inspect connected Wi-Fi as a conservative exemption before starting VPN.
            active.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> connectivity.allNetworks
                .mapNotNull(connectivity::getNetworkCapabilities)
                .firstOrNull { it.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !it.hasTransport(NetworkCapabilities.TRANSPORT_VPN) }
            else -> null
        } ?: return BridgeCurrentWifi(false, null)
        val manager = context.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val transportInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) capabilities.transportInfo as? WifiInfo else null
        val ssid = BridgeAutoVpnPolicy.normalizeWifiSsid(transportInfo?.ssid)
            ?: BridgeAutoVpnPolicy.normalizeWifiSsid(manager?.connectionInfo?.ssid)
        return BridgeCurrentWifi(true, ssid)
    }
}
