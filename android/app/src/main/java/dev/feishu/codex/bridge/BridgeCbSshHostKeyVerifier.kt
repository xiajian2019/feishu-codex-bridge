package dev.feishu.codex.bridge

import java.security.MessageDigest
import java.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.connectbot.sshlib.HostKeyVerifier
import org.connectbot.sshlib.PublicKey

internal const val BRIDGE_SSH_KNOWN_HOSTS_PREFERENCES = "bridge_connectbot_known_hosts"

data class BridgeCbSshHostKeyPrompt(
    val fingerprint: String,
    val algorithm: String,
    val changed: Boolean,
)

/** Interactive, per-host host-key policy for the native ConnectBot screen. */
class BridgeCbSshHostKeyVerifier(
    private val knownHosts: android.content.SharedPreferences,
    private val host: String,
    private val port: Int,
    requestApproval: suspend (BridgeCbSshHostKeyPrompt) -> Boolean,
) : HostKeyVerifier {
    @Volatile private var approvalHandler: (suspend (BridgeCbSshHostKeyPrompt) -> Boolean)? = requestApproval

    /** The long-lived transport must not retain the screen used for initial approval. */
    fun clearApprovalHandler() { approvalHandler = null }

    override suspend fun verify(key: PublicKey): Boolean {
        val fingerprint = fingerprint(key)
        val preferenceKey = BridgeSshProtocol.knownHostKey(host, port)
        val saved = knownHosts.getString(preferenceKey, null)
        if (saved == fingerprint) return true

        // After initial connection, a changed or unknown key fails closed.
        val accepted = approvalHandler?.invoke(
            BridgeCbSshHostKeyPrompt(
                fingerprint = fingerprint,
                algorithm = key.type.ifBlank { "unknown" },
                changed = saved != null,
            ),
        ) ?: false
        if (accepted) {
            withContext(Dispatchers.IO) {
                knownHosts.edit().putString(preferenceKey, fingerprint).commit()
            }
        }
        return accepted
    }

    private fun fingerprint(key: PublicKey): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(key.encoded)
        return "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(digest)
    }
}
