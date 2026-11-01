package dev.feishu.codex.bridge

import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.nio.charset.StandardCharsets
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.interfaces.RSAPublicKey
import java.util.Base64
import org.bouncycastle.asn1.pkcs.PrivateKeyInfo
import org.bouncycastle.jcajce.interfaces.EdDSAPublicKey
import org.bouncycastle.jce.provider.BouncyCastleProvider

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
 * of the formats accepted by the existing cbssh authentication path. No new
 * crypto dependency is introduced: RSA comes from Android/JCA and Ed25519
 * uses the Bouncy Castle provider already present for sshj compatibility.
 */
internal object BridgeSshKeyGenerator {
    fun generate(
        algorithm: BridgeSshKeyAlgorithm,
        nickname: String,
    ): BridgeGeneratedSshKey {
        val safeNickname = normalizeNickname(nickname, algorithm)
        val keyPair = when (algorithm) {
            BridgeSshKeyAlgorithm.ED25519 -> generateEd25519()
            BridgeSshKeyAlgorithm.RSA -> generateRsa()
        }
        return BridgeGeneratedSshKey(
            nickname = safeNickname,
            algorithm = algorithm,
            privateKeyPem = privateKeyPem(keyPair).toCharArray(),
            publicKeyLine = publicKeyLine(keyPair, safeNickname),
        )
    }

    private fun generateEd25519(): KeyPair {
        val generator = KeyPairGenerator.getInstance("Ed25519", BouncyCastleProvider())
        return generator.generateKeyPair()
    }

    private fun generateRsa(): KeyPair {
        val generator = KeyPairGenerator.getInstance("RSA")
        generator.initialize(3072, SecureRandom())
        return generator.generateKeyPair()
    }

    private fun privateKeyPem(keyPair: KeyPair): String {
        val source = keyPair.private.encoded
        val encoded = try {
            val info = PrivateKeyInfo.getInstance(source)
            if (info.privateKeyAlgorithm.algorithm.id == "1.3.101.112") {
                // Bouncy Castle includes an optional public key in Ed25519
                // PKCS#8 output. cbssh/JCA readers also need the standard
                // private-key-only form for import and authentication.
                PrivateKeyInfo(info.privateKeyAlgorithm, info.parsePrivateKey()).encoded
            } else {
                source.copyOf()
            }
        } finally {
            source.fill(0)
        }
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
            is EdDSAPublicKey -> "ssh-ed25519" to ed25519PublicBlob(publicKey)
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

    private fun ed25519PublicBlob(publicKey: EdDSAPublicKey): ByteArray {
        val raw = publicKey.getPointEncoding()
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
