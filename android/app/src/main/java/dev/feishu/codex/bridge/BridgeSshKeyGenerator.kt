package dev.feishu.codex.bridge

import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.nio.charset.StandardCharsets
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.interfaces.RSAPublicKey
import java.util.Base64
import com.google.crypto.tink.subtle.Ed25519Sign

internal enum class BridgeSshKeyAlgorithm(val label: String, val format: String) {
    ED25519("Ed25519", "openssh-ed25519"),
    RSA("RSA 3072", "pkcs8"),
}

internal data class BridgeGeneratedSshKey(
    val nickname: String,
    val algorithm: BridgeSshKeyAlgorithm,
    val privateKeyPem: CharArray,
    val publicKeyLine: String,
)

/**
 * Minimal ConnectBot-style key generation for the native SSH workspace.
 *
 * The generated private key is returned as PKCS#8 PEM, which is already one
 * of the formats accepted by the existing cbssh authentication path. RSA
 * comes from Android/JCA and Ed25519 uses Tink, which cbssh also uses.
 */
internal object BridgeSshKeyGenerator {
    fun generate(
        algorithm: BridgeSshKeyAlgorithm,
        nickname: String,
    ): BridgeGeneratedSshKey {
        val safeNickname = normalizeNickname(nickname, algorithm)
        return when (algorithm) {
            BridgeSshKeyAlgorithm.ED25519 -> generateEd25519(safeNickname)
            BridgeSshKeyAlgorithm.RSA -> {
                val keyPair = generateRsa()
                BridgeGeneratedSshKey(
                    nickname = safeNickname,
                    algorithm = algorithm,
                    privateKeyPem = privateKeyPem(keyPair.private.encoded).toCharArray(),
                    publicKeyLine = publicKeyLine(keyPair, safeNickname),
                )
            }
        }
    }

    private fun generateEd25519(nickname: String): BridgeGeneratedSshKey {
        val seed = ByteArray(32)
        SecureRandom().nextBytes(seed)
        try {
            val pair = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed)
            val encoded = BridgeEd25519Der.encodePrivateKey(seed)
            val blob = ed25519PublicBlob(pair.publicKey)
            return BridgeGeneratedSshKey(
                nickname = nickname,
                algorithm = BridgeSshKeyAlgorithm.ED25519,
                privateKeyPem = privateKeyPem(encoded).toCharArray(),
                publicKeyLine = "ssh-ed25519 ${Base64.getEncoder().encodeToString(blob)} $nickname",
            )
        } finally {
            seed.fill(0)
        }
    }

    private fun generateRsa(): KeyPair {
        val generator = KeyPairGenerator.getInstance("RSA")
        generator.initialize(3072, SecureRandom())
        return generator.generateKeyPair()
    }

    private fun privateKeyPem(encoded: ByteArray): String {
        return try {
            val body = Base64.getMimeEncoder(64, byteArrayOf('\n'.code.toByte()))
                .encodeToString(encoded)
            "-----BEGIN PRIVATE KEY-----\n$body\n-----END PRIVATE KEY-----\n"
        } finally {
            encoded.fill(0)
        }
    }

    private fun publicKeyLine(keyPair: KeyPair, nickname: String): String {
        val (algorithm, blob) = when (val publicKey = keyPair.public) {
            is RSAPublicKey -> "ssh-rsa" to rsaPublicBlob(publicKey)
            else -> error("Unsupported generated SSH public key: ${publicKey.algorithm}")
        }
        return "$algorithm ${Base64.getEncoder().encodeToString(blob)} $nickname"
    }

    private fun rsaPublicBlob(publicKey: RSAPublicKey): ByteArray {
        val blob = ByteArrayOutputStream()
        writeSshString(blob, "ssh-rsa".toByteArray(StandardCharsets.US_ASCII))
        writeMpInt(blob, publicKey.publicExponent)
        writeMpInt(blob, publicKey.modulus)
        return blob.toByteArray()
    }

    private fun ed25519PublicBlob(raw: ByteArray): ByteArray {
        require(raw.size == 32) { "Unexpected Ed25519 public key length" }
        val blob = ByteArrayOutputStream()
        writeSshString(blob, "ssh-ed25519".toByteArray(StandardCharsets.US_ASCII))
        writeSshString(blob, raw)
        raw.fill(0)
        return blob.toByteArray()
    }

    private fun writeMpInt(output: ByteArrayOutputStream, value: BigInteger) {
        val encoded = value.toByteArray()
        writeSshString(output, encoded)
    }

    private fun writeSshString(output: ByteArrayOutputStream, value: ByteArray) {
        output.write((value.size ushr 24) and 0xff)
        output.write((value.size ushr 16) and 0xff)
        output.write((value.size ushr 8) and 0xff)
        output.write(value.size and 0xff)
        output.write(value)
    }

    private fun normalizeNickname(
        nickname: String,
        algorithm: BridgeSshKeyAlgorithm,
    ): String {
        val fallback = "bridge-${algorithm.name.lowercase()}"
        return nickname.trim()
            .ifBlank { fallback }
            .replace(Regex("[^A-Za-z0-9._-]"), "-")
            .trim('-')
            .take(64)
            .ifBlank { fallback }
    }
}
