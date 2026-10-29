package dev.feishu.codex.bridge;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Device-bound credentials. Only authenticated ciphertext is stored in preferences. */
@CapacitorPlugin(name = "BridgeCredentials")
public class BridgeCredentialsPlugin extends Plugin {
    private static final String KEY_ALIAS = "dev.feishu.codex.bridge.credentials.v1";
    private static final String PREFERENCES = "bridge_credentials";

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private String server(PluginCall call) throws Exception {
        String value = call.getString("server");
        if (value == null || value.length() > 2048) throw new IllegalArgumentException();
        URI uri = new URI(value);
        if (!("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()))
            || uri.getHost() == null || uri.getUserInfo() != null
            || uri.getRawQuery() != null || uri.getFragment() != null) {
            throw new IllegalArgumentException();
        }
        return value;
    }

    private String storageKey(String server) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(server.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(hash, Base64.NO_WRAP | Base64.URL_SAFE);
    }

    private synchronized SecretKey secretKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return (SecretKey) store.getKey(KEY_ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }

    @PluginMethod
    public void get(PluginCall call) {
        try {
            String origin = server(call);
            String encrypted = preferences().getString(storageKey(origin), null);
            JSObject result = new JSObject();
            if (encrypted == null) {
                result.put("token", JSONObject.NULL);
            } else {
                String[] parts = encrypted.split(":", 2);
                if (parts.length != 2) throw new IllegalStateException();
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, secretKey(),
                    new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
                cipher.updateAAD(origin.getBytes(StandardCharsets.UTF_8));
                byte[] plaintext = cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP));
                result.put("token", new String(plaintext, StandardCharsets.UTF_8));
                java.util.Arrays.fill(plaintext, (byte) 0);
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
            if (token == null || token.isEmpty() || token.length() > 16384) throw new IllegalArgumentException();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, secretKey());
            cipher.updateAAD(origin.getBytes(StandardCharsets.UTF_8));
            byte[] plaintext = token.getBytes(StandardCharsets.UTF_8);
            byte[] encrypted;
            try {
                encrypted = cipher.doFinal(plaintext);
            } finally {
                java.util.Arrays.fill(plaintext, (byte) 0);
            }
            String value = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":"
                + Base64.encodeToString(encrypted, Base64.NO_WRAP);
            if (!preferences().edit().putString(storageKey(origin), value).commit()) throw new IllegalStateException();
            call.resolve();
        } catch (Exception error) {
            call.reject("Unable to save secure Bridge credentials.", "CREDENTIAL_WRITE_FAILED");
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            if (!preferences().edit().remove(storageKey(server(call))).commit()) throw new IllegalStateException();
            call.resolve();
        } catch (Exception error) {
            call.reject("Unable to remove secure Bridge credentials.", "CREDENTIAL_REMOVE_FAILED");
        }
    }
}
