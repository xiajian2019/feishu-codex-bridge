package dev.feishu.codex.bridge;

import com.hierynomus.sshj.common.KeyDecryptionFailedException;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.CharArrayReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import net.schmizz.sshj.userauth.keyprovider.FileKeyProvider;
import net.schmizz.sshj.userauth.keyprovider.KeyFormat;
import net.schmizz.sshj.userauth.keyprovider.KeyProviderUtil;
import net.schmizz.sshj.userauth.password.PasswordFinder;
import net.schmizz.sshj.userauth.password.Resource;

/**
 * Parses in-memory SSH private keys without creating a file or persisting key material.
 *
 * The sshj providers read lazily, so callers must keep the supplied char arrays alive until
 * the provider has been used for authentication. The caller may then wipe the arrays; the
 * provider retains the parsed KeyPair, not the source reader's original characters.
 */
final class BridgeSshKeySupport {
    static final int MAX_PRIVATE_KEY_BYTES = 256 * 1024;
    static final String PRIVATE_KEY_FORMAT_UNSUPPORTED = "PRIVATE_KEY_FORMAT_UNSUPPORTED";
    static final String PRIVATE_KEY_INVALID = "PRIVATE_KEY_INVALID";
    static final String PRIVATE_KEY_PASSPHRASE_REQUIRED = "PRIVATE_KEY_PASSPHRASE_REQUIRED";
    static final String PRIVATE_KEY_PASSPHRASE_INVALID = "PRIVATE_KEY_PASSPHRASE_INVALID";

    private BridgeSshKeySupport() {}

    static KeyFormat detectFormat(char[] privateKey) throws IOException {
        if (privateKey == null || privateKey.length == 0) {
            throw new IOException(PRIVATE_KEY_INVALID);
        }
        // The boolean tells sshj whether a PEM key without an explicit PKCS#8 header should
        // be treated as the legacy OpenSSH format. PKCS#8 has distinct PRIVATE KEY headers.
        boolean legacyOpenSshPem = hasLegacyOpenSshPemHeader(privateKey);
        return KeyProviderUtil.detectKeyFileFormat(new CharArrayReader(privateKey), legacyOpenSshPem);
    }

    static FileKeyProvider createProvider(char[] privateKey, char[] passphrase)
        throws IOException {
        KeyFormat format = detectFormat(privateKey);
        FileKeyProvider provider;
        switch (format) {
            case OpenSSH:
                provider = new net.schmizz.sshj.userauth.keyprovider.OpenSSHKeyFile();
                break;
            case OpenSSHv1:
                provider = new com.hierynomus.sshj.userauth.keyprovider.OpenSSHKeyV1KeyFile();
                break;
            case PKCS8:
                provider = new net.schmizz.sshj.userauth.keyprovider.PKCS8KeyFile();
                break;
            case PuTTY:
                throw new BridgeSshKeyException(PRIVATE_KEY_FORMAT_UNSUPPORTED);
            case Unknown:
            default:
                throw new BridgeSshKeyException(PRIVATE_KEY_FORMAT_UNSUPPORTED);
        }

        PasswordFinder finder = passphrase == null ? null : new CopyingPasswordFinder(passphrase);
        provider.init(new CharArrayReader(privateKey), finder);
        return provider;
    }

    static KeyInfo inspectForPicker(char[] privateKey) throws IOException {
        KeyFormat format = detectFormat(privateKey);
        String formatName;
        switch (format) {
            case OpenSSH:
                formatName = "openssh";
                break;
            case OpenSSHv1:
                formatName = "openssh-new";
                break;
            case PKCS8:
                formatName = "pkcs8";
                break;
            case PuTTY:
            case Unknown:
            default:
                throw new BridgeSshKeyException(PRIVATE_KEY_FORMAT_UNSUPPORTED);
        }

        boolean encrypted = isEncrypted(privateKey);
        if (!encrypted) {
            try {
                createProvider(privateKey, null).getPrivate();
            } catch (Exception error) {
                // Do not carry sshj's provider/resource exception into the Capacitor response.
                throw new BridgeSshKeyException(PRIVATE_KEY_INVALID);
            }
        }
        return new KeyInfo(formatName, encrypted);
    }

    static String errorCodeForKeyRead(Throwable error, boolean encrypted, boolean hasPassphrase) {
        if (encrypted) {
            return hasPassphrase
                ? PRIVATE_KEY_PASSPHRASE_INVALID
                : PRIVATE_KEY_PASSPHRASE_REQUIRED;
        }
        if (error instanceof KeyDecryptionFailedException) return PRIVATE_KEY_INVALID;
        return PRIVATE_KEY_INVALID;
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

    private static boolean hasLegacyOpenSshPemHeader(char[] privateKey) {
        String header = firstNonEmptyLine(privateKey);
        if (header == null) return false;
        return header.endsWith("RSA PRIVATE KEY-----")
            || header.endsWith("DSA PRIVATE KEY-----")
            || header.endsWith("EC PRIVATE KEY-----");
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

    private static final class CopyingPasswordFinder implements PasswordFinder {
        private final char[] passphrase;

        CopyingPasswordFinder(char[] passphrase) {
            this.passphrase = passphrase;
        }

        @Override
        public char[] reqPassword(Resource<?> resource) {
            return passphrase.clone();
        }

        @Override
        public boolean shouldRetry(Resource<?> resource) {
            return false;
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
