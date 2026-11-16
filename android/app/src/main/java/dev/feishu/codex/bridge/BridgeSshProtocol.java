package dev.feishu.codex.bridge;

import java.util.Locale;

/** Small, Android-independent validation and host-key helpers for native SSH. */
final class BridgeSshProtocol {
    /** The Web/App global config supplies the Mac host; native code has no IP fallback. */
    static final String DEFAULT_HOST = "";
    static final int DEFAULT_PORT = 22;
    static final int DEFAULT_COLS = 80;
    static final int DEFAULT_ROWS = 24;
    static final int MIN_COLS = 2;
    static final int MAX_COLS = 512;
    static final int MIN_ROWS = 1;
    static final int MAX_ROWS = 256;
    static final int MAX_SESSION_ID_LENGTH = 128;
    static final int MAX_HOST_LENGTH = 255;
    static final int MAX_USERNAME_LENGTH = 256;
    static final int MAX_PASSWORD_LENGTH = 16 * 1024;
    static final int MAX_PRIVATE_KEY_ID_LENGTH = 128;
    static final int MAX_PRIVATE_KEY_PASSPHRASE_LENGTH = 16 * 1024;
    static final int MAX_STARTUP_COMMAND_LENGTH = 8 * 1024;

    private BridgeSshProtocol() {}

    static String requireSessionId(String value) {
        return requireText(value, "sessionId", MAX_SESSION_ID_LENGTH, true);
    }

    static String requireHost(String value) {
        return requireText(value, "host", MAX_HOST_LENGTH, false);
    }

    static String requireUsername(String value) {
        String username = requireText(value, "username", MAX_USERNAME_LENGTH, false);
        if (containsWhitespace(username)) throw new IllegalArgumentException("username");
        return username;
    }

    static int requirePort(Integer value) {
        if (value == null || value < 1 || value > 65535) throw new IllegalArgumentException("port");
        return value;
    }

    static int requireCols(Integer value) {
        return requireDimension(value, MIN_COLS, MAX_COLS, "cols");
    }

    static int requireRows(Integer value) {
        return requireDimension(value, MIN_ROWS, MAX_ROWS, "rows");
    }

    static String optionalPassword(String value) {
        if (value == null) return null;
        if (value.length() > MAX_PASSWORD_LENGTH || value.indexOf('\u0000') >= 0) {
            throw new IllegalArgumentException("password");
        }
        return value;
    }

    static String optionalPrivateKeyId(String value) {
        if (value == null || value.trim().isEmpty()) return null;
        return requireText(value, "privateKeyId", MAX_PRIVATE_KEY_ID_LENGTH, false);
    }

    static String requirePrivateKeyId(String value) {
        String normalized = optionalPrivateKeyId(value);
        if (normalized == null) throw new IllegalArgumentException("privateKeyId");
        return normalized;
    }

    static String optionalPrivateKeyPassphrase(String value) {
        if (value == null) return null;
        if (value.length() > MAX_PRIVATE_KEY_PASSPHRASE_LENGTH || value.indexOf('\u0000') >= 0) {
            throw new IllegalArgumentException("privateKeyPassphrase");
        }
        return value;
    }

    static String optionalStartupCommand(String value) {
        if (value == null) return null;
        if (value.length() > MAX_STARTUP_COMMAND_LENGTH || value.indexOf('\u0000') >= 0) {
            throw new IllegalArgumentException("startupCommand");
        }
        return value.isEmpty() ? null : value;
    }

    static String knownHostKey(String host, int port) {
        return host.toLowerCase(Locale.US) + ":" + port;
    }

    private static int requireDimension(Integer value, int minimum, int maximum, String name) {
        if (value == null || value < minimum || value > maximum) throw new IllegalArgumentException(name);
        return value;
    }

    private static String requireText(String value, String name, int maximum, boolean allowWhitespace) {
        if (value == null) throw new IllegalArgumentException(name);
        String normalized = value.trim();
        if (normalized.isEmpty() || normalized.length() > maximum || containsControl(normalized)) {
            throw new IllegalArgumentException(name);
        }
        if (!allowWhitespace && containsWhitespace(normalized)) throw new IllegalArgumentException(name);
        return normalized;
    }

    private static boolean containsControl(String value) {
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character < 0x20 || character == 0x7f) return true;
        }
        return false;
    }

    private static boolean containsWhitespace(String value) {
        for (int index = 0; index < value.length(); index++) {
            if (Character.isWhitespace(value.charAt(index))) return true;
        }
        return false;
    }
}
