package dev.feishu.codex.bridge;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import androidx.activity.result.ActivityResult;
import com.hierynomus.sshj.common.KeyDecryptionFailedException;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.PublicKey;
import java.util.Arrays;
import java.util.Collections;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import net.schmizz.sshj.SSHClient;
import net.schmizz.sshj.common.SecurityUtils;
import net.schmizz.sshj.connection.channel.direct.Session;
import net.schmizz.sshj.connection.channel.direct.Session.Shell;
import net.schmizz.sshj.transport.verification.HostKeyVerifier;
import net.schmizz.sshj.userauth.UserAuthException;
import net.schmizz.sshj.userauth.keyprovider.FileKeyProvider;
import net.schmizz.sshj.userauth.method.AuthPassword;
import net.schmizz.sshj.userauth.password.PasswordFinder;
import net.schmizz.sshj.userauth.password.Resource;

/** Direct Android SSH/PTy transport for the React/xterm mobile surface. */
@CapacitorPlugin(name = "BridgeSSH")
public class BridgeSSHPlugin extends Plugin {
    private static final String KNOWN_HOSTS_PREFERENCES = "bridge_ssh_known_hosts";
    private static final String TERM = "xterm-256color";
    private static final long HOST_KEY_TIMEOUT_MILLIS = 5L * 60L * 1000L;
    private static final int MAX_PENDING_PRIVATE_KEYS = 4;

    private final ConcurrentHashMap<String, SshConnection> connections = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, PendingPrivateKey> pendingPrivateKeys = new ConcurrentHashMap<>();
    private final ExecutorService connectionExecutor = Executors.newCachedThreadPool(daemonFactory("bridge-ssh"));
    private final AtomicBoolean privateKeyPickerActive = new AtomicBoolean(false);

    @PluginMethod
    public void pickPrivateKey(PluginCall call) {
        if (pendingPrivateKeys.size() >= MAX_PENDING_PRIVATE_KEYS) {
            call.reject("Too many pending SSH private keys.", "PRIVATE_KEY_PENDING_LIMIT");
            return;
        }
        if (!privateKeyPickerActive.compareAndSet(false, true)) {
            call.reject("An SSH private-key picker is already open.", "PRIVATE_KEY_PICKER_BUSY");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivityForResult(call, intent, "privateKeyPickerResult");
        } catch (RuntimeException error) {
            privateKeyPickerActive.set(false);
            call.reject("Unable to open the SSH private-key picker.", "PRIVATE_KEY_PICKER_FAILED");
        }
    }

    @PluginMethod
    public void discardPrivateKey(PluginCall call) {
        final String keyId;
        try {
            keyId = BridgeSshProtocol.requirePrivateKeyId(call.getString("keyId"));
        } catch (Exception error) {
            call.reject("Invalid SSH private-key handle.", "INVALID_ARGUMENTS");
            return;
        }
        PendingPrivateKey pending = pendingPrivateKeys.remove(keyId);
        if (pending != null) pending.clear();
        call.resolve();
    }

    @ActivityCallback
    private void privateKeyPickerResult(PluginCall call, ActivityResult result) {
        privateKeyPickerActive.set(false);
        if (call == null) return;
        if (result == null || result.getResultCode() != Activity.RESULT_OK
            || result.getData() == null || result.getData().getData() == null) {
            call.reject("SSH private-key selection was canceled.", "PRIVATE_KEY_PICKER_CANCELED");
            return;
        }

        char[] keyMaterial = null;
        PendingPrivateKey pending = null;
        try {
            Uri uri = result.getData().getData();
            keyMaterial = readPrivateKey(uri);
            BridgeSshKeySupport.KeyInfo keyInfo = BridgeSshKeySupport.inspectForPicker(keyMaterial);
            pending = new PendingPrivateKey(
                keyMaterial,
                safeDisplayName(uri),
                keyInfo.format,
                keyInfo.encrypted);
            String keyId;
            do {
                keyId = UUID.randomUUID().toString();
            } while (pendingPrivateKeys.putIfAbsent(keyId, pending) != null);
            keyMaterial = null;

            JSObject response = new JSObject();
            response.put("keyId", keyId);
            response.put("fileName", pending.fileName);
            response.put("format", pending.format);
            response.put("encrypted", pending.encrypted);
            call.resolve(response);
        } catch (BridgeSshKeySupport.BridgeSshKeyException error) {
            call.reject(privateKeySelectionMessage(error.code()), error.code());
        } catch (PrivateKeySelectionFailure error) {
            call.reject(privateKeySelectionMessage(error.code), error.code);
        } catch (Exception error) {
            call.reject("The SSH private key could not be read.", "PRIVATE_KEY_READ_FAILED");
        } finally {
            if (keyMaterial != null) Arrays.fill(keyMaterial, '\u0000');
            if (pending != null && keyMaterial != null) pending.clear();
        }
    }

