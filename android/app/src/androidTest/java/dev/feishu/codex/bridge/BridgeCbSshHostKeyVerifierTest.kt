package dev.feishu.codex.bridge

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.connectbot.sshlib.PublicKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BridgeCbSshHostKeyVerifierTest {
    @Test
    fun clearingScreenApprovalKeepsKnownKeyAndRejectsChangedKey() = runBlocking {
        val prefs = InstrumentationRegistry.getInstrumentation().targetContext
            .getSharedPreferences("bridge-host-key-lifecycle-test", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        var approvals = 0
        val verifier = BridgeCbSshHostKeyVerifier(prefs, "fixture.test", 22) {
            approvals++
            true
        }
        val original = PublicKey("ssh-ed25519", byteArrayOf(1, 2, 3))
        val changed = PublicKey("ssh-ed25519", byteArrayOf(4, 5, 6))
        try {
            assertTrue(verifier.verify(original))
            assertEquals(1, approvals)
            verifier.clearApprovalHandler()
            assertTrue(verifier.verify(original))
            assertFalse(verifier.verify(changed))
            assertEquals(1, approvals)
            assertTrue(verifier.verify(original))
        } finally {
            prefs.edit().clear().commit()
        }
    }
}
