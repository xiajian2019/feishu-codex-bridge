package dev.feishu.codex.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class BridgeSshProtocolTest {
    @Test
    public void validatesConnectionAndTerminalArguments() {
        assertEquals("session-1", BridgeSshProtocol.requireSessionId(" session-1 "));
        assertEquals("mac.example", BridgeSshProtocol.requireHost(" mac.example "));
        assertEquals(22, BridgeSshProtocol.requirePort(22));
        assertEquals(120, BridgeSshProtocol.requireCols(120));
        assertEquals(40, BridgeSshProtocol.requireRows(40));
        assertEquals("  tmux attach  ", BridgeSshProtocol.optionalStartupCommand("  tmux attach  "));
    }

    @Test
    public void validatesOpaquePrivateKeyIdAndPassphraseFields() {
        assertEquals("key-1", BridgeSshProtocol.optionalPrivateKeyId(" key-1 "));
        assertEquals("", BridgeSshProtocol.optionalPrivateKeyPassphrase(""));
        assertEquals(null, BridgeSshProtocol.optionalPrivateKeyId("  "));
    }

    @Test
    public void rejectsInvalidConnectionAndTerminalArguments() {
        assertThrows(() -> BridgeSshProtocol.requireHost("host name"));
        assertThrows(() -> BridgeSshProtocol.requirePort(0));
        assertThrows(() -> BridgeSshProtocol.requirePort(65536));
        assertThrows(() -> BridgeSshProtocol.requireCols(1));
        assertThrows(() -> BridgeSshProtocol.requireRows(0));
        assertThrows(() -> BridgeSshProtocol.optionalPassword("bad\u0000password"));
        assertThrows(() -> BridgeSshProtocol.optionalPrivateKeyId("bad\u0000key"));
        assertThrows(() -> BridgeSshProtocol.optionalPrivateKeyPassphrase("bad\u0000passphrase"));
        assertThrows(() -> BridgeSshProtocol.optionalPrivateKeyId(repeat('k',
            BridgeSshProtocol.MAX_PRIVATE_KEY_ID_LENGTH + 1)));
        assertThrows(() -> BridgeSshProtocol.optionalPrivateKeyPassphrase(repeat('p',
            BridgeSshProtocol.MAX_PRIVATE_KEY_PASSPHRASE_LENGTH + 1)));
    }

    @Test
    public void keepsHostKeysPartitionedByNormalizedHostAndPort() {
        assertEquals("mac.example:22", BridgeSshProtocol.knownHostKey("Mac.Example", 22));
        assertTrue(!BridgeSshProtocol.knownHostKey("mac.example", 22)
            .equals(BridgeSshProtocol.knownHostKey("mac.example", 2222)));
    }

    private static void assertThrows(Runnable action) {
        try {
            action.run();
        } catch (IllegalArgumentException expected) {
            return;
        }
        throw new AssertionError("Expected IllegalArgumentException");
    }

    private static String repeat(char value, int count) {
        char[] result = new char[count];
        java.util.Arrays.fill(result, value);
        return new String(result);
    }
}
