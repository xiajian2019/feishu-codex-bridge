package dev.feishu.codex.bridge;

import android.os.Bundle;

public class MainActivity extends BridgeConnectBotSshActivity {
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
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onSaveInstanceState(Bundle outState) {
        outState.putBoolean("bridgeShareDurable", getIntent().getBooleanExtra("bridgeShareDurable", false));
        super.onSaveInstanceState(outState);
    }
}
