package dev.feishu.codex.bridge

import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.connectbot.sshlib.AuthResult
import org.connectbot.sshlib.ConnectResult
import org.connectbot.sshlib.HostKeyVerifier
import org.connectbot.sshlib.PublicKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Optional integration test against a disposable loopback sshd. */
class BridgeSshRsaIntegrationTest {
    @Test
    fun systemProviderAuthenticatesExistingAndGeneratedRsaKeys() = runBlocking {
        val directory = System.getenv("BRIDGE_SSH_PROBE_DIR").orEmpty()
        val port = System.getenv("BRIDGE_SSH_PROBE_PORT")?.toIntOrNull()
        val username = System.getenv("BRIDGE_SSH_PROBE_USER").orEmpty()
        assumeTrue(directory.startsWith("/private/tmp/bridge-ssh-probe-") && port != null && username.isNotBlank())
        val fixture = File(directory).canonicalFile
        assumeTrue(fixture.path.startsWith("/private/tmp/bridge-ssh-probe-"))
        val generated = BridgeSshKeyGenerator.generate(BridgeSshKeyAlgorithm.RSA, "generated-rsa")
        val openssh = File(fixture, "client-rsa").readText().toCharArray()
        val encrypted = File(fixture, "client-rsa-encrypted").readText().toCharArray()
        val legacy = File(fixture, "client-rsa-legacy").readText().toCharArray()
        val opensshPublic = File(fixture, "client-rsa.pub").readText().trim()
        val encryptedPublic = File(fixture, "client-rsa-encrypted.pub").readText().trim()
        val legacyPublic = File(fixture, "client-rsa-legacy.pub").readText().trim()
        val passphrase = "fixture-passphrase".toCharArray()
        try {
            File(fixture, "authorized_keys").appendText("${generated.publicKeyLine}\n")
            withTimeout(90_000) {
                BridgeSshCrypto.install()
                for ((key, password, publicKeyLine) in listOf(
                    Triple(generated.privateKeyPem, null, generated.publicKeyLine),
                    Triple(openssh, null, opensshPublic),
                    Triple(encrypted, passphrase, encryptedPublic),
                    Triple(legacy, null, legacyPublic),
                )) {
                    val transport = BridgeCbSshTransport("127.0.0.1", checkNotNull(port), object : HostKeyVerifier {
                        override suspend fun verify(key: PublicKey): Boolean = key.type == "ssh-ed25519"
                    })
                    try {
                        assertTrue(transport.connect() is ConnectResult.Success)
                        assertTrue(
                            transport.authenticatePublicKey(
                                username,
                                key,
                                password,
                                publicKeyLine,
                            ) is AuthResult.Success,
                        )
                        val result = transport.exec("printf bridge-rsa-auth-ok")
                        assertEquals("bridge-rsa-auth-ok", result.stdout.toString(Charsets.UTF_8))
                    } finally {
                        transport.disconnect()
                    }
                }
            }
        } finally {
            generated.privateKeyPem.fill('\u0000')
            openssh.fill('\u0000')
            encrypted.fill('\u0000')
            legacy.fill('\u0000')
            passphrase.fill('\u0000')
        }
    }
}
