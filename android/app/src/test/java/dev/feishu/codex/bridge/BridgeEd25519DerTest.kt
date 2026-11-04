package dev.feishu.codex.bridge

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class BridgeEd25519DerTest {
    private val seed = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
    private val publicKey = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
    private val pkcs8 = hex("302e020100300506032b657004220420") + seed
    private val x509 = hex("302a300506032b6570032100") + publicKey

    @Test
    fun writesAndReadsRfc8410Ed25519Keys() {
        assertArrayEquals(pkcs8, BridgeEd25519Der.encodePrivateKey(seed))
        assertArrayEquals(seed, BridgeEd25519Der.decodePrivateKey(pkcs8))
        assertArrayEquals(publicKey, BridgeEd25519Der.decodePublicKey(x509))
    }

    @Test
    fun readsLegacyPrivateKeyWithOptionalPublicKey() {
        val legacy = hex("3051020101300506032b657004220420") + seed + hex("812100") + publicKey
        assertArrayEquals(seed, BridgeEd25519Der.decodePrivateKey(legacy))
    }

    @Test
    fun rejectsMalformedOrNonEd25519PrivateKeys() {
        val invalid = listOf(
            pkcs8.copyOf().also { it[4] = 2 },
            pkcs8.copyOf().also { it[11] = 0x71 },
            pkcs8.copyOf().also { it[1] = 0x7f },
            pkcs8.copyOf().also { it[15] = 0x21 },
            pkcs8.copyOf(20),
            pkcs8 + byteArrayOf(0),
        )
        for (encoded in invalid) {
            assertThrows(Exception::class.java) { BridgeEd25519Der.decodePrivateKey(encoded) }
        }
    }

    @Test
    fun rejectsMalformedOrNonEd25519PublicKeys() {
        val invalid = listOf(
            x509.copyOf().also { it[8] = 0x71 },
            x509.copyOf().also { it[11] = 1 },
            x509.copyOf().also { it[1] = 0x7f },
            x509.copyOf(20),
            x509 + byteArrayOf(0),
        )
        for (encoded in invalid) {
            assertThrows(Exception::class.java) { BridgeEd25519Der.decodePublicKey(encoded) }
        }
    }

    private fun hex(value: String): ByteArray =
        value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
