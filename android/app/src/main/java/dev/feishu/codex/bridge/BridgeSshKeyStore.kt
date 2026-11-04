package dev.feishu.codex.bridge

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray
import org.json.JSONObject

internal data class BridgeSshStoredKey(
    val id: String,
    val nickname: String,
    val algorithm: String,
    val publicKeyLine: String,
    val createdAt: Long,
)

/** Refuse all mutations if the existing vault JSON cannot be read losslessly. */
internal object BridgeSshKeyRecords {
    fun parse(raw: String): List<JSONObject> {
        try {
            val array = JSONArray(raw)
            return buildList(array.length()) {
                for (index in 0 until array.length()) {
                    add(array.optJSONObject(index) ?: throw IllegalStateException("Invalid SSH key record"))
                }
            }
        } catch (_: Exception) {
            throw IllegalStateException("SSH key records are malformed")
        }
    }

    fun rewrite(raw: String, transform: (List<JSONObject>) -> List<JSONObject>): String {
        val updated = transform(parse(raw))
        return JSONArray().apply { updated.forEach(::put) }.toString()
    }
}

/**
 * Small persistent key vault for the native SSH page.
 *
 * ConnectBot keeps pubkey records in its Room data layer and distinguishes
 * exportable keys from Android Keystore-backed keys. We keep the same boundary
 * without importing Room: metadata and AES-GCM ciphertext live in app-private
 * SharedPreferences, while the AES wrapping key is non-exportable Android
 * Keystore material. cbssh receives plaintext only for the active connection.
 */
internal object BridgeSshKeyStore {
    private const val PREFERENCES = "bridge_ssh_keys"
    private const val RECORDS = "records"
    private const val KEY_ALIAS = "bridge.ssh.key-wrap.v1"
    private const val AES_TRANSFORMATION = "AES/GCM/NoPadding"

    @Synchronized
    fun save(context: Context, generated: BridgeGeneratedSshKey): BridgeSshStoredKey {
        return saveKey(
            context,
            generated.nickname,
            generated.algorithm.label,
            generated.publicKeyLine,
            generated.privateKeyPem,
        )
    }

    @Synchronized
    fun importKey(context: Context, privateKey: CharArray, name: String): BridgeSshStoredKey {
        val metadata = BridgeSshKeyImporter.inspect(privateKey, name)
        return saveKey(context, metadata.nickname, metadata.algorithm, metadata.publicKeyLine, privateKey)
    }

    private fun saveKey(
        context: Context,
        nickname: String,
        algorithm: String,
        publicKeyLine: String,
        privateKey: CharArray,
    ): BridgeSshStoredKey {
        val id = UUID.randomUUID().toString()
        val createdAt = System.currentTimeMillis()
        val encrypted = encrypt(context, sshPrivateKeyBytes(privateKey))
        val stored = BridgeSshStoredKey(
            id = id,
            nickname = nickname,
            algorithm = algorithm,
            publicKeyLine = publicKeyLine,
            createdAt = createdAt,
        )
        val record = JSONObject()
            .put("id", stored.id)
            .put("nickname", stored.nickname)
            .put("algorithm", stored.algorithm)
            .put("publicKeyLine", stored.publicKeyLine)
            .put("createdAt", stored.createdAt)
            .put("iv", encoded(encrypted.iv))
            .put("ciphertext", encoded(encrypted.ciphertext))
        val updated = BridgeSshKeyRecords.rewrite(rawRecords(context)) { it + record }
        check(preferences(context).edit().putString(RECORDS, updated).commit()) {
            "Unable to persist SSH key"
        }
        return stored
    }

    fun list(context: Context): List<BridgeSshStoredKey> = readRecords(context)
        .mapNotNull(::toStoredKey)
        .sortedByDescending { it.createdAt }

    fun metadata(context: Context, id: String): BridgeSshStoredKey =
        list(context).firstOrNull { it.id == id } ?: error("SSH key not found")

    @Synchronized
    fun loadPrivateKey(context: Context, id: String): CharArray {
        val record = readRecords(context).firstOrNull { it.optString("id") == id }
            ?: error("SSH key not found")
        val plaintext = decrypt(
            context,
            decode(record.optString("iv")),
            decode(record.optString("ciphertext")),
        )
        return try {
            plaintext.toString(StandardCharsets.UTF_8).toCharArray()
        } finally {
            plaintext.fill(0)
        }
    }

    @Synchronized
    fun delete(context: Context, id: String) {
        val updated = BridgeSshKeyRecords.rewrite(rawRecords(context)) { records ->
            records.filterNot { it.optString("id") == id }
        }
        check(preferences(context).edit().putString(RECORDS, updated).commit()) {
            "Unable to delete SSH key"
        }
    }

    private fun preferences(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    private fun rawRecords(context: Context): String =
        preferences(context).getString(RECORDS, "[]") ?: "[]"

    private fun readRecords(context: Context): List<JSONObject> =
        BridgeSshKeyRecords.parse(rawRecords(context))

    private fun toStoredKey(record: JSONObject): BridgeSshStoredKey? {
        val id = record.optString("id").takeIf { it.isNotBlank() } ?: return null
        val nickname = record.optString("nickname").takeIf { it.isNotBlank() } ?: return null
        val publicKeyLine = record.optString("publicKeyLine").takeIf { it.isNotBlank() } ?: return null
        return BridgeSshStoredKey(
            id = id,
            nickname = nickname,
            algorithm = record.optString("algorithm", "SSH"),
            publicKeyLine = publicKeyLine,
            createdAt = record.optLong("createdAt", 0L),
        )
    }

    private data class EncryptedKey(val iv: ByteArray, val ciphertext: ByteArray)

    private fun encrypt(context: Context, plaintext: ByteArray): EncryptedKey {
        return try {
            val cipher = Cipher.getInstance(AES_TRANSFORMATION)
            // Android Keystore owns IV generation for GCM encryption. Passing a
            // caller-provided IV is rejected on Android 11/API 30 and later.
            cipher.init(Cipher.ENCRYPT_MODE, wrappingKey(context))
            val iv = cipher.iv.copyOf()
            EncryptedKey(iv, cipher.doFinal(plaintext))
        } finally {
            plaintext.fill(0)
        }
    }

    private fun decrypt(context: Context, iv: ByteArray, ciphertext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(AES_TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, wrappingKey(context), GCMParameterSpec(128, iv))
        return cipher.doFinal(ciphertext)
    }

    private fun wrappingKey(context: Context): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setKeySize(256)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    private fun encoded(value: ByteArray): String = Base64.encodeToString(value, Base64.NO_WRAP)

    private fun decode(value: String): ByteArray = Base64.decode(value, Base64.NO_WRAP)
}
