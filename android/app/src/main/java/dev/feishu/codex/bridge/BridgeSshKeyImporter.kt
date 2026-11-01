package dev.feishu.codex.bridge

import java.nio.CharBuffer
import java.security.PublicKey
import java.util.Base64
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.common.KeyType
import org.bouncycastle.asn1.x509.SubjectPublicKeyInfo
import org.connectbot.sshlib.SshKeys

internal data class BridgeSshImportedKeyMetadata(
    val nickname: String,
    val algorithm: String,
    val publicKeyLine: String,
)

internal class BridgeSshEncryptedImportException : Exception()

/** Uses cbssh's public key decoder and sshj's public SSH wire encoder. */
internal object BridgeSshKeyImporter {
    fun inspect(privateKey: CharArray, requestedName: String): BridgeSshImportedKeyMetadata {
        if (BridgeSshKeySupport.isEncrypted(privateKey)) throw BridgeSshEncryptedImportException()
        // cbssh's public API accepts String input and uses the same decoder as authentication.
        val publicKey = SshKeys.decodePemPrivateKey(privateKey.concatToString(), null).public
        val (keyType, publicBlob) = encodePublicKey(publicKey)
        val nickname = requestedName.trim()
            .replace(Regex("[^A-Za-z0-9._-]"), "-")
            .trim('-')
            .take(64)
            .ifBlank { "imported-key" }
        return BridgeSshImportedKeyMetadata(
            nickname = nickname,
            algorithm = when (keyType) {
                "ssh-rsa" -> "RSA"
                "ssh-ed25519" -> "Ed25519"
                else -> keyType
            },
            publicKeyLine = "$keyType ${Base64.getEncoder().encodeToString(publicBlob)} $nickname",
        )
    }

    private fun encodePublicKey(publicKey: PublicKey): Pair<String, ByteArray> {
        val subjectPublicKeyInfo = SubjectPublicKeyInfo.getInstance(publicKey.encoded)
        // cbssh returns its own Ed25519 JCA key class; sshj's encoder expects
        // its unrelated EdDSA class. Decode the standard X.509 key instead.
        if (subjectPublicKeyInfo.algorithm.algorithm.id == "1.3.101.112") {
            val raw = subjectPublicKeyInfo.publicKeyData.bytes
            require(raw.size == 32) { "Invalid Ed25519 public key" }
            val blob = Buffer.PlainBuffer().putString("ssh-ed25519").putString(raw).compactData
            return "ssh-ed25519" to blob
        }
        val type = KeyType.fromKey(publicKey)
        require(type in setOf(KeyType.RSA, KeyType.ECDSA256, KeyType.ECDSA384, KeyType.ECDSA521)) {
            "Unsupported SSH public key algorithm"
        }
        return type.toString() to Buffer.PlainBuffer().putPublicKey(publicKey).compactData
    }
}

/** Convert a private key to UTF-8 without retaining an extra immutable String. */
internal fun sshPrivateKeyBytes(privateKey: CharArray): ByteArray {
    val buffer = Charsets.UTF_8.encode(CharBuffer.wrap(privateKey))
    return try {
        ByteArray(buffer.remaining()).also { buffer.get(it) }
    } finally {
        if (buffer.hasArray()) buffer.array().fill(0)
    }
}
