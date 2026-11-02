package dev.feishu.codex.bridge

import java.security.KeyPairGenerator
import java.util.Base64
import net.schmizz.sshj.common.Buffer
import org.connectbot.sshlib.SshKeys
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeSshKeyImporterTest {
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
            assertArrayEquals(Buffer.PlainBuffer().putPublicKey(pair.public).compactData, blob(imported.publicKeyLine))
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
}
