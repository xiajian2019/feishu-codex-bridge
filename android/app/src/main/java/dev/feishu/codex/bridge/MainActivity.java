package dev.feishu.codex.bridge;

import android.os.Bundle;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

public class MainActivity extends BridgeConnectBotSshActivity {
    private BridgeAutoVpnController autoVpn;
    private final Runnable sshVpnRecovery = () -> {
        if (autoVpn != null) autoVpn.requestSshRecovery();
    };
    @Override
    protected boolean isEmbeddedSshHost() {
        return true;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        if (savedInstanceState != null && savedInstanceState.getBoolean("bridgeShareDurable", false)) {
            getIntent().putExtra("bridgeShareCaptured", true);
            getIntent().putExtra("bridgeShareDurable", true);
        }
        registerPlugin(BridgeCredentialsPlugin.class);
        registerPlugin(BridgeUpdaterPlugin.class);
        registerPlugin(BridgeShareInboxPlugin.class);
        registerPlugin(BridgeNativeThemePlugin.class);
        registerPlugin(BridgeComposerDataPlugin.class);
        registerPlugin(BridgeConnectBotSSHPlugin.class);
        registerPlugin(BridgeMotionPlugin.class);
        registerPlugin(BridgeAutoVpnPlugin.class);
        super.onCreate(savedInstanceState);
        autoVpn = new BridgeAutoVpnController(this, () -> {
            if (bridge != null) {
                bridge.getWebView().evaluateJavascript(
                    "window.dispatchEvent(new Event('bridge:mobile-vpn-reachable'));" +
                    "window.dispatchEvent(new Event('bridge:mobile-resume'));" +
                    "window.dispatchEvent(new Event('online'));", null);
            }
        }, () -> {
            if (bridge != null) {
                bridge.getWebView().evaluateJavascript(
                    "window.dispatchEvent(new Event('bridge:mobile-vpn-target-unreachable'))", null);
            }
        });
        BridgeAutoVpnRecoverySignal.INSTANCE.attach(sshVpnRecovery);
    }

    void requestAutoVpn(BridgeVpnTarget target) {
        if (autoVpn != null) autoVpn.request(target);
    }

    void configureAutoVpn(java.util.List<String> bypassWifiSsids) {
        if (autoVpn != null) autoVpn.configure(bypassWifiSsids);
    }

    java.util.concurrent.CompletableFuture<String> checkAutoVpn(java.util.List<String> bypassWifiSsids) {
        if (autoVpn != null) return autoVpn.checkManually(bypassWifiSsids);
        java.util.concurrent.CompletableFuture<String> unavailable = new java.util.concurrent.CompletableFuture<>();
        unavailable.completeExceptionally(new IllegalStateException("VPN 控制器不可用，请重新打开 App。"));
        return unavailable;
    }

    void requestCurrentWifi(PluginCall call) {
        if (autoVpn == null) {
            call.resolve(new JSObject().put("ssid", ""));
            return;
        }
        autoVpn.readCurrentWifiSsid().whenComplete((ssid, error) -> runOnUiThread(() -> {
            if (error != null) {
                call.reject("无法读取当前 Wi-Fi。", "WIFI_READ_FAILED");
                return;
            }
            call.resolve(new JSObject().put("ssid", ssid == null ? "" : ssid));
        }));
    }

    @Override
    public void onResume() {
        super.onResume();
        if (autoVpn != null) autoVpn.onResume();
    }

    @Override
    public void onPause() {
        if (autoVpn != null) autoVpn.onPause();
        super.onPause();
    }

    @Override
    public void onDestroy() {
        BridgeAutoVpnRecoverySignal.INSTANCE.detach(sshVpnRecovery);
        if (autoVpn != null) autoVpn.close();
        super.onDestroy();
    }

    @Override
    public void onSaveInstanceState(Bundle outState) {
        outState.putBoolean("bridgeShareDurable", getIntent().getBooleanExtra("bridgeShareDurable", false));
        super.onSaveInstanceState(outState);
    }
}
