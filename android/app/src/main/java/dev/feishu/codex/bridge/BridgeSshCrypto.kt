package dev.feishu.codex.bridge

import java.security.Provider
import java.security.Security
import java.security.Signature

/**
 * Installs the crypto implementations required by cbssh on Android versions
 * whose default providers are missing Ed25519. Ed25519 signing uses Tink,
 * which cbssh already uses for key generation. RSA uses Android's default JCA
 * provider directly. This provider does not remove Android's built-in providers.
 */
internal object BridgeSshCrypto {
    private const val PROVIDER_NAME = "Bridge SSH Crypto"
    @Synchronized
    fun install() {
        if (Security.getProvider(PROVIDER_NAME) == null) {
            Security.insertProviderAt(BridgeEd25519Provider(), 1)
        }
        check(runCatching { Signature.getInstance("Ed25519") }.isSuccess) {
            "Ed25519 Signature provider is unavailable"
        }
    }

    private class BridgeEd25519Provider : Provider(
        PROVIDER_NAME,
        1.0,
        "Ed25519 Signature bridge for ConnectBot cbssh",
    ) {
        init {
            put("Signature.Ed25519", BridgeEd25519Signature::class.java.name)
            put("Alg.Alias.Signature.EdDSA", "Ed25519")
            put("Alg.Alias.Signature.1.3.101.112", "Ed25519")
        }
    }
}