    @PluginMethod
    public void connect(PluginCall call) {
        final ConnectOptions options;
        try {
            options = ConnectOptions.from(call);
        } catch (Exception error) {
            call.reject("Invalid SSH connection parameters.", "INVALID_ARGUMENTS");
            return;
        }

        PendingPrivateKey pending = null;
        if (options.privateKeyId != null) {
            pending = pendingPrivateKeys.remove(options.privateKeyId);
            if (pending == null) {
                options.clearSecrets();
                call.reject("The selected SSH private key is no longer available.", "PRIVATE_KEY_NOT_FOUND");
                return;
            }
        }

        final SshConnection connection;
        try {
            connection = new SshConnection(options, pending);
        } catch (RuntimeException error) {
            if (pending != null) pending.clear();
            options.clearSecrets();
            call.reject("Unable to prepare the SSH private key.", "PRIVATE_KEY_READ_FAILED");
            return;
        } finally {
            if (pending != null) pending.clear();
        }
        options.clearSecrets();
        if (connections.putIfAbsent(connection.sessionId, connection) != null) {
            connection.clearSecrets();
            call.reject("An SSH session with this id is already active.", "SESSION_EXISTS");
            return;
        }
        connection.emitState("connecting", null, null);
        try {
            connectionExecutor.execute(connection::connect);
            call.resolve();
        } catch (RuntimeException error) {
            connections.remove(connection.sessionId, connection);
            connection.clearSecrets();
            call.reject("Unable to start the SSH connection.", "EXECUTOR_UNAVAILABLE");
        }
    }

    @PluginMethod
    public void approveHostKey(PluginCall call) {
        String sessionId;
        Boolean accept;
        try {
            sessionId = BridgeSshProtocol.requireSessionId(call.getString("sessionId"));
            accept = call.getBoolean("accept");
            if (accept == null) throw new IllegalArgumentException("accept");
        } catch (Exception error) {
            call.reject("Invalid host-key approval parameters.", "INVALID_ARGUMENTS");
            return;
        }
        SshConnection connection = connections.get(sessionId);
        if (connection == null) {
            call.reject("SSH session not found.", "SESSION_NOT_FOUND");
            return;
        }
        try {
            connection.approveHostKey(accept);
            call.resolve();
        } catch (IllegalStateException error) {
            call.reject("No SSH host key is waiting for approval.", "NO_PENDING_HOST_KEY");
        }
    }

    @PluginMethod
    public void send(PluginCall call) {
        String sessionId;
        byte[] data;
        try {
            sessionId = BridgeSshProtocol.requireSessionId(call.getString("sessionId"));
            data = BridgeSshProtocol.decodeInput(call.getString("dataBase64"));
        } catch (Exception error) {
            call.reject("Invalid SSH input.", "INVALID_INPUT");
            return;
        }
        SshConnection connection = connections.get(sessionId);
        if (connection == null) {
            call.reject("SSH session not found.", "SESSION_NOT_FOUND");
            return;
        }
        try {
            connection.send(data);
            call.resolve();
        } catch (IllegalStateException error) {
            call.reject("SSH PTY is not ready.", "PTY_NOT_READY");
        }
    }

    @PluginMethod
    public void resize(PluginCall call) {
        String sessionId;
        int cols;
        int rows;
        try {
            sessionId = BridgeSshProtocol.requireSessionId(call.getString("sessionId"));
            cols = BridgeSshProtocol.requireCols(call.getInt("cols"));
            rows = BridgeSshProtocol.requireRows(call.getInt("rows"));
        } catch (Exception error) {
            call.reject("Invalid SSH terminal size.", "INVALID_ARGUMENTS");
            return;
        }
        SshConnection connection = connections.get(sessionId);
        if (connection == null) {
            call.reject("SSH session not found.", "SESSION_NOT_FOUND");
            return;
        }
        try {
            connection.resize(cols, rows);
            call.resolve();
        } catch (IllegalStateException error) {
            call.reject("SSH PTY is not ready.", "PTY_NOT_READY");
        }
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        final String sessionId;
        try {
            sessionId = BridgeSshProtocol.requireSessionId(call.getString("sessionId"));
        } catch (Exception error) {
            call.reject("Invalid SSH session id.", "INVALID_ARGUMENTS");
            return;
        }
        SshConnection connection = connections.get(sessionId);
        if (connection == null) {
            call.resolve();
            return;
        }
        connection.requestDisconnect();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (SshConnection connection : connections.values()) connection.requestDisconnect();
        clearPendingPrivateKeys();
        privateKeyPickerActive.set(false);
        connectionExecutor.shutdown();
    }

