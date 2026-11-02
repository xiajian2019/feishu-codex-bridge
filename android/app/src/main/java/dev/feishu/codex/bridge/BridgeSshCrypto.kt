package dev.feishu.codex.bridge

import java.security.Provider
import java.security.Security
import java.security.Signature

/**
 * Installs the crypto implementations required by cbssh on Android versions
 * whose default providers are missing Ed25519 or return an RSA key type that
 * cbssh 0.5.0 cannot sign with. This is deliberately a small, uniquely named
 * provider: it does not remove or replace Android's built-in providers.
 */
internal object BridgeSshCrypto {
    private const val PROVIDER_NAME = "Bridge SSH Crypto"
    private const val ED25519_SIGNATURE_SPI =
        "org.bouncycastle.jcajce.provider.asymmetric.edec.SignatureSpi${'$'}Ed25519"
    private const val RSA_KEY_FACTORY_SPI =
        "org.bouncycastle.jcajce.provider.asymmetric.rsa.KeyFactorySpi"
    private const val RSA_SHA256_SIGNATURE_SPI =
        "org.bouncycastle.jcajce.provider.asymmetric.rsa.DigestSignatureSpi${'$'}SHA256"
    private const val RSA_SHA512_SIGNATURE_SPI =
        "org.bouncycastle.jcajce.provider.asymmetric.rsa.DigestSignatureSpi${'$'}SHA512"

    @Synchronized
    fun install() {
        if (Security.getProvider(PROVIDER_NAME) == null) {
            Security.insertProviderAt(BridgeEd25519Provider(), 1)
        }
        check(runCatching { Signature.getInstance("Ed25519") }.isSuccess) {
            "Ed25519 Signature provider is unavailable"
        }
        check(runCatching { java.security.KeyFactory.getInstance("RSA") }.isSuccess) {
            "RSA KeyFactory provider is unavailable"
        }
    }

    private class BridgeEd25519Provider : Provider(
        PROVIDER_NAME,
        1.0,
        "Ed25519 Signature bridge for ConnectBot cbssh",
    ) {
        init {
            put("Signature.Ed25519", ED25519_SIGNATURE_SPI)
            put("Alg.Alias.Signature.EdDSA", "Ed25519")
            put("Alg.Alias.Signature.1.3.101.112", "Ed25519")
            put("KeyFactory.RSA", RSA_KEY_FACTORY_SPI)
            put("Alg.Alias.KeyFactory.1.2.840.113549.1.1.1", "RSA")
            put("Signature.SHA256withRSA", RSA_SHA256_SIGNATURE_SPI)
            put("Signature.SHA512withRSA", RSA_SHA512_SIGNATURE_SPI)
            put("Alg.Alias.Signature.1.2.840.113549.1.1.11", "SHA256withRSA")
            put("Alg.Alias.Signature.1.2.840.113549.1.1.13", "SHA512withRSA")
        }
    }
}
