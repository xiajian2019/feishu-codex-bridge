package dev.feishu.codex.bridge

import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.nio.ByteBuffer
import java.security.KeyPairGenerator
import java.security.Security
import java.security.interfaces.ECPublicKey
import java.security.interfaces.RSAPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import org.connectbot.sshlib.SshKeys
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeSshKeyImporterTest {
    @Test
    fun importsRsaBeforeTheFirstSshConnection() {
        val generated = BridgeSshKeyGenerator.generate(BridgeSshKeyAlgorithm.RSA, "cold-import")
        val name = "Bridge SSH Crypto"
        val previous = Security.getProvider(name)
        val previousPosition = previous?.let { Security.getProviders().indexOf(it) + 1 }
        Security.removeProvider(name)
        try {
            val imported = BridgeSshKeyImporter.inspect(generated.privateKeyPem, "cold-import")
            assertEquals("RSA", imported.algorithm)
            assertArrayEquals(blob(generated.publicKeyLine), blob(imported.publicKeyLine))
            assertNotNull(Security.getProvider(name))
        } finally {
            Security.removeProvider(name)
            if (previous != null && previousPosition != null) Security.insertProviderAt(previous, previousPosition)
            generated.privateKeyPem.fill('\u0000')
        }
    }

    @Test
    fun importsPkcs8AndDerivesTheSamePublicKeyAsGeneration() {
        val generated = BridgeSshKeyGenerator.generate(BridgeSshKeyAlgorithm.RSA, "test-key")
        try {
            val imported = BridgeSshKeyImporter.inspect(generated.privateKeyPem, "phone key")
            assertEquals("phone-key", imported.nickname)
            assertEquals("RSA", imported.algorithm)
            assertArrayEquals(blob(generated.publicKeyLine), blob(imported.publicKeyLine))
        } finally {
            generated.privateKeyPem.fill('\u0000')
        }
    }

    @Test
    fun importsEd25519Pkcs8AndRetainsItsPublicIdentity() {
        val generated = BridgeSshKeyGenerator.generate(BridgeSshKeyAlgorithm.ED25519, "phone-ed25519")
        try {
            val imported = BridgeSshKeyImporter.inspect(generated.privateKeyPem, "ed25519")
            assertEquals("Ed25519", imported.algorithm)
            assertArrayEquals(blob(generated.publicKeyLine), blob(imported.publicKeyLine))
        } finally {
            generated.privateKeyPem.fill('\u0000')
        }
    }

    @Test
    fun importsOpenSshKeyAndDerivesPublicKeyFromThePrivateKey() {
        val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val privateKey = SshKeys.encodeOpenSshPrivateKey(pair, null).toCharArray()
        try {
            val imported = BridgeSshKeyImporter.inspect(privateKey, "id_rsa")
            assertTrue(imported.publicKeyLine.startsWith("ssh-rsa "))
            assertArrayEquals(rsaBlob(pair.public as RSAPublicKey), blob(imported.publicKeyLine))
        } finally {
            privateKey.fill('\u0000')
        }
    }

    @Test
    fun importsOpenSshEd25519AndRetainsItsPublicIdentity() {
        val generated = BridgeSshKeyGenerator.generate(BridgeSshKeyAlgorithm.ED25519, "phone-ed25519")
        var privateKey: CharArray? = null
        try {
            val pair = SshKeys.decodePemPrivateKey(generated.privateKeyPem.concatToString(), null)
            val openSshPrivateKey = SshKeys.encodeOpenSshPrivateKey(pair, null).toCharArray()
            privateKey = openSshPrivateKey
            val imported = BridgeSshKeyImporter.inspect(openSshPrivateKey, "phone-ed25519")
            assertEquals("Ed25519", imported.algorithm)
            assertArrayEquals(blob(generated.publicKeyLine), blob(imported.publicKeyLine))
        } finally {
            generated.privateKeyPem.fill('\u0000')
            privateKey?.fill('\u0000')
        }
    }

    @Test
    fun importsOpenSshEcKeysWithTheirOriginalPublicPoints() {
        for ((curve, sshCurve, coordinateBytes) in listOf(
            Triple("secp256r1", "nistp256", 32),
            Triple("secp384r1", "nistp384", 48),
            Triple("secp521r1", "nistp521", 66),
        )) {
            val pair = KeyPairGenerator.getInstance("EC").apply {
                initialize(ECGenParameterSpec(curve))
            }.generateKeyPair()
            val privateKey = SshKeys.encodeOpenSshPrivateKey(pair, null).toCharArray()
            try {
                val imported = BridgeSshKeyImporter.inspect(privateKey, "ec-key")
                val expectedType = "ecdsa-sha2-$sshCurve"
                assertEquals(expectedType, imported.algorithm)
                assertTrue(imported.publicKeyLine.startsWith("$expectedType "))
                val encoded = ByteBuffer.wrap(blob(imported.publicKeyLine))
                assertEquals(expectedType, readSshString(encoded).toString(Charsets.US_ASCII))
                assertEquals(sshCurve, readSshString(encoded).toString(Charsets.US_ASCII))
                val point = readSshString(encoded)
                assertEquals(1 + coordinateBytes * 2, point.size)
                assertEquals(4, point[0].toInt())
                val publicPoint = (pair.public as ECPublicKey).w
                assertEquals(publicPoint.affineX, BigInteger(1, point.copyOfRange(1, 1 + coordinateBytes)))
                assertEquals(publicPoint.affineY, BigInteger(1, point.copyOfRange(1 + coordinateBytes, point.size)))
                assertEquals(0, encoded.remaining())
            } finally {
                privateKey.fill('\u0000')
            }
        }
    }

    @Test
    fun rejectsEncryptedPrivateKeyInsteadOfSilentlyPersistingIt() {
        val encrypted = "-----BEGIN ENCRYPTED PRIVATE KEY-----\nZm9v\n-----END ENCRYPTED PRIVATE KEY-----".toCharArray()
        try {
            try {
                BridgeSshKeyImporter.inspect(encrypted, "encrypted")
                throw AssertionError("Expected encrypted key import to be rejected")
            } catch (_: BridgeSshEncryptedImportException) {
                // Password-protected files remain available as a one-connection selection.
            }
        } finally {
            encrypted.fill('\u0000')
        }
    }

    private fun blob(publicKeyLine: String): ByteArray =
        Base64.getDecoder().decode(publicKeyLine.split(' ')[1])

    private fun readSshString(buffer: ByteBuffer): ByteArray =
        ByteArray(buffer.int).also(buffer::get)

    private fun rsaBlob(publicKey: RSAPublicKey): ByteArray {
        val output = ByteArrayOutputStream()
        writeSshString(output, "ssh-rsa".toByteArray(Charsets.US_ASCII))
        writeSshString(output, publicKey.publicExponent.toByteArray())
        writeSshString(output, publicKey.modulus.toByteArray())
        return output.toByteArray()
    }

    private fun writeSshString(output: ByteArrayOutputStream, value: ByteArray) {
        output.write((value.size ushr 24) and 0xff)
        output.write((value.size ushr 16) and 0xff)
        output.write((value.size ushr 8) and 0xff)
        output.write(value.size and 0xff)
        output.write(value)
    }
}