    private SharedPreferences knownHosts() {
        return getContext().getSharedPreferences(KNOWN_HOSTS_PREFERENCES, Context.MODE_PRIVATE);
    }

    private boolean isKnownHost(String host, int port, String fingerprint) {
        String saved = knownHosts().getString(BridgeSshProtocol.knownHostKey(host, port), null);
        return fingerprint.equals(saved);
    }

    private void rememberHost(String host, int port, String fingerprint) {
        knownHosts().edit().putString(BridgeSshProtocol.knownHostKey(host, port), fingerprint).commit();
    }

    private char[] readPrivateKey(Uri uri) throws PrivateKeySelectionFailure {
        byte[] bytes = new byte[BridgeSshKeySupport.MAX_PRIVATE_KEY_BYTES + 1];
        try (InputStream input = getContext().getContentResolver().openInputStream(uri)) {
            if (input == null) throw new PrivateKeySelectionFailure(
                "PRIVATE_KEY_READ_FAILED", "The SSH private key could not be read.");

            int count = 0;
            while (count < bytes.length) {
                int read = input.read(bytes, count, bytes.length - count);
                if (read < 0) break;
                if (read == 0) continue;
                count += read;
            }
            if (count > BridgeSshKeySupport.MAX_PRIVATE_KEY_BYTES) {
                throw new PrivateKeySelectionFailure(
                    "PRIVATE_KEY_TOO_LARGE", "The SSH private key is larger than 256 KiB.");
            }

            String text = new String(bytes, 0, count, StandardCharsets.UTF_8);
            try {
                if (text.indexOf('\u0000') >= 0 || text.trim().isEmpty()) {
                    throw new PrivateKeySelectionFailure(
                        "PRIVATE_KEY_INVALID", "The SSH private key is invalid.");
                }
                return text.toCharArray();
            } finally {
                text = null;
            }
        } catch (PrivateKeySelectionFailure error) {
            throw error;
        } catch (Exception error) {
            // Do not expose provider paths, URI values, or exception messages to the WebView.
            throw new PrivateKeySelectionFailure(
                "PRIVATE_KEY_READ_FAILED", "The SSH private key could not be read.");
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
    }

    private String safeDisplayName(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(
            uri,
            new String[]{OpenableColumns.DISPLAY_NAME},
            null,
            null,
            null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                if (name != null && name.length() <= 255 && isSafeFileName(name)) return name;
            }
        } catch (Exception ignored) {
            // A provider may not expose a display name; use a non-sensitive fallback.
        }
        return "private-key";
    }

