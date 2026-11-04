package dev.feishu.codex.bridge

import java.nio.CharBuffer
import java.util.Base64
import org.connectbot.sshlib.SshKeys
import org.connectbot.sshlib.SshSigning

internal data class BridgeSshImportedKeyMetadata(
    val nickname: String,
    val algorithm: String,
    val publicKeyLine: String,
)

internal class BridgeSshEncryptedImportException : Exception()

/** Uses ConnectBot's key decoder and public-key SSH wire encoder. */
internal object BridgeSshKeyImporter {
    fun inspect(privateKey: CharArray, requestedName: String): BridgeSshImportedKeyMetadata {
        if (BridgeSshKeySupport.isEncrypted(privateKey)) throw BridgeSshEncryptedImportException()
        // Import can happen before the first SSH connection, so install the same
        // RSA compatibility selection before cbssh decodes a private key.
        BridgeSshCrypto.install()
        // cbssh's public API accepts String input and uses the same decoder as authentication.
        val keyPair = SshKeys.decodePemPrivateKey(privateKey.concatToString(), null)
        val publicKey = SshSigning.encodePublicKey(keyPair)
        val keyType = publicKey.algorithmName
        val publicBlob = publicKey.publicKeyBlob
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
