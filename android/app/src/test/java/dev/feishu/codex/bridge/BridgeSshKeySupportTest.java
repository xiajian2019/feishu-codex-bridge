package dev.feishu.codex.bridge;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import net.schmizz.sshj.userauth.keyprovider.KeyFormat;
import org.junit.Test;

public class BridgeSshKeySupportTest {
    @Test
    public void selectsSupportedPemFormatsAndRejectsPuttyAsUnsupported() throws Exception {
        assertEquals(KeyFormat.OpenSSH, BridgeSshKeySupport.detectFormat(chars(
            "-----BEGIN RSA PRIVATE KEY-----\nbody\n-----END RSA PRIVATE KEY-----\n")));
        assertEquals(KeyFormat.OpenSSHv1, BridgeSshKeySupport.detectFormat(chars(
            "-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n-----END OPENSSH PRIVATE KEY-----\n")));
        assertEquals(KeyFormat.PKCS8, BridgeSshKeySupport.detectFormat(chars(
            "-----BEGIN PRIVATE KEY-----\nbody\n-----END PRIVATE KEY-----\n")));
        assertEquals(KeyFormat.PKCS8, BridgeSshKeySupport.detectFormat(chars(
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\nbody\n-----END ENCRYPTED PRIVATE KEY-----\n")));
        assertEquals(KeyFormat.PuTTY, BridgeSshKeySupport.detectFormat(chars(
            "PuTTY-User-Key-File-3: ed25519\nEncryption: none\n")));

        try {
            BridgeSshKeySupport.createProvider(chars(
                "PuTTY-User-Key-File-3: ed25519\nEncryption: none\n"), null);
        } catch (BridgeSshKeySupport.BridgeSshKeyException error) {
            assertEquals(BridgeSshKeySupport.PRIVATE_KEY_FORMAT_UNSUPPORTED, error.code());
            return;
        }
        throw new AssertionError("Expected PuTTY format to be rejected");
    }

    @Test
    public void detectsEncryptedLegacyPkcs8AndOpenSshV1KeysWithoutLoggingMaterial() throws Exception {
        assertTrue(BridgeSshKeySupport.isEncrypted(chars(
            "-----BEGIN RSA PRIVATE KEY-----\n"
                + "Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,00\n"
                + "body\n-----END RSA PRIVATE KEY-----\n")));
        assertTrue(BridgeSshKeySupport.isEncrypted(chars(
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\nbody\n"
                + "-----END ENCRYPTED PRIVATE KEY-----\n")));
        assertTrue(BridgeSshKeySupport.isEncrypted(openSshV1Key("aes256-ctr")));
        assertFalse(BridgeSshKeySupport.isEncrypted(openSshV1Key("none")));

        assertEquals(
            BridgeSshKeySupport.PRIVATE_KEY_PASSPHRASE_REQUIRED,
            BridgeSshKeySupport.errorCodeForKeyRead(new IOException("redacted"), true, false));
        assertEquals(
            BridgeSshKeySupport.PRIVATE_KEY_PASSPHRASE_INVALID,
            BridgeSshKeySupport.errorCodeForKeyRead(new IOException("redacted"), true, true));
    }

    @Test
    public void clearsSecretArraysInPlace() {
        char[] secret = "private-key-passphrase".toCharArray();
        BridgeSshKeySupport.clear(secret);
        assertArrayEquals(new char[secret.length], secret);
        BridgeSshKeySupport.clear(null);
    }

    private static char[] chars(String value) {
        return value.toCharArray();
    }

    private static char[] openSshV1Key(String cipherName) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        DataOutputStream output = new DataOutputStream(bytes);
        output.write("openssh-key-v1\u0000".getBytes(StandardCharsets.US_ASCII));
        writeSshString(output, cipherName);
        writeSshString(output, "none");
        writeSshString(output, "");
        output.flush();
        String body = Base64.getEncoder().encodeToString(bytes.toByteArray());
        return ("-----BEGIN OPENSSH PRIVATE KEY-----\n"
            + body + "\n-----END OPENSSH PRIVATE KEY-----\n").toCharArray();
    }

    private static void writeSshString(DataOutputStream output, String value) throws IOException {
        byte[] bytes = value.getBytes(StandardCharsets.US_ASCII);
        output.writeInt(bytes.length);
        output.write(bytes);
    }
}