    private static boolean isSafeFileName(String value) {
        if (value.isEmpty() || ".".equals(value) || "..".equals(value)) return false;
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character < 0x20 || character == 0x7f || character == '/' || character == '\\') {
                return false;
            }
        }
        return true;
    }

    private static String privateKeySelectionMessage(String code) {
        if ("PRIVATE_KEY_TOO_LARGE".equals(code)) return "The SSH private key is larger than 256 KiB.";
        if (BridgeSshKeySupport.PRIVATE_KEY_FORMAT_UNSUPPORTED.equals(code)) {
            return "This SSH private-key format is not supported. Use OpenSSH or PKCS#8.";
        }
        if (BridgeSshKeySupport.PRIVATE_KEY_INVALID.equals(code)) {
            return "The SSH private key is invalid or could not be parsed.";
        }
        return "The SSH private key could not be read.";
    }

    private void clearPendingPrivateKeys() {
        for (java.util.Map.Entry<String, PendingPrivateKey> entry : pendingPrivateKeys.entrySet()) {
            if (pendingPrivateKeys.remove(entry.getKey(), entry.getValue())) entry.getValue().clear();
        }
    }

    private void emitHostKey(String sessionId, String fingerprint, String algorithm) {
        JSObject event = new JSObject();
        event.put("sessionId", sessionId);
        event.put("fingerprint", fingerprint);
        event.put("algorithm", algorithm);
        try {
            notifyListeners("sshHostKey", event, true);
        } catch (RuntimeException ignored) {
            // Never expose credentials or terminal data through a log path.
        }
    }

    private static ThreadFactory daemonFactory(final String prefix) {
        return new ThreadFactory() {
            private final AtomicInteger sequence = new AtomicInteger();

            @Override
            public Thread newThread(Runnable runnable) {
                Thread thread = new Thread(runnable, prefix + "-" + sequence.incrementAndGet());
                thread.setDaemon(true);
                return thread;
            }
        };
    }

    private final class SshConnection {
        private final String sessionId;
        private final String host;
        private final int port;
        private final String username;
        private final String startupCommand;
        private final int cols;
        private final int rows;
        private final ExecutorService io = Executors.newCachedThreadPool(daemonFactory("bridge-ssh-io"));
        private final ExecutorService writes = Executors.newSingleThreadExecutor(daemonFactory("bridge-ssh-write"));
        private final AtomicBoolean closeRequested = new AtomicBoolean(false);
        private final AtomicBoolean userDisconnectRequested = new AtomicBoolean(false);
        private final AtomicBoolean finished = new AtomicBoolean(false);
        private final Object hostKeyLock = new Object();
        private final AtomicInteger activeReaders = new AtomicInteger();
        private final boolean privateKeyEncrypted;
        private volatile char[] privateKey;
        private volatile char[] privateKeyPassphrase;
        private volatile char[] password;
        private volatile SSHClient client;
        private volatile Session session;
        private volatile Shell shell;
        private volatile OutputStream shellOutput;
        private volatile BridgeSshOutputBatcher outputBatcher;
        private volatile BridgeSshHostKeyGate pendingHostKey;
        private volatile String hostKeyFailureCode;

        SshConnection(ConnectOptions options, PendingPrivateKey pendingPrivateKey) {
            sessionId = options.sessionId;
            host = options.host;
            port = options.port;
            username = options.username;
            startupCommand = options.startupCommand;
            cols = options.cols;
            rows = options.rows;
            privateKeyEncrypted = pendingPrivateKey != null && pendingPrivateKey.encrypted;
            privateKey = pendingPrivateKey == null ? null : pendingPrivateKey.take();
            privateKeyPassphrase = options.privateKeyPassphrase == null
                ? null : options.privateKeyPassphrase.clone();
            password = options.password == null ? null : options.password.clone();
        }

        void connect() {
            try {
                if ((privateKey == null || privateKey.length == 0)
                    && (password == null || password.length == 0)) {
                    finish(new End(false, false, "AUTH_METHOD_UNSUPPORTED", null));
                    return;
                }
                SSHClient connectedClient = new SSHClient();
                client = connectedClient;
                connectedClient.addHostKeyVerifier(new InteractiveHostKeyVerifier());
                ensureOpen();
                connectedClient.connect(host, port);
                ensureOpen();
                authenticate(connectedClient);
                ensureOpen();
                Session connectedSession = connectedClient.startSession();
                connectedSession.allocatePTY(TERM, cols, rows, 0, 0, Collections.emptyMap());
                Shell connectedShell = connectedSession.startShell();
                session = connectedSession;
                shell = connectedShell;
                shellOutput = connectedShell.getOutputStream();
                outputBatcher = new BridgeSshOutputBatcher(
                    "bridge-ssh-output-" + sessionId,
                    bytes -> emitOutput(sessionId, bytes));
                startReaders(connectedShell);
                if (startupCommand != null) {
                    enqueueWrite((startupCommand + "\n").getBytes(StandardCharsets.UTF_8));
                }
                emitState("connected", null, null);
            } catch (Exception error) {
                if (userDisconnectRequested.get()) {
                    finish(new End(true, false, null, null));
                } else {
                    String code = hostKeyFailureCode != null ? hostKeyFailureCode : errorCode(error);
                    finish(new End(false, false, code, null));
                }
            }
        }

        private void authenticate(SSHClient connectedClient) throws Exception {
            if (privateKey != null && privateKey.length > 0) {
                try {
                    emitState("connecting", "Authenticating with SSH private key.", null);
                    authenticatePrivateKey(connectedClient);
                    return;
                } catch (AuthenticationFailure error) {
                    if (!"PRIVATE_KEY_AUTH_FAILED".equals(error.code)
                        || password == null || password.length == 0) {
                        throw error;
                    }
                    emitState(
                        "connecting",
                        "Private-key authentication was rejected; trying SSH password.",
                        null);
                    emitState("connecting", "Authenticating with SSH password.", null);
                    authenticatePassword(connectedClient);
                } finally {
                    clearPrivateKeyMaterial();
                }
                return;
            }

            emitState("connecting", "Authenticating with SSH password.", null);
            authenticatePassword(connectedClient);
        }

        private void authenticatePrivateKey(SSHClient connectedClient) throws Exception {
            final FileKeyProvider provider;
            try {
                provider = BridgeSshKeySupport.createProvider(privateKey, privateKeyPassphrase);
                // sshj providers parse lazily. Force parsing here so encrypted-key failures
                // become stable, non-sensitive UI error codes before authPublickey runs.
                provider.getPrivate();
            } catch (BridgeSshKeySupport.BridgeSshKeyException error) {
                throw new AuthenticationFailure(error.code(), error);
            } catch (KeyDecryptionFailedException error) {
                throw new AuthenticationFailure(
                    BridgeSshKeySupport.errorCodeForKeyRead(
                        error, privateKeyEncrypted, privateKeyPassphrase != null),
                    error);
            } catch (IOException error) {
                throw new AuthenticationFailure(
                    BridgeSshKeySupport.errorCodeForKeyRead(
                        error, privateKeyEncrypted, privateKeyPassphrase != null),
                    error);
            } catch (RuntimeException error) {
                throw new AuthenticationFailure(
                    BridgeSshKeySupport.errorCodeForKeyRead(
                        error, privateKeyEncrypted, privateKeyPassphrase != null),
                    error);
            }

            try {
                connectedClient.authPublickey(username, provider);
            } catch (UserAuthException error) {
                throw new AuthenticationFailure("PRIVATE_KEY_AUTH_FAILED", error);
            }
        }

        private void authenticatePassword(SSHClient connectedClient) throws Exception {
            final char[] secret = password.clone();
            try {
                // Deliberately use AuthPassword only. SSHClient.authPassword() also
                // adds a keyboard-interactive fallback, which this version does not expose.
                try {
                    connectedClient.auth(username, new AuthPassword(new PasswordFinder() {
                        @Override
                        public char[] reqPassword(Resource<?> resource) {
                            return secret.clone();
                        }

                        @Override
                        public boolean shouldRetry(Resource<?> resource) {
                            return false;
                        }
                    }));
                } catch (UserAuthException error) {
                    throw new AuthenticationFailure("PASSWORD_AUTH_FAILED", error);
                }
            } finally {
                Arrays.fill(secret, '\u0000');
            }
        }

        private void startReaders(Shell connectedShell) {
            int readerCount = 0;
            InputStream stdout = connectedShell.getInputStream();
            InputStream stderr = connectedShell.getErrorStream();
            if (stdout != null) readerCount++;
            if (stderr != null) readerCount++;
            activeReaders.set(readerCount);
            if (stdout != null) io.execute(() -> readLoop(stdout));
            if (stderr != null) io.execute(() -> readLoop(stderr));
            if (readerCount == 0) finish(new End(false, true, null, null));
        }

        private void readLoop(InputStream input) {
            byte[] buffer = new byte[8192];
            try {
                int count;
                while (!closeRequested.get() && (count = input.read(buffer)) != -1) {
                    if (count > 0 && outputBatcher != null) outputBatcher.offer(buffer, 0, count);
                }
            } catch (IOException error) {
                if (!closeRequested.get()) finish(new End(false, false, "READ_FAILED", null));
                return;
            } finally {
                try {
                    input.close();
                } catch (IOException ignored) {
                    // Closing a remote stream is best effort.
                }
            }
            if (!closeRequested.get() && activeReaders.decrementAndGet() == 0) {
                finish(new End(false, true, null, null));
            }
        }

        void approveHostKey(boolean accept) {
            BridgeSshHostKeyGate gate = pendingHostKey;
            if (gate == null || !gate.approve(accept)) throw new IllegalStateException();
        }

        void send(byte[] data) {
            if (shellOutput == null || closeRequested.get() || finished.get()) throw new IllegalStateException();
            enqueueWrite(data);
        }

        void resize(int newCols, int newRows) {
            if (shell == null || closeRequested.get() || finished.get()) throw new IllegalStateException();
            synchronized (writes) {
                writes.execute(() -> {
                    try {
                        if (!closeRequested.get() && shell != null) shell.changeWindowDimensions(newCols, newRows, 0, 0);
                    } catch (Exception error) {
                        if (!closeRequested.get()) finish(new End(false, false, "RESIZE_FAILED", null));
                    }
                });
            }
        }

        private void enqueueWrite(byte[] data) {
            final byte[] copy = data.clone();
            synchronized (writes) {
                try {
                    writes.execute(() -> {
                        try {
                            if (!closeRequested.get() && shellOutput != null) {
                                shellOutput.write(copy);
                                shellOutput.flush();
                            }
                        } catch (IOException error) {
                            if (!closeRequested.get()) finish(new End(false, false, "WRITE_FAILED", null));
                        } finally {
                            Arrays.fill(copy, (byte) 0);
                        }
                    });
                } catch (RuntimeException error) {
                    Arrays.fill(copy, (byte) 0);
                    throw new IllegalStateException();
                }
            }
        }

        void requestDisconnect() {
            if (!userDisconnectRequested.compareAndSet(false, true)) return;
            closeRequested.set(true);
            clearSecrets();
            BridgeSshHostKeyGate gate = pendingHostKey;
            if (gate != null) gate.approve(false);
            try {
                connectionExecutor.execute(() -> finish(new End(true, false, null, null)));
            } catch (RuntimeException error) {
                finish(new End(true, false, null, null));
            }
        }

        private void ensureOpen() throws IOException {
            if (closeRequested.get()) throw new IOException("SSH connection closed");
        }

        private void finish(End end) {
            if (!finished.compareAndSet(false, true)) return;
            closeRequested.set(true);
            BridgeSshHostKeyGate gate = pendingHostKey;
            if (gate != null) gate.approve(false);
            closeResources();
            clearSecrets();
            connections.remove(sessionId, this);
            if (end.userDisconnect) {
                emitState("disconnecting", null, null);
                emitState("disconnected", null, null);
            } else if (end.errorCode != null) {
                emitState("error", messageFor(end.errorCode), end.errorCode);
            } else if (end.exited) {
                emitState("exited", "The remote SSH PTY exited.", null);
            } else {
                emitState("disconnected", null, null);
            }
            emitExit(end.code);
        }

        private void closeResources() {
            try {
                if (shell != null) shell.close();
            } catch (Exception ignored) {
                // Best-effort shutdown; the remote tmux session is not killed by this.
            }
            try {
                if (session != null) session.close();
            } catch (Exception ignored) {
                // Best-effort shutdown.
            }
            try {
                if (client != null) client.disconnect();
            } catch (Exception ignored) {
                // Best-effort shutdown.
            }
            writes.shutdownNow();
            io.shutdownNow();
            BridgeSshOutputBatcher batcher = outputBatcher;
            if (batcher != null) batcher.close();
        }

        private void clearPrivateKeyMaterial() {
            char[] key = privateKey;
            privateKey = null;
            if (key != null) Arrays.fill(key, '\u0000');
            char[] passphrase = privateKeyPassphrase;
            privateKeyPassphrase = null;
            if (passphrase != null) Arrays.fill(passphrase, '\u0000');
        }

        private void clearSecrets() {
            clearPrivateKeyMaterial();
            char[] secret = password;
            password = null;
            if (secret != null) Arrays.fill(secret, '\u0000');
        }

        private String errorCode(Exception error) {
            if (error instanceof AuthenticationFailure) return ((AuthenticationFailure) error).code;
            if (error instanceof java.net.UnknownHostException) return "HOST_UNREACHABLE";
            if (error instanceof java.net.ConnectException) return "CONNECTION_FAILED";
            return "SSH_CONNECTION_FAILED";
        }

        private String messageFor(String code) {
            if ("AUTH_METHOD_UNSUPPORTED".equals(code)) {
                return "SSH private-key or password authentication is required.";
            }
            if ("PRIVATE_KEY_FORMAT_UNSUPPORTED".equals(code)) {
                return "This private-key format is not supported. Use OpenSSH or PKCS#8; PuTTY keys are not supported.";
            }
            if ("PRIVATE_KEY_INVALID".equals(code)) return "The SSH private key could not be parsed.";
            if ("PRIVATE_KEY_PASSPHRASE_REQUIRED".equals(code)) {
                return "The encrypted SSH private key requires a passphrase.";
            }
            if ("PRIVATE_KEY_PASSPHRASE_INVALID".equals(code)) {
                return "The SSH private-key passphrase is incorrect or the key could not be decrypted.";
            }
            if ("PRIVATE_KEY_AUTH_FAILED".equals(code)) return "SSH private-key authentication failed.";
            if ("PASSWORD_AUTH_FAILED".equals(code)) return "SSH password authentication failed.";
            if ("HOST_KEY_REJECTED".equals(code)) return "The SSH host key was not approved; connection refused.";
            if ("HOST_KEY_TIMEOUT".equals(code)) return "Timed out waiting for SSH host-key approval.";
            if ("HOST_KEY_UNSUPPORTED".equals(code)) return "This Android SSH build cannot process the remote host-key algorithm.";
            if ("HOST_UNREACHABLE".equals(code)) return "The SSH host could not be resolved.";
            if ("CONNECTION_FAILED".equals(code)) return "The SSH server could not be reached.";
            if ("WRITE_FAILED".equals(code)) return "SSH input could not be written; connection closed.";
            if ("RESIZE_FAILED".equals(code)) return "SSH PTY resize failed; connection closed.";
            if ("READ_FAILED".equals(code)) return "SSH output could not be read; connection closed.";
            return "SSH connection failed.";
        }

        private final class InteractiveHostKeyVerifier implements HostKeyVerifier {
            @Override
            public boolean verify(String hostname, int remotePort, PublicKey key) {
                final String fingerprint;
                try {
                    fingerprint = SecurityUtils.getFingerprint(key);
                } catch (RuntimeException error) {
                    hostKeyFailureCode = "HOST_KEY_UNSUPPORTED";
                    return false;
                }
                if (isKnownHost(hostname, remotePort, fingerprint)) return true;

                BridgeSshHostKeyGate gate;
                boolean announce = false;
                synchronized (hostKeyLock) {
                    gate = pendingHostKey;
                    if (gate == null || !fingerprint.equals(gate.fingerprint())) {
                        if (gate != null) gate.approve(false);
                        gate = new BridgeSshHostKeyGate(fingerprint);
                        pendingHostKey = gate;
                        announce = true;
                    }
                }
                if (announce) {
                    String message = knownHosts().contains(BridgeSshProtocol.knownHostKey(hostname, remotePort))
                        ? "The SSH host key changed; review the new fingerprint before accepting."
                        : "Review and approve this SSH host fingerprint before connecting.";
                    emitState("awaiting-host-key", message, null);
                    String algorithm = key.getAlgorithm() == null ? "unknown" : key.getAlgorithm();
                    emitHostKey(sessionId, fingerprint, algorithm);
                }
                boolean accepted = gate.await(HOST_KEY_TIMEOUT_MILLIS);
                synchronized (hostKeyLock) {
                    if (pendingHostKey == gate) pendingHostKey = null;
                }
                if (!accepted) {
                    hostKeyFailureCode = gate.wasDecided() ? "HOST_KEY_REJECTED" : "HOST_KEY_TIMEOUT";
                    return false;
                }
                if (closeRequested.get()) return false;
                rememberHost(hostname, remotePort, fingerprint);
                return true;
            }

            @Override
            public java.util.List<String> findExistingAlgorithms(String hostname, int remotePort) {
                return Collections.emptyList();
            }
        }

        private final class End {
            final boolean userDisconnect;
            final boolean exited;
            final String errorCode;
            final Integer code;

            End(boolean userDisconnect, boolean exited, String errorCode, Integer code) {
                this.userDisconnect = userDisconnect;
                this.exited = exited;
                this.errorCode = errorCode;
                this.code = code;
            }
        }

        void emitState(String state, String message, String errorCode) {
            JSObject event = new JSObject();
            event.put("sessionId", sessionId);
            event.put("state", state);
            if (message != null) event.put("message", message);
            if (errorCode != null) event.put("errorCode", errorCode);
            try {
                notifyListeners("sshState", event, true);
            } catch (RuntimeException ignored) {
                // Do not let an unavailable WebView interrupt SSH cleanup.
            }
        }

        private void emitExit(Integer code) {
            JSObject event = new JSObject();
            event.put("sessionId", sessionId);
            if (code != null) event.put("code", code);
            try {
                notifyListeners("sshExit", event, true);
            } catch (RuntimeException ignored) {
                // Do not log terminal contents or credentials.
            }
        }
    }

    private void emitOutput(String sessionId, byte[] bytes) {
        JSObject event = new JSObject();
        event.put("sessionId", sessionId);
        event.put("dataBase64", BridgeSshProtocol.encodeOutput(bytes));
        try {
            notifyListeners("sshOutput", event);
        } catch (RuntimeException ignored) {
            // Do not let WebView lifecycle failures stop the SSH reader.
        }
    }

    private static final class ConnectOptions {
        final String sessionId;
        final String host;
        final int port;
        final String username;
        final int cols;
        final int rows;
        final String startupCommand;
        final String privateKeyId;
        char[] privateKeyPassphrase;
        char[] password;

        private ConnectOptions(String sessionId, String host, int port, String username,
                               int cols, int rows, String startupCommand, String privateKeyId,
                               char[] privateKeyPassphrase, char[] password) {
            this.sessionId = sessionId;
            this.host = host;
            this.port = port;
            this.username = username;
            this.cols = cols;
            this.rows = rows;
            this.startupCommand = startupCommand;
            this.privateKeyId = privateKeyId;
            this.privateKeyPassphrase = privateKeyPassphrase;
            this.password = password;
        }

        static ConnectOptions from(PluginCall call) {
            String privateKeyId = call.getString("privateKeyId");
            String privateKeyPassphraseValue = call.getString("privateKeyPassphrase");
            String passwordValue = call.getString("password");
            char[] privateKeyPassphrase = null;
            char[] password = null;
            try {
                privateKeyId = BridgeSshProtocol.optionalPrivateKeyId(privateKeyId);
                privateKeyPassphraseValue = BridgeSshProtocol.optionalPrivateKeyPassphrase(
                    privateKeyPassphraseValue);
                passwordValue = BridgeSshProtocol.optionalPassword(passwordValue);
                privateKeyPassphrase = privateKeyPassphraseValue == null
                    ? null : privateKeyPassphraseValue.toCharArray();
                password = passwordValue == null ? null : passwordValue.toCharArray();
                if (privateKeyId == null) {
                    if (privateKeyPassphrase != null) Arrays.fill(privateKeyPassphrase, '\u0000');
                    privateKeyPassphrase = null;
                }
                return new ConnectOptions(
                    BridgeSshProtocol.requireSessionId(call.getString("sessionId")),
                    BridgeSshProtocol.requireHost(call.getString("host")),
                    BridgeSshProtocol.requirePort(call.getInt("port", BridgeSshProtocol.DEFAULT_PORT)),
                    BridgeSshProtocol.requireUsername(call.getString("username")),
                    BridgeSshProtocol.requireCols(call.getInt("cols", BridgeSshProtocol.DEFAULT_COLS)),
                    BridgeSshProtocol.requireRows(call.getInt("rows", BridgeSshProtocol.DEFAULT_ROWS)),
                    BridgeSshProtocol.optionalStartupCommand(call.getString("startupCommand")),
                    privateKeyId,
                    privateKeyPassphrase,
                    password);
            } catch (RuntimeException error) {
                if (privateKeyPassphrase != null) Arrays.fill(privateKeyPassphrase, '\u0000');
                if (password != null) Arrays.fill(password, '\u0000');
                throw error;
            } finally {
                privateKeyId = null;
                privateKeyPassphraseValue = null;
                passwordValue = null;
            }
        }

        void clearSecrets() {
            if (privateKeyPassphrase != null) Arrays.fill(privateKeyPassphrase, '\u0000');
            privateKeyPassphrase = null;
            if (password != null) Arrays.fill(password, '\u0000');
            password = null;
        }
    }

    private static final class PendingPrivateKey {
        private volatile char[] keyMaterial;
        final String fileName;
        final String format;
        final boolean encrypted;

        PendingPrivateKey(char[] keyMaterial, String fileName, String format, boolean encrypted) {
            this.keyMaterial = keyMaterial;
            this.fileName = fileName;
            this.format = format;
            this.encrypted = encrypted;
        }

        synchronized char[] take() {
            char[] result = keyMaterial;
            keyMaterial = null;
            return result;
        }

        synchronized void clear() {
            char[] material = keyMaterial;
            keyMaterial = null;
            if (material != null) Arrays.fill(material, '\u0000');
        }
    }

    private static final class PrivateKeySelectionFailure extends Exception {
        final String code;

        PrivateKeySelectionFailure(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    private static final class AuthenticationFailure extends Exception {
        final String code;

        AuthenticationFailure(String code) {
            super(code);
            this.code = code;
        }

        AuthenticationFailure(String code, Throwable cause) {
            super(code, cause);
            this.code = code;
        }
    }
}
