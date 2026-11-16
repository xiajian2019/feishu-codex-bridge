package dev.feishu.codex.bridge

import androidx.test.ext.junit.runners.AndroidJUnit4
import java.security.Signature
import java.security.interfaces.RSAPrivateCrtKey
import org.connectbot.sshlib.SshKeys
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BridgeSshKeyGeneratorAndroidTest {
    @Test
    fun generatedRsaCanBeDecodedAndSignedByTheSelectedProvider() {
        BridgeSshCrypto.install()
        val generated = BridgeSshKeyGenerator.generate(BridgeSshKeyAlgorithm.RSA, "rsa-fixture")
        try {
            val decoded = SshKeys.decodePemPrivateKey(generated.privateKeyPem.concatToString(), null)
            assertTrue(decoded.private is RSAPrivateCrtKey)
            for (algorithm in listOf("SHA256withRSA", "SHA512withRSA")) {
                val payload = "android-rsa-fixture".toByteArray()
                val signature = Signature.getInstance(algorithm)
                signature.initSign(decoded.private)
                signature.update(payload)
                val signed = signature.sign()
                signature.initVerify(decoded.public)
                signature.update(payload)
                assertTrue(signature.verify(signed))
            }
        } finally {
            generated.privateKeyPem.fill('\u0000')
        }
    }

    @Test
    fun generatedEd25519CanBeReadByTheAndroidSshImporter() {
        BridgeSshCrypto.install()
        val generated = BridgeSshKeyGenerator.generate(BridgeSshKeyAlgorithm.ED25519, "fixture-key")
        try {
            val imported = BridgeSshKeyImporter.inspect(generated.privateKeyPem, "fixture-key")
            assertEquals("Ed25519", imported.algorithm)
            assertEquals(generated.publicKeyLine, imported.publicKeyLine)
            val decoded = SshKeys.decodePemPrivateKey(generated.privateKeyPem.concatToString(), null)
            val signature = Signature.getInstance("Ed25519")
            assertEquals("Bridge SSH Crypto", signature.provider.name)
            val payload = "android-ed25519-fixture".toByteArray()
            signature.initSign(decoded.private)
            signature.update(payload)
            val signed = signature.sign()
            signature.initVerify(decoded.public)
            signature.update(payload)
            assertTrue(signature.verify(signed))
        } finally {
            generated.privateKeyPem.fill('\u0000')
        }
    }
}
