package dev.feishu.codex.bridge

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BridgeSshKeyGeneratorAndroidTest {
    @Test
    fun generatedEd25519CanBeReadByTheAndroidSshImporter() {
        BridgeSshCrypto.install()
        val generated = BridgeSshKeyGenerator.generate(BridgeSshKeyAlgorithm.ED25519, "fixture-key")
        try {
            val imported = BridgeSshKeyImporter.inspect(generated.privateKeyPem, "fixture-key")
            assertEquals("Ed25519", imported.algorithm)
            assertEquals(generated.publicKeyLine, imported.publicKeyLine)
        } finally {
            generated.privateKeyPem.fill('\u0000')
        }
    }
}
