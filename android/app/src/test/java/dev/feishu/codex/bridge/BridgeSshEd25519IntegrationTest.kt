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

/** Optional test against a disposable loopback sshd and its private fixture directory. */
class BridgeSshEd25519IntegrationTest {
    @Test
    fun generatedAndImportedKeysAuthenticateAgainstEd25519Host() = runBlocking {
        val directory = System.getenv("BRIDGE_SSH_PROBE_DIR").orEmpty()
        val port = System.getenv("BRIDGE_SSH_PROBE_PORT")?.toIntOrNull()
        val username = System.getenv("BRIDGE_SSH_PROBE_USER").orEmpty()
        assumeTrue(directory.startsWith("/private/tmp/bridge-ssh-probe-") && port != null && username.isNotBlank())
        val fixture = File(directory).canonicalFile
        assumeTrue(fixture.path.startsWith("/private/tmp/bridge-ssh-probe-"))
        val authorizedKeys = File(fixture, "authorized_keys")
        val generated = BridgeSshKeyGenerator.generate(BridgeSshKeyAlgorithm.ED25519, "generated")
        val imported = File(fixture, "client").readText().toCharArray()
        val encrypted = File(fixture, "client-encrypted").readText().toCharArray()
        val passphrase = "fixture-passphrase".toCharArray()
        try {
            authorizedKeys.appendText("${generated.publicKeyLine}\n")
            withTimeout(60_000) {
                for ((key, password) in listOf(
                    generated.privateKeyPem to null,
                    imported to null,
                    encrypted to passphrase,
                )) {
                    val transport = BridgeCbSshTransport("127.0.0.1", checkNotNull(port), object : HostKeyVerifier {
                        override suspend fun verify(key: PublicKey): Boolean = key.type == "ssh-ed25519"
                    })
                    try {
                        assertTrue(transport.connect() is ConnectResult.Success)
                        assertTrue(transport.authenticatePublicKey(username, key, password) is AuthResult.Success)
                        val result = transport.exec("printf bridge-ed25519-auth-ok")
                        assertEquals("bridge-ed25519-auth-ok", result.stdout.toString(Charsets.UTF_8))
                    } finally {
                        transport.disconnect()
                    }
                }
            }
        } finally {
            generated.privateKeyPem.fill('\u0000')
            imported.fill('\u0000')
            encrypted.fill('\u0000')
            passphrase.fill('\u0000')
        }
    }
}
