package dev.feishu.codex.bridge

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.MessageDigest
import java.util.Locale
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal data class BridgeVncCredentials(
    val username: String,
    val password: String,
)

/** Device-bound VNC credentials, encrypted with a non-exportable Android Keystore key. */
internal class BridgeVncCredentialStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    fun get(host: String, port: Int): BridgeVncCredentials? {
        val identity = identity(host, port)
        val encrypted = preferences.getString(storageKey(identity), null) ?: return null
        return try {
            val parts = encrypted.split(":", limit = 2)
            if (parts.size != 2) return null
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
            cipher.updateAAD(identity.toByteArray(StandardCharsets.UTF_8))
            val json = JSONObject(String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8))
            val username = json.optString("username", "")
            val password = json.optString("password", "")
            if (username.length > MAX_USERNAME_LENGTH || password.length > MAX_PASSWORD_LENGTH) null
            else BridgeVncCredentials(username, password)
        } catch (_: Exception) {
            null
        }
    }

    fun set(host: String, port: Int, credentials: BridgeVncCredentials) {
        require(credentials.username.length <= MAX_USERNAME_LENGTH)
        require(credentials.password.length <= MAX_PASSWORD_LENGTH)
        val identity = identity(host, port)
        val plaintext = JSONObject().apply {
            put("username", credentials.username)
            put("password", credentials.password)
        }.toString().toByteArray(StandardCharsets.UTF_8)
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, secretKey())
            cipher.updateAAD(identity.toByteArray(StandardCharsets.UTF_8))
            val encrypted = cipher.doFinal(plaintext)
            val value = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
                Base64.encodeToString(encrypted, Base64.NO_WRAP)
            check(preferences.edit().putString(storageKey(identity), value).commit()) { "Unable to save VNC credentials" }
            encrypted.fill(0)
        } finally {
            plaintext.fill(0)
        }
    }

    fun remove(host: String, port: Int) {
        preferences.edit().remove(storageKey(identity(host, port))).apply()
    }

    private fun identity(host: String, port: Int): String {
        require(port in 1..65_535)
        val normalizedHost = host.trim().lowercase(Locale.ROOT)
        require(normalizedHost.isNotEmpty() && normalizedHost.length <= 253)
        return "$normalizedHost:$port"
    }

    private fun storageKey(identity: String): String = Base64.encodeToString(
        MessageDigest.getInstance("SHA-256").digest(identity.toByteArray(StandardCharsets.UTF_8)),
        Base64.NO_WRAP or Base64.URL_SAFE,
    )

    private fun secretKey(): SecretKey = synchronized(KEY_LOCK) {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (store.containsAlias(KEY_ALIAS)) return@synchronized store.getKey(KEY_ALIAS, null) as SecretKey
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .setKeySize(256)
                .build())
        }.generateKey()
    }

    private companion object {
        const val KEY_ALIAS = "dev.feishu.codex.bridge.vnc.credentials.v1"
        const val PREFERENCES = "bridge_vnc_credentials"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val MAX_USERNAME_LENGTH = 256
        const val MAX_PASSWORD_LENGTH = 512
        val KEY_LOCK = Any()
    }
}
