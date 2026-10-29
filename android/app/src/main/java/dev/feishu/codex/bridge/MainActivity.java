package dev.feishu.codex.bridge;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        if (savedInstanceState != null && savedInstanceState.getBoolean("bridgeShareDurable", false)) {
            getIntent().putExtra("bridgeShareCaptured", true);
            getIntent().putExtra("bridgeShareDurable", true);
        }
        registerPlugin(BridgeCredentialsPlugin.class);
        registerPlugin(BridgeUpdaterPlugin.class);
        registerPlugin(BridgeShareInboxPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onSaveInstanceState(Bundle outState) {
        outState.putBoolean("bridgeShareDurable", getIntent().getBooleanExtra("bridgeShareDurable", false));
        super.onSaveInstanceState(outState);
    }
}
