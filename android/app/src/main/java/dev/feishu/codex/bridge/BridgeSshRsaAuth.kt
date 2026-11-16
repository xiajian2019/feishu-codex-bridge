package dev.feishu.codex.bridge

import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.KeyFactory
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.RSAPrivateKey
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import org.connectbot.sshlib.AuthHandler
import org.connectbot.sshlib.AuthPublicKey
import org.connectbot.sshlib.AuthResult
import org.connectbot.sshlib.KeyboardInteractiveCallback
import org.connectbot.sshlib.SshClient

/**
 * RSA authentication through cbssh's external signer API.
 *
 * cbssh 0.5.0's byte-array key reader requires an RSAPrivateCrtKey. Android
 * providers can expose an otherwise valid PKCS#8 key as RSAPrivateKey, so
 * stored RSA keys use this handler and let Android JCA perform the signature.
 */
internal object BridgeSshRsaAuth {
    suspend fun authenticate(
        client: SshClient,
        username: String,
        privateKeyData: ByteArray,
        publicKeyLine: String,
    ): AuthResult {
        val privateKey = decodePkcs8PrivateKey(privateKeyData)
        val publicKey = decodePublicKeyLine(publicKeyLine)
        val privateRsa = privateKey as? RSAPrivateKey
            ?: error("Stored SSH key is not RSA")
        val publicRsa = parseRsaPublicBlob(publicKey.publicKeyBlob)
        require(privateRsa.modulus == publicRsa.modulus) {
            "Stored SSH private and public keys do not match"
        }
        return client.authenticate(username, object : AuthHandler {
            override suspend fun onPublicKeysNeeded(): List<AuthPublicKey> = listOf(publicKey)

            override suspend fun onSignatureRequest(
                key: AuthPublicKey,
                dataToSign: ByteArray,
            ): ByteArray {
                val algorithm = key.algorithmName
                val jcaAlgorithm = when (algorithm) {
                    "rsa-sha2-256" -> "SHA256withRSA"
                    "rsa-sha2-512" -> "SHA512withRSA"
                    "ssh-rsa" -> "SHA1withRSA"
                    else -> error("Unsupported RSA SSH signature: $algorithm")
                }
                val signer = Signature.getInstance(jcaAlgorithm)
                signer.initSign(privateKey)
                signer.update(dataToSign)
                return sshSignatureBlob(algorithm, signer.sign())
            }

            override suspend fun onKeyboardInteractivePrompt(
                name: String,
                instruction: String,
                prompts: List<KeyboardInteractiveCallback.Prompt>,
            ): List<String> = emptyList()

            override suspend fun onPasswordNeeded(): String =
                error("Password authentication is not configured for RSA key auth")
        })
    }

    private fun decodePkcs8PrivateKey(data: ByteArray): PrivateKey {
        val text = data.toString(Charsets.UTF_8)
        val begin = text.indexOf("-----BEGIN PRIVATE KEY-----")
        val end = text.indexOf("-----END PRIVATE KEY-----")
        require(begin >= 0 && end > begin) { "Stored RSA key is not unencrypted PKCS#8" }
        val bodyStart = begin + "-----BEGIN PRIVATE KEY-----".length
        val body = text.substring(bodyStart, end).filterNot(Char::isWhitespace)
        val encoded = Base64.getDecoder().decode(body)
        return try {
            KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(encoded))
        } finally {
            encoded.fill(0)
        }
    }

    private fun decodePublicKeyLine(line: String): AuthPublicKey {
        val fields = line.trim().split(Regex("\\s+"), limit = 3)
        require(fields.size >= 2 && fields[0] == "ssh-rsa") { "Stored key is not an RSA SSH key" }
        return AuthPublicKey("ssh-rsa", Base64.getDecoder().decode(fields[1]))
    }

    private fun parseRsaPublicBlob(blob: ByteArray): RsaPublicParts {
        val input = ByteBuffer.wrap(blob)
        val type = readSshString(input).toString(StandardCharsets.US_ASCII)
        require(type == "ssh-rsa") { "Stored key is not an RSA SSH key" }
        val exponent = BigInteger(1, readSshString(input))
        val modulus = BigInteger(1, readSshString(input))
        require(!input.hasRemaining()) { "Stored RSA public key has trailing data" }
        return RsaPublicParts(modulus, exponent)
    }

    private fun sshSignatureBlob(algorithm: String, signature: ByteArray): ByteArray {
        val output = ByteArrayOutputStream()
        writeSshString(output, algorithm.toByteArray(StandardCharsets.US_ASCII))
        writeSshString(output, signature)
        signature.fill(0)
        return output.toByteArray()
    }

    private fun readSshString(input: ByteBuffer): ByteArray {
        require(input.remaining() >= 4) { "Invalid SSH public key blob" }
        val length = input.int
        require(length >= 0 && length <= input.remaining()) { "Invalid SSH public key string" }
        return ByteArray(length).also(input::get)
    }

    private fun writeSshString(output: ByteArrayOutputStream, value: ByteArray) {
        output.write((value.size ushr 24) and 0xff)
        output.write((value.size ushr 16) and 0xff)
        output.write((value.size ushr 8) and 0xff)
        output.write(value.size and 0xff)
        output.write(value)
    }

    private data class RsaPublicParts(val modulus: BigInteger, val exponent: BigInteger)
}
