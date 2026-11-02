package dev.feishu.codex.bridge;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

/** Device-bound credentials. Only authenticated ciphertext is stored in preferences. */
@CapacitorPlugin(name = "BridgeCredentials")
public class BridgeCredentialsPlugin extends Plugin {
    private String server(PluginCall call) throws Exception {
        return BridgeSecureCredentialStore.normalizeServerOrigin(call.getString("server"));
    }

    @PluginMethod
    public void get(PluginCall call) {
        try {
            String origin = server(call);
            BridgeSecureCredentialStore store = new BridgeSecureCredentialStore(getContext());
            JSObject result = new JSObject();
            String token = store.get(origin);
            if (token == null) {
                result.put("token", JSONObject.NULL);
            } else {
                result.put("token", token);
            }
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Unable to read secure Bridge credentials. Pair this device again.", "CREDENTIAL_READ_FAILED");
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        try {
            String origin = server(call);
            String token = call.getString("token");
            new BridgeSecureCredentialStore(getContext()).set(origin, token);
            call.resolve();
        } catch (Exception error) {
            call.reject("Unable to save secure Bridge credentials.", "CREDENTIAL_WRITE_FAILED");
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            new BridgeSecureCredentialStore(getContext()).remove(server(call));
            call.resolve();
        } catch (Exception error) {
            call.reject("Unable to remove secure Bridge credentials.", "CREDENTIAL_REMOVE_FAILED");
        }
    }
}
