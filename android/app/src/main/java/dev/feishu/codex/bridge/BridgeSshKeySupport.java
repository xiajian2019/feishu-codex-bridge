package dev.feishu.codex.bridge;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.CharArrayReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import org.connectbot.sshlib.SshKeys;

/**
 * Inspects in-memory SSH private keys without creating a file or persisting key material.
 * ConnectBot's key reader performs the actual unencrypted-key validation.
 */
final class BridgeSshKeySupport {
    static final int MAX_PRIVATE_KEY_BYTES = 256 * 1024;
    static final String PRIVATE_KEY_FORMAT_UNSUPPORTED = "PRIVATE_KEY_FORMAT_UNSUPPORTED";
    static final String PRIVATE_KEY_INVALID = "PRIVATE_KEY_INVALID";

    private BridgeSshKeySupport() {}

    static String detectFormat(char[] privateKey) throws IOException {
        if (privateKey == null || privateKey.length == 0) {
            throw new IOException(PRIVATE_KEY_INVALID);
        }
        String header = firstNonEmptyLine(privateKey);
        if (header == null || header.startsWith("PuTTY-User-Key-File-")) {
            throw new BridgeSshKeyException(PRIVATE_KEY_FORMAT_UNSUPPORTED);
        }
        if (header.contains("OPENSSH PRIVATE KEY")) return "openssh-new";
        if (header.endsWith("RSA PRIVATE KEY-----")
            || header.endsWith("DSA PRIVATE KEY-----")
            || header.endsWith("EC PRIVATE KEY-----")) return "openssh";
        if (header.contains("PRIVATE KEY-----")) return "pkcs8";
        throw new BridgeSshKeyException(PRIVATE_KEY_FORMAT_UNSUPPORTED);
    }

    static KeyInfo inspectForPicker(char[] privateKey) throws IOException {
        String formatName = detectFormat(privateKey);
        boolean encrypted = isEncrypted(privateKey);
        if (!encrypted) {
            String pem = new String(privateKey);
            try {
                SshKeys.INSTANCE.decodePemPrivateKey(pem, null);
            } catch (Exception error) {
                throw new BridgeSshKeyException(PRIVATE_KEY_INVALID);
            } finally {
                pem = null;
            }
        }
        return new KeyInfo(formatName, encrypted);
    }

    static boolean isEncrypted(char[] privateKey) {
        if (privateKey == null || privateKey.length == 0) return false;
        String header = firstNonEmptyLine(privateKey);
        if (header == null) return false;
        if (header.contains("ENCRYPTED PRIVATE KEY")) return true;

        if (header.contains("OPENSSH PRIVATE KEY")) {
            return isEncryptedOpenSshV1(privateKey);
        }

        if (header.endsWith("RSA PRIVATE KEY-----")
            || header.endsWith("DSA PRIVATE KEY-----")
            || header.endsWith("EC PRIVATE KEY-----")) {
            String text = new String(privateKey);
            try {
                return text.contains("Proc-Type: 4,ENCRYPTED");
            } finally {
                text = null;
            }
        }
        return false;
    }

    static void clear(char[] secret) {
        if (secret != null) Arrays.fill(secret, '\u0000');
    }

    private static String firstNonEmptyLine(char[] value) {
        BufferedReader reader = new BufferedReader(new CharArrayReader(value));
        try {
            String line;
            while ((line = reader.readLine()) != null) {
                String normalized = line.trim();
                if (!normalized.isEmpty()) return normalized;
            }
            return null;
        } catch (IOException impossible) {
            return null;
        } finally {
            try {
                reader.close();
            } catch (IOException ignored) {
                // CharArrayReader.close() is a no-op.
            }
        }
    }

    private static boolean isEncryptedOpenSshV1(char[] privateKey) {
        byte[] decoded = null;
        try {
            String text = new String(privateKey);
            try {
                StringBuilder base64 = new StringBuilder(text.length());
                BufferedReader reader = new BufferedReader(new InputStreamReader(
                    new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)),
                    StandardCharsets.UTF_8));
                String line;
                while ((line = reader.readLine()) != null) {
                    String normalized = line.trim();
                    if (normalized.isEmpty() || normalized.startsWith("-----BEGIN")
                        || normalized.startsWith("-----END")) continue;
                    base64.append(normalized);
                }
                decoded = Base64.getDecoder().decode(base64.toString());
            } finally {
                text = null;
            }

            ByteArrayInputStream input = new ByteArrayInputStream(decoded);
            byte[] magic = new byte[15];
            if (input.read(magic) != magic.length
                || !Arrays.equals(magic, "openssh-key-v1\u0000".getBytes(StandardCharsets.US_ASCII))) {
                return false;
            }
            String cipherName = readSshString(input);
            return cipherName != null && !"none".equals(cipherName);
        } catch (RuntimeException | IOException ignored) {
            return false;
        } finally {
            if (decoded != null) Arrays.fill(decoded, (byte) 0);
        }
    }

    private static String readSshString(ByteArrayInputStream input) throws IOException {
        byte[] lengthBytes = new byte[4];
        if (input.read(lengthBytes) != lengthBytes.length) return null;
        int length = ((lengthBytes[0] & 0xff) << 24)
            | ((lengthBytes[1] & 0xff) << 16)
            | ((lengthBytes[2] & 0xff) << 8)
            | (lengthBytes[3] & 0xff);
        if (length < 0 || length > input.available()) return null;
        byte[] value = new byte[length];
        if (input.read(value) != length) return null;
        try {
            return new String(value, StandardCharsets.US_ASCII);
        } finally {
            Arrays.fill(value, (byte) 0);
        }
    }

    static final class BridgeSshKeyException extends IOException {
        private final String code;

        BridgeSshKeyException(String code) {
            super(code);
            this.code = code;
        }

        String code() {
            return code;
        }
    }

    static final class KeyInfo {
        final String format;
        final boolean encrypted;

        KeyInfo(String format, boolean encrypted) {
            this.format = format;
            this.encrypted = encrypted;
        }
    }
}
