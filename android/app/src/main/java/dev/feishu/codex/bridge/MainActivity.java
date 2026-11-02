package dev.feishu.codex.bridge;

import android.os.Bundle;

public class MainActivity extends BridgeConnectBotSshActivity {
    private BridgeAutoVpnController autoVpn;
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
        registerPlugin(BridgeSSHPlugin.class);
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
    }

    void requestAutoVpn(BridgeVpnTarget target) {
        if (autoVpn != null) autoVpn.request(target, true);
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
        if (autoVpn != null) autoVpn.close();
        super.onDestroy();
    }

    @Override
    public void onSaveInstanceState(Bundle outState) {
        outState.putBoolean("bridgeShareDurable", getIntent().getBooleanExtra("bridgeShareDurable", false));
        super.onSaveInstanceState(outState);
    }
}
