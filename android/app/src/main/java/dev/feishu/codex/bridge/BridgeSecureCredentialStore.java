package dev.feishu.codex.bridge;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Shared AndroidKeyStore-backed storage for the current Bridge credentials. */
public final class BridgeSecureCredentialStore {
    private static final String KEY_ALIAS = "dev.feishu.codex.bridge.credentials.v1";
    private static final String PREFERENCES = "bridge_credentials";

    private final Context context;

    public BridgeSecureCredentialStore(Context context) {
        this.context = context.getApplicationContext();
    }

    /** Returns a canonical HTTP(S) origin and rejects paths, query strings, and userinfo. */
    public static String normalizeServerOrigin(String value) throws Exception {
        if (value == null || value.length() > 2048) throw new IllegalArgumentException();
        URI uri = new URI(value);
        String scheme = uri.getScheme();
        if (scheme == null) throw new IllegalArgumentException();
        scheme = scheme.toLowerCase(Locale.ROOT);
        if (!("https".equals(scheme) || "http".equals(scheme))
            || uri.getHost() == null || uri.getUserInfo() != null
            || uri.getRawQuery() != null || uri.getFragment() != null
            || (uri.getRawPath() != null && !uri.getRawPath().isEmpty() && !"/".equals(uri.getRawPath()))) {
            throw new IllegalArgumentException();
        }
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        if (host.indexOf(':') >= 0) host = "[" + host + "]";
        int port = uri.getPort();
        if (("https".equals(scheme) && port == 443) || ("http".equals(scheme) && port == 80)) port = -1;
        return scheme + "://" + host + (port > 0 ? ":" + port : "");
    }

    public String get(String serverOrigin) throws Exception {
        String origin = normalizeServerOrigin(serverOrigin);
        String encrypted = preferences().getString(storageKey(origin), null);
        if (encrypted == null) return null;
        String[] parts = encrypted.split(":", 2);
        if (parts.length != 2) throw new IllegalStateException();
        byte[] plaintext = null;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secretKey(),
                new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            cipher.updateAAD(origin.getBytes(StandardCharsets.UTF_8));
            plaintext = cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP));
            return new String(plaintext, StandardCharsets.UTF_8);
        } finally {
            if (plaintext != null) Arrays.fill(plaintext, (byte) 0);
        }
    }

    public void set(String serverOrigin, String token) throws Exception {
        String origin = normalizeServerOrigin(serverOrigin);
        if (token == null || token.isEmpty() || token.length() > 16384) throw new IllegalArgumentException();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, secretKey());
        byte[] plaintext = token.getBytes(StandardCharsets.UTF_8);
        byte[] encrypted;
        try {
            cipher.updateAAD(origin.getBytes(StandardCharsets.UTF_8));
            encrypted = cipher.doFinal(plaintext);
        } finally {
            Arrays.fill(plaintext, (byte) 0);
        }
        String value = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":"
            + Base64.encodeToString(encrypted, Base64.NO_WRAP);
        Arrays.fill(encrypted, (byte) 0);
        if (!preferences().edit().putString(storageKey(origin), value).commit()) throw new IllegalStateException();
    }

    public void remove(String serverOrigin) throws Exception {
        if (!preferences().edit().remove(storageKey(normalizeServerOrigin(serverOrigin))).commit()) {
            throw new IllegalStateException();
        }
    }

    private SharedPreferences preferences() {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private String storageKey(String origin) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(origin.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(hash, Base64.NO_WRAP | Base64.URL_SAFE);
    }

    private static synchronized SecretKey secretKey() throws Exception {
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
}
