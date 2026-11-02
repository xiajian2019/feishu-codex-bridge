package dev.feishu.codex.bridge

import java.security.KeyPairGenerator
import java.security.KeyFactory
import java.security.interfaces.RSAPrivateCrtKey
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import org.bouncycastle.jce.provider.BouncyCastleProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeSshCryptoTest {
    @Test
    fun installsEd25519SignatureForConnectBotKeys() {
        BridgeSshCrypto.install()
        val signature = Signature.getInstance("Ed25519")
        assertEquals("Bridge SSH Crypto", signature.provider.name)

        val generated = KeyPairGenerator
            .getInstance("Ed25519", BouncyCastleProvider())
            .generateKeyPair()
        val payload = "bridge-ed25519-provider".toByteArray()

        signature.initSign(generated.private)
        signature.update(payload)
        val signed = signature.sign()

        val verifier = Signature.getInstance("Ed25519")
        verifier.initVerify(generated.public)
        verifier.update(payload)
        assertTrue(verifier.verify(signed))
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
}
