package dev.feishu.codex.bridge

import android.content.Context
import org.connectbot.sshlib.AuthResult
import java.io.Closeable

/** Reconnect credentials live only for the active app session, never in profiles or logs. */
internal sealed class BridgeSshReconnectCredentials : Closeable {
    abstract suspend fun authenticate(context: Context, username: String, transport: BridgeCbSshTransport): AuthResult

    class StoredKey(private val keyId: String) : BridgeSshReconnectCredentials() {
        override suspend fun authenticate(context: Context, username: String, transport: BridgeCbSshTransport): AuthResult {
            val key = BridgeSshKeyStore.loadPrivateKey(context, keyId)
            return try { transport.authenticatePublicKey(username, key) } finally { BridgeSshKeySupport.clear(key) }
        }
        override fun close() = Unit
    }

    class TemporaryKey(key: CharArray, passphrase: CharArray?) : BridgeSshReconnectCredentials() {
        private val secret = key.copyOf()
        private val phrase = passphrase?.copyOf()
        private var closed = false
        override suspend fun authenticate(context: Context, username: String, transport: BridgeCbSshTransport): AuthResult {
            val (key, passphrase) = synchronized(this) {
                check(!closed) { "SSH credentials are unavailable" }
                secret.copyOf() to phrase?.copyOf()
            }
            return try { transport.authenticatePublicKey(username, key, passphrase) } finally {
                BridgeSshKeySupport.clear(key)
                BridgeSshKeySupport.clear(passphrase)
            }
        }
        override fun close() = synchronized(this) {
            closed = true
            BridgeSshKeySupport.clear(secret)
            BridgeSshKeySupport.clear(phrase)
        }
    }

    class Password(password: CharArray) : BridgeSshReconnectCredentials() {
        // Ownership of this newly created array is transferred to the session.
        private val secret = password
        private var closed = false
        override suspend fun authenticate(context: Context, username: String, transport: BridgeCbSshTransport): AuthResult {
            val copy = synchronized(this) {
                check(!closed) { "SSH credentials are unavailable" }
                secret.copyOf()
            }
            return try { transport.authenticatePassword(username, copy.concatToString()) }
            finally { BridgeSshKeySupport.clear(copy) }
        }
        override fun close() = synchronized(this) {
            closed = true
            BridgeSshKeySupport.clear(secret)
        }
    }
}
