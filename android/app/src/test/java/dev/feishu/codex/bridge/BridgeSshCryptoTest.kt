package dev.feishu.codex.bridge

import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.Security
import java.security.interfaces.RSAPrivateCrtKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import org.connectbot.sshlib.SshKeys
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeSshCryptoTest {
    @Test
    fun matchesRfc8032Ed25519Vector() {
        BridgeSshCrypto.install()
        val keyFactory = KeyFactory.getInstance("Ed25519")
        val privateKey = keyFactory.generatePrivate(PKCS8EncodedKeySpec(hex(
            "302e020100300506032b657004220420" +
                "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
        )))
        val publicKey = keyFactory.generatePublic(X509EncodedKeySpec(hex(
            "302a300506032b6570032100" +
                "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
        )))
        val expected = hex(
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155" +
                "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
        )
        val signature = Signature.getInstance("Ed25519")
        assertEquals("Bridge SSH Crypto", signature.provider.name)
        signature.initSign(privateKey)
        assertArrayEquals(expected, signature.sign())

        signature.initVerify(publicKey)
        assertTrue(signature.verify(expected))
        signature.update(1.toByte())
        assertFalse(signature.verify(expected))
        assertFalse(signature.verify(expected.copyOf(63)))
        // A failed verification resets the buffered message for the next operation.
        assertTrue(signature.verify(expected))
    }

    @Test
    fun signsAndVerifiesCbsshKeys() {
        BridgeSshCrypto.install()
        val generated = BridgeSshKeyGenerator.generate(BridgeSshKeyAlgorithm.ED25519, "test")
        try {
            val cbsshPair = SshKeys.decodePemPrivateKey(generated.privateKeyPem.concatToString(), null)
            assertInteroperable(cbsshPair)
        } finally {
            generated.privateKeyPem.fill('\u0000')
        }
    }

    @Test
    fun signsCbsshKeysWhenThePlatformHasNoEd25519Factory() {
        BridgeSshCrypto.install()
        val generated = BridgeSshKeyGenerator.generate(BridgeSshKeyAlgorithm.ED25519, "fallback")
        val sunEc = checkNotNull(Security.getProvider("SunEC"))
        val position = Security.getProviders().indexOf(sunEc) + 1
        try {
            Security.removeProvider(sunEc.name)
            val pair = SshKeys.decodePemPrivateKey(generated.privateKeyPem.concatToString(), null)
            assertEquals("org.connectbot.sshlib.crypto.ed25519.Ed25519PrivateKey", pair.private.javaClass.name)
            val signature = Signature.getInstance("Ed25519")
            signature.initSign(pair.private)
            signature.update("fallback".toByteArray())
            val signed = signature.sign()
            signature.initVerify(pair.public)
            signature.update("fallback".toByteArray())
            assertTrue(signature.verify(signed))
        } finally {
            Security.insertProviderAt(sunEc, position)
            generated.privateKeyPem.fill('\u0000')
        }
    }

    private fun assertInteroperable(pair: KeyPair) {
        val payload = "bridge-ed25519-provider".toByteArray()
        val jcaFactory = KeyFactory.getInstance("Ed25519")
        val jcaPrivate = jcaFactory.generatePrivate(PKCS8EncodedKeySpec(pair.private.encoded))
        val jcaPublic = jcaFactory.generatePublic(X509EncodedKeySpec(pair.public.encoded))
        val bridge = Signature.getInstance("Ed25519")

        bridge.initSign(pair.private)
        bridge.update(payload)
        val bridgeSigned = bridge.sign()
        bridge.initVerify(jcaPublic)
        bridge.update(payload)
        assertTrue(bridge.verify(bridgeSigned))

        bridge.initSign(jcaPrivate)
        bridge.update(payload)
        val jcaSigned = bridge.sign()
        bridge.initVerify(pair.public)
        bridge.update(payload)
        assertTrue(bridge.verify(jcaSigned))
    }

    @Test
    fun parsesRsaPrivateKeyAsCrtKeyForCbssh() {
        BridgeSshCrypto.install()
        val generated = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val parsed = KeyFactory.getInstance("RSA").generatePrivate(
            PKCS8EncodedKeySpec(generated.private.encoded),
        )

        assertTrue(parsed is RSAPrivateCrtKey)

        val payload = "bridge-rsa-provider".toByteArray()
        val signature = Signature.getInstance("SHA256withRSA")
        signature.initSign(parsed)
        signature.update(payload)
        val verifier = Signature.getInstance("SHA256withRSA")
        verifier.initVerify(generated.public)
        verifier.update(payload)
        assertTrue(verifier.verify(signature.sign()))
    }

    private fun hex(value: String): ByteArray =
        value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
