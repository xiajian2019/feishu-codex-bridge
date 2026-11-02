package dev.feishu.codex.bridge

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeSshKeyGeneratorTest {
    @Test
    fun generatesEd25519Pkcs8PrivateKeyAndAuthorizedKeyLine() {
        val generated = BridgeSshKeyGenerator.generate(
            BridgeSshKeyAlgorithm.ED25519,
            "phone key",
        )

        try {
            assertTrue(generated.privateKeyPem.concatToString().startsWith("-----BEGIN PRIVATE KEY-----"))
            assertTrue(generated.publicKeyLine.startsWith("ssh-ed25519 "))
            assertTrue(generated.publicKeyLine.endsWith(" phone-key"))
            assertEquals(11, decodeSshString(generated.publicKeyLine).first)
            val keyPayload = decodeSshString(generated.publicKeyLine).second
            assertEquals(36, keyPayload.size)
        } finally {
            generated.privateKeyPem.fill('\u0000')
        }
    }

    @Test
    fun generatesRsaPublicKeyWithSshRsaBlob() {
        val generated = BridgeSshKeyGenerator.generate(
            BridgeSshKeyAlgorithm.RSA,
            "bridge-rsa",
        )

        try {
            assertTrue(generated.privateKeyPem.concatToString().startsWith("-----BEGIN PRIVATE KEY-----"))
            assertTrue(generated.publicKeyLine.startsWith("ssh-rsa "))
            assertEquals(7, decodeSshString(generated.publicKeyLine).first)
            assertTrue(decodeSshString(generated.publicKeyLine).second.size > 256)
        } finally {
            generated.privateKeyPem.fill('\u0000')
        }
    }

    private fun decodeSshString(publicKeyLine: String): Pair<Int, ByteArray> {
        val payload = Base64.getDecoder().decode(publicKeyLine.split(' ')[1])
        val length = (payload[0].toInt() and 0xff) * 0x1000000 +
            (payload[1].toInt() and 0xff) * 0x10000 +
            (payload[2].toInt() and 0xff) * 0x100 +
            (payload[3].toInt() and 0xff)
        return length to payload.copyOfRange(4 + length, payload.size)
    }
}
