package dev.feishu.codex.bridge;

import android.content.Context;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Build;
import android.provider.OpenableColumns;
import android.net.wifi.WifiManager;
import android.util.Base64;
import android.util.Log;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/**
 * Foreground-only, app-to-app LAN transfer.
 *
 * The wire protocol is deliberately small and native-side. Capacitor only
 * carries file-selection metadata and control calls; the selected native URI
 * is streamed as raw binary bytes over the TCP connection. Received files are
 * streamed directly to the app cache.
 */
@CapacitorPlugin(name = "BridgeNearbyTransfer")
public class BridgeNearbyTransferPlugin extends Plugin {
    static final String SERVICE_TYPE = "_bridge-nearby._tcp";
    static final int DEFAULT_PORT = 43891;
    static final String LOG_TAG = "BridgeNearbyTransfer";

    private NearbyCore core;
    private ActivityResultLauncher<String[]> filePicker;
    private PluginCall pendingFilePicker;
    private final Map<String, NearbyFileSelection> selections = new ConcurrentHashMap<>();

    @Override
    public void load() {
        super.load();
        core = new NearbyCore(getContext(), this);
        filePicker = getBridge().registerForActivityResult(new ActivityResultContracts.OpenDocument(), this::finishFilePicker);
    }

    @PluginMethod
    public void pickFile(PluginCall call) {
        if (pendingFilePicker != null) {
            call.reject("已有一个文件选择器正在打开。", "NEARBY_PICKER_BUSY");
            return;
        }
        pendingFilePicker = call;
        filePicker.launch(new String[] { "*/*" });
    }

    @PluginMethod
    public void startServer(PluginCall call) {
        final String displayName = safeDisplayName(call.getString("displayName"), deviceDisplayName(getContext()));
        final Integer requestedPort = call.getInt("port");
        try {
            call.resolve(core.startServer(displayName, requestedPort == null ? DEFAULT_PORT : requestedPort));
        } catch (Exception error) {
            call.reject(message(error, "附近传文件服务启动失败。"), "NEARBY_SERVER_FAILED");
        }
    }

    @PluginMethod
    public void stopServer(PluginCall call) {
        core.stopServer();
        call.resolve();
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        try {
            core.startDiscovery();
            call.resolve();
        } catch (Exception error) {
            call.reject(message(error, "局域网发现启动失败。"), "NEARBY_DISCOVERY_FAILED");
        }
    }

    @PluginMethod
    public void stopDiscovery(PluginCall call) {
        core.stopDiscovery();
        call.resolve();
    }

    @PluginMethod
    public void getNetworkInfo(PluginCall call) {
        call.resolve(core.networkInfo());
    }

    @PluginMethod
    public void connect(PluginCall call) {
        final String peerId = trim(call.getString("peerId"));
        final String host = trim(call.getString("host"));
        final Integer port = call.getInt("port");
        final String token = trim(call.getString("token"));
        final String name = safeDisplayName(call.getString("name"), "附近设备");
        final String source = "hotspot".equals(call.getString("source")) ? "hotspot" : "mdns";
        try {
            JSObject result = core.connect(peerId, host, port, token, name, source);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(message(error, "附近设备连接失败。"), "NEARBY_CONNECT_FAILED");
        }
    }

    @PluginMethod
    public void acceptConnection(PluginCall call) {
        try {
            core.acceptConnection(required(call, "connectionId"));
            call.resolve();
        } catch (Exception error) {
            call.reject(message(error, "无法接受附近设备连接。"), "NEARBY_CONNECTION_FAILED");
        }
    }

    @PluginMethod
    public void rejectConnection(PluginCall call) {
        try {
            core.rejectConnection(required(call, "connectionId"));
            call.resolve();
        } catch (Exception error) {
            call.reject(message(error, "无法拒绝附近设备连接。"), "NEARBY_CONNECTION_FAILED");
        }
    }

    @PluginMethod
    public void beginFile(PluginCall call) {
        try {
            NearbyFileSelection selection = selection(required(call, "selectionId"));
            core.beginFile(
                required(call, "connectionId"),
                required(call, "transferId"),
                selection.fileName,
                selection.mimeType,
                selection.size
            );
            call.resolve();
        } catch (Exception error) {
            call.reject(message(error, "无法开始发送文件。"), "NEARBY_FILE_FAILED");
        }
    }

    @PluginMethod
    public void sendFile(PluginCall call) {
        final String selectionId;
        try { selectionId = required(call, "selectionId"); }
        catch (Exception error) { call.reject(message(error, "文件选择无效。"), "NEARBY_FILE_FAILED"); return; }
        final NearbyFileSelection selection = selections.get(selectionId);
        if (selection == null) {
            call.reject("文件选择已失效，请重新选择文件。", "NEARBY_FILE_SELECTION_EXPIRED");
            return;
        }
        try {
            core.sendFile(
                required(call, "connectionId"), required(call, "transferId"), selection,
                () -> {
                    selections.remove(selectionId);
                    try { getContext().getContentResolver().releasePersistableUriPermission(selection.uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) {}
                    getBridge().execute(call::resolve);
                },
                error -> getBridge().execute(() -> call.reject(message(error, "文件发送失败。"), "NEARBY_FILE_FAILED"))
            );
        } catch (Exception error) {
            call.reject(message(error, "文件发送失败。"), "NEARBY_FILE_FAILED");
        }
    }

    @PluginMethod
    public void sendChunk(PluginCall call) {
        try {
            core.sendChunk(
                required(call, "connectionId"),
                required(call, "transferId"),
                required(call, "dataBase64"),
                call.getBoolean("final", false)
            );
            call.resolve();
        } catch (Exception error) {
            call.reject(message(error, "文件分块发送失败。"), "NEARBY_FILE_FAILED");
        }
    }

    @PluginMethod
    public void acceptFile(PluginCall call) {
        try {
            core.acceptFile(required(call, "connectionId"), required(call, "transferId"));
            call.resolve();
        } catch (Exception error) {
            call.reject(message(error, "无法接收文件。"), "NEARBY_FILE_FAILED");
        }
    }

    @PluginMethod
    public void rejectFile(PluginCall call) {
        try {
            core.rejectFile(required(call, "connectionId"), required(call, "transferId"));
            call.resolve();
        } catch (Exception error) {
            call.reject(message(error, "无法拒绝文件。"), "NEARBY_FILE_FAILED");
        }
    }

    @PluginMethod
    public void listReceived(PluginCall call) {
        call.resolve(core.listReceived());
    }

    @PluginMethod
    public void openReceived(PluginCall call) {
        try {
            core.openReceived(required(call, "id"));
            call.resolve();
        } catch (Exception error) {
            call.reject(message(error, "无法打开接收文件。"), "NEARBY_FILE_OPEN_FAILED");
        }
    }

    @PluginMethod
    public void deleteReceived(PluginCall call) {
        try {
            core.deleteReceived(required(call, "id"));
            call.resolve();
        } catch (Exception error) {
            call.reject(message(error, "无法删除接收文件。"), "NEARBY_FILE_FAILED");
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (core != null) core.close();
        super.handleOnDestroy();
    }

    private void finishFilePicker(Uri uri) {
        PluginCall call = pendingFilePicker;
        pendingFilePicker = null;
        if (call == null) return;
        if (uri == null) {
            call.reject("已取消选择文件。", "NEARBY_PICKER_CANCELLED");
            return;
        }
        try {
            try {
                getContext().getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {}
            String fileName = "nearby-file";
            long size = -1;
            try (Cursor cursor = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                    if (nameIndex >= 0 && !cursor.isNull(nameIndex)) fileName = cursor.getString(nameIndex);
                    if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex);
                }
            }
            String mimeType = getContext().getContentResolver().getType(uri);
            if (size < 0) throw new IOException("文件提供方没有返回文件大小，暂不支持直接流式发送。");
            fileName = safeFileName(fileName);
            mimeType = safeMime(mimeType);
            if (size > NearbyCore.MAX_FILE_BYTES) throw new IOException("文件大小超过附近传输限制。");
            String selectionId = UUID.randomUUID().toString();
            NearbyFileSelection selection = new NearbyFileSelection(selectionId, uri, fileName, mimeType, size);
            selections.put(selectionId, selection);
            call.resolve(new JSObject().put("selectionId", selectionId).put("fileName", fileName).put("mimeType", mimeType).put("size", size));
        } catch (Exception error) {
            call.reject(message(error, "无法读取所选文件。"), "NEARBY_PICKER_FAILED");
        }
    }

    private NearbyFileSelection selection(String id) throws IOException {
        NearbyFileSelection selection = selections.get(id);
        if (selection == null) throw new IOException("文件选择已失效，请重新选择文件。");
        return selection;
    }

    private void emit(String event, JSObject data) {
        notifyListeners(event, data);
    }

    private static String required(PluginCall call, String key) {
        String value = trim(call.getString(key));
        if (value.isEmpty()) throw new IllegalArgumentException(key + " 不能为空。");
        return value;
    }

    private static long requiredSize(PluginCall call) {
        Integer size = call.getInt("size");
        if (size == null || size < 0) throw new IllegalArgumentException("文件大小无效。");
        return size.longValue();
    }

    private static String trim(String value) {
        return value == null ? "" : value.trim();
    }

    private static String safeDisplayName(String value) {
        return safeDisplayName(value, "附近设备");
    }

    private static String safeDisplayName(String value, String fallback) {
        String result = trim(value).replaceAll("[\\u0000-\\u001f\\u007f]", "");
        return result.length() > 80 ? result.substring(0, 80) : result.isEmpty() ? fallback : result;
    }

    private static String deviceDisplayName(Context context) {
        String model = trim(Build.MODEL);
        String manufacturer = trim(Build.MANUFACTURER);
        if (!model.isEmpty() && !manufacturer.isEmpty() && !model.toLowerCase(java.util.Locale.ROOT).startsWith(manufacturer.toLowerCase(java.util.Locale.ROOT))) {
            model = manufacturer + " " + model;
        }
        return safeDisplayName(model, "Android 手机");
    }

    private static String safeFileName(String value) {
        String result = value.replaceAll("[/\\\\\\u0000-\\u001f\\u007f]", "_").trim();
        if (result.isEmpty() || ".".equals(result) || "..".equals(result)) return "received-file";
        return result.length() > 180 ? result.substring(0, 180) : result;
    }

    private static String safeMime(String value) {
        String result = trim(value);
        return result.length() > 120 ? result.substring(0, 120) : result.isEmpty() ? "application/octet-stream" : result;
    }

    private static String safePlatform(String value) {
        return "ios".equals(value) || "android".equals(value) ? value : "unknown";
    }

    private static String message(Exception error, String fallback) {
        return error.getMessage() == null || error.getMessage().isEmpty() ? fallback : error.getMessage();
    }

    private static final class NearbyFileSelection {
        final String id;
        final Uri uri;
        final String fileName;
        final String mimeType;
        final long size;

        NearbyFileSelection(String id, Uri uri, String fileName, String mimeType, long size) {
            this.id = id; this.uri = uri; this.fileName = fileName; this.mimeType = mimeType; this.size = size;
        }
    }

    private static final class NearbyCore {
        private static final long MAX_FILE_BYTES = 1_073_741_824L;
        private static final int MAX_FRAME_CHARS = 1_400_000;

        private final Context context;
        private final BridgeNearbyTransferPlugin plugin;
        private final ExecutorService io = Executors.newCachedThreadPool();
        private final Map<String, PeerConnection> connections = new ConcurrentHashMap<>();
        private final Map<String, NsdServiceInfo> services = new ConcurrentHashMap<>();
        private final File receiveRoot;
        private final String deviceId = UUID.randomUUID().toString();
        private final NsdManager nsdManager;
        private final WifiManager wifiManager;
        private WifiManager.MulticastLock multicastLock;
        private volatile ServerSocket serverSocket;
        private volatile String displayName = "Android 手机";
        private volatile int serverPort;
        private volatile String registeredServiceName = "";
        private volatile String token = "";
        private volatile NsdManager.RegistrationListener registrationListener;
        private volatile NsdManager.DiscoveryListener discoveryListener;

        NearbyCore(Context context, BridgeNearbyTransferPlugin plugin) {
            this.context = context.getApplicationContext();
            this.plugin = plugin;
            this.nsdManager = (NsdManager) this.context.getSystemService(Context.NSD_SERVICE);
            this.wifiManager = (WifiManager) this.context.getSystemService(Context.WIFI_SERVICE);
            this.receiveRoot = new File(this.context.getCacheDir(), "bridge-downloads/nearby");
            this.displayName = deviceDisplayName(this.context);
        }

        private void diagnostic(String level, String phase, String message) {
            if ("error".equals(level)) Log.e(LOG_TAG, phase + ": " + message);
            else if ("debug".equals(level)) Log.d(LOG_TAG, phase + ": " + message);
            else Log.i(LOG_TAG, phase + ": " + message);
            plugin.emit("diagnostic", new JSObject()
                .put("timestamp", System.currentTimeMillis())
                .put("level", level)
                .put("phase", phase)
                .put("message", message));
        }

        synchronized JSObject startServer(String nextDisplayName, int port) throws IOException {
            if (port < 1 || port > 65_535) throw new IllegalArgumentException("端口无效。");
            diagnostic("info", "server.start", "requested port=" + port);
            if (serverSocket != null && !serverSocket.isClosed() && serverPort == port && displayName.equals(nextDisplayName) && !token.isEmpty()) {
                diagnostic("debug", "server.reuse", "reusing existing listener port=" + serverPort);
                return serverInfo();
            }
            stopServer();
            displayName = nextDisplayName;
            token = randomToken();
            serverSocket = new ServerSocket();
            serverSocket.setReuseAddress(true);
            serverSocket.bind(new InetSocketAddress(port));
            final ServerSocket active = serverSocket;
            serverPort = active.getLocalPort();
            diagnostic("info", "server.bound", "port=" + active.getLocalPort());
            io.execute(() -> acceptLoop(active));
            registerService(active.getLocalPort());
            return serverInfo();
        }

        private JSObject serverInfo() {
            return new JSObject().put("deviceId", deviceId).put("displayName", displayName).put("port", serverPort).put("token", token);
        }

        synchronized void stopServer() {
            diagnostic("debug", "server.stop", "stopping local server");
            try { if (serverSocket != null) serverSocket.close(); } catch (IOException ignored) {}
            serverSocket = null;
            serverPort = 0;
            if (registrationListener != null) {
                try { nsdManager.unregisterService(registrationListener); } catch (Exception ignored) {}
                registrationListener = null;
            }
            for (PeerConnection connection : new ArrayList<>(connections.values())) connection.close("服务已停止。", false);
            token = "";
            registeredServiceName = "";
            releaseMulticastLock();
        }

        synchronized void startDiscovery() {
            if (discoveryListener != null) return;
            diagnostic("info", "discovery.start", "serviceType=" + SERVICE_TYPE);
            acquireMulticastLock();
            discoveryListener = new NsdManager.DiscoveryListener() {
                @Override public void onDiscoveryStarted(String serviceType) { diagnostic("info", "discovery.ready", "serviceType=" + serviceType); }
                @Override public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                    diagnostic("error", "discovery.start_failed", "errorCode=" + errorCode);
                    plugin.emit("error", new JSObject().put("code", "NEARBY_DISCOVERY_FAILED").put("message", "Android NSD 启动失败（" + errorCode + "）。"));
                    discoveryListener = null;
                    releaseMulticastLock();
                }
                @Override public void onServiceFound(NsdServiceInfo serviceInfo) {
                    if (serviceInfo == null || serviceInfo.getServiceName().equals(registeredServiceName)) return;
                    diagnostic("debug", "discovery.found", "name=" + serviceInfo.getServiceName());
                    try {
                        nsdManager.resolveService(serviceInfo, new NsdManager.ResolveListener() {
                            @Override public void onResolveFailed(NsdServiceInfo info, int errorCode) {
                                diagnostic("error", "discovery.resolve_failed", "name=" + (info == null ? "" : info.getServiceName()) + " errorCode=" + errorCode);
                            }
                            @Override public void onServiceResolved(NsdServiceInfo resolved) {
                                if (resolved == null || resolved.getServiceName().equals(registeredServiceName)) return;
                                services.put(resolved.getServiceName(), resolved);
                                diagnostic("info", "discovery.resolved", resolved.getServiceName() + " " + (resolved.getHost() == null ? "" : resolved.getHost().getHostAddress()) + ":" + resolved.getPort());
                                plugin.emit("peerFound", new JSObject().put("peer", peerJson(resolved)));
                            }
                        });
                    } catch (Exception error) {
                        diagnostic("error", "discovery.resolve_failed", message(error, "Android NSD 解析失败。"));
                    }
                }
                @Override public void onServiceLost(NsdServiceInfo serviceInfo) {
                    if (serviceInfo == null) return;
                    NsdServiceInfo removed = services.remove(serviceInfo.getServiceName());
                    diagnostic("info", "discovery.lost", "name=" + serviceInfo.getServiceName());
                    if (removed != null) plugin.emit("peerLost", new JSObject().put("peer", peerJson(removed)));
                }
                @Override public void onStopDiscoveryFailed(String serviceType, int errorCode) {
                    diagnostic("error", "discovery.stop_failed", "errorCode=" + errorCode);
                    discoveryListener = null; releaseMulticastLock();
                }
                @Override public void onDiscoveryStopped(String serviceType) {
                    diagnostic("debug", "discovery.stopped", "serviceType=" + serviceType);
                    discoveryListener = null; releaseMulticastLock();
                }
            };
            nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
        }

        synchronized void stopDiscovery() {
            if (discoveryListener != null) {
                try { nsdManager.stopServiceDiscovery(discoveryListener); } catch (Exception ignored) {}
                discoveryListener = null;
            }
            services.clear();
            releaseMulticastLock();
        }

        JSObject networkInfo() {
            JSObject result = new JSObject();
            String gateway = "";
            try {
                if (wifiManager != null) gateway = ipv4FromInt(wifiManager.getDhcpInfo().gateway);
            } catch (Exception ignored) {}
            if (!gateway.isEmpty()) result.put("gateway", gateway);
            JSArray addresses = new JSArray();
            try {
                Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
                while (interfaces != null && interfaces.hasMoreElements()) {
                    NetworkInterface networkInterface = interfaces.nextElement();
                    if (!networkInterface.isUp() || networkInterface.isLoopback()) continue;
                    Enumeration<InetAddress> values = networkInterface.getInetAddresses();
                    while (values.hasMoreElements()) {
                        InetAddress address = values.nextElement();
                        if (!address.isLoopbackAddress()) addresses.put(address.getHostAddress());
                    }
                }
            } catch (Exception ignored) {}
            result.put("addresses", addresses);
            result.put("wifi", !gateway.isEmpty());
            return result;
        }

        JSObject connect(String peerId, String host, Integer port, String remoteToken, String name, String source) throws IOException {
            NsdServiceInfo service = peerId.isEmpty() ? null : services.get(peerId);
            String targetHost = host;
            int targetPort = port == null ? DEFAULT_PORT : port;
            String targetName = name;
            String targetDeviceId = "";
            if (service != null) {
                if (service.getHost() == null) throw new IOException("附近服务尚未解析地址，请稍后重试。");
                targetHost = service.getHost().getHostAddress();
                targetPort = service.getPort();
                targetName = attr(service, "name", service.getServiceName());
                remoteToken = attr(service, "token", remoteToken);
                targetDeviceId = attr(service, "deviceId", "");
            }
            if (targetHost == null || targetHost.isEmpty() || targetPort < 1 || targetPort > 65_535) throw new IOException("附近设备地址无效。");
            diagnostic("info", "connect.request", source + " " + targetHost + ":" + targetPort);
            String id = UUID.randomUUID().toString();
            PeerConnection connection = new PeerConnection(id, targetName.isEmpty() ? targetHost : targetName,
                targetHost, targetPort, remoteToken, source, false, targetDeviceId);
            connections.put(id, connection);
            plugin.emit("connectionState", new JSObject().put("connection", connection.stateJson("connecting", null)));
            io.execute(() -> connection.openClient());
            return new JSObject().put("connectionId", id);
        }

        void acceptConnection(String id) throws IOException {
            PeerConnection connection = connection(id);
            connection.acceptRemote();
        }

        void rejectConnection(String id) throws IOException {
            PeerConnection connection = connection(id);
            connection.send(frame("reject"));
            connection.close("已拒绝附近设备连接。", true);
        }

        void beginFile(String connectionId, String transferId, String fileName, String mimeType, long size) throws IOException {
            if (size < 0 || size > MAX_FILE_BYTES) throw new IOException("文件大小超过附近传输限制。");
            PeerConnection connection = connection(connectionId);
            if (!connection.connected) throw new IOException("附近设备尚未连接。");
            connection.send(new JSObject().put("type", "offer").put("id", transferId).put("name", fileName)
                .put("mime", mimeType).put("size", size));
        }

        void sendFile(String connectionId, String transferId, NearbyFileSelection selection, Runnable onSuccess, Consumer<Exception> onFailure) throws IOException {
            PeerConnection connection = connection(connectionId);
            if (!connection.connected) throw new IOException("附近设备尚未连接。");
            io.execute(() -> {
                try {
                    connection.sendFile(transferId, selection);
                    onSuccess.run();
                } catch (Exception error) {
                    onFailure.accept(error);
                }
            });
        }

        void sendChunk(String connectionId, String transferId, String dataBase64, boolean last) throws IOException {
            if (dataBase64.length() > MAX_FRAME_CHARS) throw new IOException("文件分块过大。");
            PeerConnection connection = connection(connectionId);
            if (!connection.connected) throw new IOException("附近设备尚未连接。");
            connection.send(new JSObject().put("type", "chunk").put("id", transferId).put("data", dataBase64).put("final", last));
        }

        void acceptFile(String connectionId, String transferId) throws IOException {
            PeerConnection connection = connection(connectionId);
            connection.acceptFile(transferId);
        }

        void rejectFile(String connectionId, String transferId) throws IOException {
            PeerConnection connection = connection(connectionId);
            connection.send(new JSObject().put("type", "fileReject").put("id", transferId));
            connection.pendingReceive = null;
        }

        JSObject listReceived() {
            JSArray files = new JSArray();
            File[] directories = receiveRoot.listFiles(File::isDirectory);
            if (directories != null) {
                for (File directory : directories) {
                    File metadata = new File(directory, "meta.json");
                    if (!metadata.isFile()) continue;
                    try (FileInputStream input = new FileInputStream(metadata)) {
                        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                        byte[] buffer = new byte[8_192];
                        int count;
                        while ((count = input.read(buffer)) >= 0) bytes.write(buffer, 0, count);
                        files.put(JSObject.fromJSONObject(new JSONObject(bytes.toString(StandardCharsets.UTF_8.name()))));
                    } catch (Exception ignored) {}
                }
            }
            return new JSObject().put("files", files);
        }

        void openReceived(String id) throws IOException {
            File directory = receivedDirectory(id);
            File metadataFile = new File(directory, "meta.json");
            if (!metadataFile.isFile()) throw new IOException("接收文件记录不存在。");
            JSONObject metadata;
            try (FileInputStream input = new FileInputStream(metadataFile)) {
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                byte[] buffer = new byte[8_192];
                int count;
                while ((count = input.read(buffer)) >= 0) bytes.write(buffer, 0, count);
                metadata = new JSONObject(bytes.toString(StandardCharsets.UTF_8.name()));
            } catch (Exception error) {
                throw new IOException("接收文件记录无效。", error);
            }
            File file = new File(directory, safeFileName(metadata.optString("fileName", "received-file"))).getCanonicalFile();
            if (!file.isFile() || !file.getParentFile().equals(directory)) throw new IOException("接收文件不存在。");
            Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
            Intent view = new Intent(Intent.ACTION_VIEW);
            view.setDataAndType(uri, safeMime(metadata.optString("mimeType", "")));
            view.setClipData(ClipData.newRawUri("Bridge nearby file", uri));
            view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                Intent chooser = Intent.createChooser(view, "打开文件");
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(chooser);
            } catch (ActivityNotFoundException error) {
                throw new IOException("设备上没有可查看此文件的应用。", error);
            }
        }

        void deleteReceived(String id) throws IOException {
            delete(receivedDirectory(id));
        }

        private File receivedDirectory(String id) throws IOException {
            if (!id.matches("[a-f0-9-]{36}")) throw new IOException("接收文件标识无效。");
            File directory = new File(receiveRoot, id).getCanonicalFile();
            String root = receiveRoot.getCanonicalPath() + File.separator;
            if (!directory.getPath().startsWith(root)) throw new IOException("接收文件路径无效。");
            return directory;
        }

        void close() {
            stopDiscovery();
            stopServer();
            io.shutdownNow();
        }

        private void acceptLoop(ServerSocket socket) {
            while (!socket.isClosed()) {
                try {
                    Socket client = socket.accept();
                    diagnostic("info", "socket.accepted", client.getInetAddress().getHostAddress() + ":" + client.getPort());
                    String id = UUID.randomUUID().toString();
                    PeerConnection connection = new PeerConnection(id, "附近设备", client.getInetAddress().getHostAddress(), client.getPort(), "", "mdns", true, "");
                    connection.socket = client;
                    connections.put(id, connection);
                    connection.startReader();
                } catch (IOException error) {
                    if (!socket.isClosed()) {
                        diagnostic("error", "socket.accept_failed", message(error, "附近服务连接失败。"));
                        plugin.emit("error", new JSObject().put("code", "NEARBY_SERVER_FAILED").put("message", message(error, "附近服务连接失败。")));
                    }
                    return;
                }
            }
        }

        private synchronized void registerService(int port) {
            final NsdServiceInfo service = new NsdServiceInfo();
            service.setServiceName("BridgeNearby-" + deviceId.substring(0, 8));
            service.setServiceType(SERVICE_TYPE);
            service.setPort(port);
            service.setAttribute("protocol", "1");
            service.setAttribute("name", displayName);
            service.setAttribute("deviceId", deviceId);
            service.setAttribute("platform", "android");
            service.setAttribute("token", token);
            registeredServiceName = service.getServiceName();
            registrationListener = new NsdManager.RegistrationListener() {
                @Override public void onServiceRegistered(NsdServiceInfo info) { registeredServiceName = info.getServiceName(); diagnostic("info", "mdns.registered", "name=" + registeredServiceName + " port=" + port); }
                @Override public void onRegistrationFailed(NsdServiceInfo info, int errorCode) { diagnostic("error", "mdns.register_failed", "errorCode=" + errorCode); plugin.emit("error", new JSObject().put("code", "NEARBY_REGISTER_FAILED").put("message", "Android NSD 注册失败（" + errorCode + "）。")); }
                @Override public void onServiceUnregistered(NsdServiceInfo info) {}
                @Override public void onUnregistrationFailed(NsdServiceInfo info, int errorCode) {}
            };
            nsdManager.registerService(service, NsdManager.PROTOCOL_DNS_SD, registrationListener);
        }

        private void acquireMulticastLock() {
            try {
                if (wifiManager == null || multicastLock != null && multicastLock.isHeld()) return;
                multicastLock = wifiManager.createMulticastLock("BridgeNearbyTransfer");
                multicastLock.setReferenceCounted(false);
                multicastLock.acquire();
            } catch (Exception ignored) {}
        }

        private void releaseMulticastLock() {
            try { if (multicastLock != null && multicastLock.isHeld()) multicastLock.release(); } catch (Exception ignored) {}
            multicastLock = null;
        }

        private PeerConnection connection(String id) throws IOException {
            PeerConnection connection = connections.get(id);
            if (connection == null) throw new IOException("附近连接不存在或已断开。");
            return connection;
        }

        private synchronized boolean registerRemoteIdentity(PeerConnection candidate, String remoteDeviceId) {
            if (remoteDeviceId.isEmpty()) return true;
            if (deviceId.equals(remoteDeviceId)) {
                diagnostic("error", "connection.self", "peer reported the local device id");
                return false;
            }
            for (PeerConnection existing : new ArrayList<>(connections.values())) {
                if (existing == candidate || existing.closed || !remoteDeviceId.equals(existing.remoteDeviceId)) continue;
                boolean preferIncoming = deviceId.compareTo(remoteDeviceId) > 0;
                if (existing.incoming == candidate.incoming || candidate.incoming != preferIncoming) {
                    diagnostic("info", "connection.duplicate", "keeping existing connection for deviceId=" + remoteDeviceId);
                    return false;
                }
                diagnostic("info", "connection.duplicate", "replacing duplicate connection for deviceId=" + remoteDeviceId);
                existing.close("同一设备的重复连接已合并。", true);
            }
            return true;
        }

        private JSObject peerJson(NsdServiceInfo service) {
            JSObject peer = new JSObject();
            peer.put("id", service.getServiceName());
            peer.put("name", attr(service, "name", service.getServiceName()));
            peer.put("deviceId", attr(service, "deviceId", ""));
            peer.put("platform", attr(service, "platform", "unknown"));
            if (service.getHost() != null) peer.put("host", service.getHost().getHostAddress());
            peer.put("port", service.getPort());
            peer.put("token", attr(service, "token", ""));
            peer.put("source", "mdns");
            return peer;
        }

        private static String attr(NsdServiceInfo service, String key, String fallback) {
            byte[] value = service.getAttributes() == null ? null : service.getAttributes().get(key);
            return value == null ? fallback : new String(value, StandardCharsets.UTF_8);
        }

        private static String randomToken() {
            return UUID.randomUUID().toString().replace("-", "");
        }

        private static String ipv4FromInt(int value) {
            if (value == 0) return "";
            return (value & 0xff) + "." + ((value >> 8) & 0xff) + "." + ((value >> 16) & 0xff) + "." + ((value >> 24) & 0xff);
        }

        private static JSObject frame(String type) { return new JSObject().put("type", type); }

        private static void delete(File file) throws IOException {
            if (file.isDirectory()) {
                File[] children = file.listFiles();
                if (children != null) for (File child : children) delete(child);
            }
            if (file.exists() && !file.delete()) throw new IOException("文件删除失败。");
        }

        private final class PeerConnection {
            final String id;
            volatile String name;
            final String host;
            final int port;
            final String remoteToken;
            final String source;
            final boolean incoming;
            volatile String remoteDeviceId;
            volatile String remotePlatform = "unknown";
            volatile Socket socket;
            volatile OutputStream output;
            volatile boolean connected;
            volatile boolean accepted;
            volatile boolean closed;
            volatile PendingReceive pendingReceive;

            PeerConnection(String id, String name, String host, int port, String remoteToken, String source, boolean incoming, String remoteDeviceId) {
                this.id = id; this.name = name; this.host = host; this.port = port; this.remoteToken = remoteToken;
                this.source = source; this.incoming = incoming; this.remoteDeviceId = remoteDeviceId;
            }

            void openClient() {
                try {
                    diagnostic("info", "socket.connecting", host + ":" + port);
                    Socket next = new Socket();
                    next.connect(new InetSocketAddress(host, port), 7_000);
                    socket = next;
                    output = new java.io.BufferedOutputStream(next.getOutputStream());
                    startReader();
                } catch (Exception error) {
                    diagnostic("error", "socket.connect_failed", message(error, "附近设备连接失败。"));
                    fail(message(error, "附近设备连接失败。"));
                }
            }

            void startReader() {
                io.execute(() -> {
                    try {
                        if (output == null) output = new java.io.BufferedOutputStream(socket.getOutputStream());
                        send(new JSObject().put("type", "hello").put("deviceId", deviceId).put("name", displayName)
                            .put("platform", "android").put("token", incoming ? token : remoteToken));
                        diagnostic("info", "protocol.hello_sent", "incoming=" + incoming + " connectionId=" + id);
                        InputStream input = new BufferedInputStream(socket.getInputStream());
                        String line;
                        while ((line = readControlLine(input)) != null) {
                            JSONObject object = new JSONObject(line);
                            if ("dataStart".equals(object.optString("type", ""))) receiveBinary(input, object);
                            else handle(object);
                        }
                        close("附近设备已断开。", true);
                    } catch (Exception error) {
                        if (!socket.isClosed()) fail(message(error, "附近传输连接失败。"));
                    }
                });
            }

            synchronized void send(JSONObject object) throws IOException {
                if (output == null) throw new IOException("附近连接尚未准备好。");
                output.write(object.toString().getBytes(StandardCharsets.UTF_8));
                output.write('\n');
                output.flush();
            }

            synchronized void sendFile(String transferId, NearbyFileSelection selection) throws IOException {
                if (output == null) throw new IOException("附近连接尚未准备好。");
                try (InputStream input = context.getContentResolver().openInputStream(selection.uri)) {
                    if (input == null) throw new IOException("无法打开所选文件。");
                    diagnostic("info", "file.binary_start", "connectionId=" + id + " size=" + selection.size);
                    send(new JSObject().put("type", "dataStart").put("id", transferId).put("size", selection.size));
                    long sent = 0;
                    long lastReported = 0;
                    byte[] buffer = new byte[64 * 1024];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (count == 0) continue;
                        output.write(buffer, 0, count);
                        sent += count;
                        if (sent - lastReported >= 256 * 1024 || sent == selection.size) {
                            plugin.emit("fileProgress", new JSObject().put("progress", new JSObject()
                                .put("connectionId", id).put("transferId", transferId).put("direction", "send")
                                .put("bytes", sent).put("totalBytes", selection.size)));
                            lastReported = sent;
                        }
                    }
                    if (sent != selection.size) throw new IOException("发送文件大小校验失败。");
                    output.flush();
                    send(new JSObject().put("type", "dataEnd").put("id", transferId));
                    diagnostic("info", "file.binary_sent", "connectionId=" + id + " size=" + sent);
                } catch (IOException error) {
                    close(message(error, "文件二进制流发送失败。"), true);
                    throw error;
                }
            }

            private static String readControlLine(InputStream input) throws IOException {
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                int value;
                while ((value = input.read()) != -1) {
                    if (value == '\n') break;
                    if (value != '\r') bytes.write(value);
                    if (bytes.size() > MAX_FRAME_CHARS) throw new IOException("附近协议帧过大。");
                }
                if (value == -1 && bytes.size() == 0) return null;
                return bytes.toString(StandardCharsets.UTF_8.name());
            }

            private void receiveBinary(InputStream input, JSONObject object) throws IOException {
                String transferId = object.optString("id", "");
                long expected = object.optLong("size", -1);
                PendingReceive receive = pendingReceive;
                if (receive == null || !receive.transferId.equals(transferId) || receive.output == null || expected != receive.size) {
                    throw new IOException("收到未授权或大小不匹配的二进制文件流。");
                }
                long remaining = expected;
                byte[] buffer = new byte[64 * 1024];
                long lastReported = receive.bytes;
                while (remaining > 0) {
                    int count = input.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                    if (count < 0) throw new IOException("文件二进制流提前结束。");
                    if (count == 0) continue;
                    receive.output.write(buffer, 0, count);
                    receive.bytes += count;
                    remaining -= count;
                    if (receive.bytes - lastReported >= 256 * 1024 || remaining == 0) {
                        plugin.emit("fileProgress", new JSObject().put("progress", new JSObject()
                            .put("connectionId", id).put("transferId", transferId).put("direction", "receive")
                            .put("bytes", receive.bytes).put("totalBytes", receive.size)));
                        lastReported = receive.bytes;
                    }
                }
                finishReceive(receive);
            }

            void handle(JSONObject object) throws Exception {
                String type = object.optString("type", "");
                if ("hello".equals(type)) {
                    String incomingDeviceId = trim(object.optString("deviceId", ""));
                    if (!remoteDeviceId.isEmpty() && !incomingDeviceId.isEmpty() && !remoteDeviceId.equals(incomingDeviceId)) {
                        diagnostic("error", "protocol.identity_mismatch", "peer device id changed");
                        throw new IOException("附近设备身份发生变化。");
                    }
                    if (!incomingDeviceId.isEmpty()) remoteDeviceId = incomingDeviceId;
                    remotePlatform = safePlatform(object.optString("platform", "unknown"));
                    name = safeDisplayName(object.optString("name", name), "附近设备");
                    String offeredToken = object.optString("token", "");
                    diagnostic("info", "protocol.hello_received", "incoming=" + incoming + " peer=" + name);
                    String expectedToken = incoming ? token : remoteToken;
                    if (!expectedToken.isEmpty() && !offeredToken.isEmpty() && !offeredToken.equals(expectedToken)) {
                        diagnostic("error", "protocol.token_mismatch", "peer=" + name);
                        send(frame("reject"));
                        close("附近设备配对信息不匹配。", true);
                        return;
                    }
                    if (!registerRemoteIdentity(this, remoteDeviceId)) {
                        send(frame("reject"));
                        close("同一设备的重复连接已合并。", true);
                        return;
                    }
                    if (incoming) {
                        diagnostic("info", "connection.waiting_accept", "connectionId=" + id);
                        plugin.emit("connectionState", new JSObject().put("connection", stateJson("requested", null)));
                    }
                    return;
                }
                if ("accept".equals(type)) {
                    diagnostic("info", "connection.accepted_remote", "connectionId=" + id);
                    connected = true;
                    accepted = true;
                    plugin.emit("connectionState", new JSObject().put("connection", stateJson("connected", null)));
                    return;
                }
                if ("reject".equals(type)) {
                    diagnostic("info", "connection.rejected_remote", "connectionId=" + id);
                    close("对方拒绝了连接。", true);
                    return;
                }
                if ("offer".equals(type)) {
                    long size = object.optLong("size", -1);
                    String transferId = object.optString("id", "");
                    if (transferId.isEmpty() || size < 0 || size > MAX_FILE_BYTES) throw new IOException("附近文件信息无效。");
                    pendingReceive = new PendingReceive(transferId, safeFileName(object.optString("name", "received-file")), safeMime(object.optString("mime", "")), size);
                    diagnostic("info", "file.offer", "connectionId=" + id + " size=" + size);
                    JSObject offer = new JSObject().put("connectionId", id).put("transferId", transferId).put("fileName", pendingReceive.fileName)
                        .put("mimeType", pendingReceive.mimeType).put("size", size);
                    plugin.emit("fileOffer", new JSObject().put("offer", offer));
                    return;
                }
                if ("fileAccept".equals(type)) {
                    plugin.emit("fileAccepted", new JSObject().put("connectionId", id).put("transferId", object.optString("id", "")));
                    return;
                }
                if ("fileReject".equals(type)) {
                    plugin.emit("error", new JSObject().put("code", "NEARBY_FILE_REJECTED").put("message", "对方拒绝接收文件。").put("connectionId", id).put("transferId", object.optString("id", "")));
                    return;
                }
                if ("chunk".equals(type)) {
                    PendingReceive receive = pendingReceive;
                    if (receive == null || !receive.transferId.equals(object.optString("id", "")) || receive.output == null) throw new IOException("收到未授权的文件分块。");
                    byte[] bytes = Base64.decode(object.optString("data", ""), Base64.DEFAULT);
                    if (receive.bytes + bytes.length > receive.size || receive.bytes + bytes.length > MAX_FILE_BYTES) throw new IOException("接收文件大小异常。");
                    receive.output.write(bytes);
                    receive.bytes += bytes.length;
                    plugin.emit("fileProgress", new JSObject().put("progress", new JSObject().put("connectionId", id).put("transferId", receive.transferId)
                        .put("direction", "receive").put("bytes", receive.bytes).put("totalBytes", receive.size)));
                    if (object.optBoolean("final", false)) finishReceive(receive);
                }
            }

            void acceptRemote() throws IOException {
                diagnostic("info", "connection.accept_local", "connectionId=" + id);
                accepted = true;
                send(frame("accept"));
                connected = true;
                plugin.emit("connectionState", new JSObject().put("connection", stateJson("connected", null)));
            }

            void acceptFile(String transferId) throws IOException {
                PendingReceive receive = pendingReceive;
                if (receive == null || !receive.transferId.equals(transferId)) throw new IOException("文件接收请求已失效。");
                if (!receiveRoot.exists() && !receiveRoot.mkdirs()) throw new IOException("无法创建接收目录。");
                File directory = new File(receiveRoot, transferId).getCanonicalFile();
                String root = receiveRoot.getCanonicalPath() + File.separator;
                if (!directory.getPath().startsWith(root)) throw new IOException("接收文件路径无效。");
                if (!directory.exists() && !directory.mkdirs()) throw new IOException("无法创建接收文件目录。");
                receive.path = new File(directory, receive.fileName);
                receive.output = new FileOutputStream(receive.path, false);
                diagnostic("info", "file.accept_local", "connectionId=" + id + " transferId=" + transferId);
                send(new JSObject().put("type", "fileAccept").put("id", transferId));
            }

            void finishReceive(PendingReceive receive) throws IOException {
                receive.output.close();
                if (receive.bytes != receive.size) throw new IOException("接收文件大小校验失败。");
                JSObject metadata = new JSObject().put("id", receive.transferId).put("fileName", receive.fileName).put("mimeType", receive.mimeType)
                    .put("size", receive.size).put("createdAt", System.currentTimeMillis()).put("path", "bridge-downloads/nearby/" + receive.transferId + "/" + receive.fileName);
                try (FileOutputStream output = new FileOutputStream(new File(receive.path.getParentFile(), "meta.json"), false)) {
                    output.write(metadata.toString().getBytes(StandardCharsets.UTF_8));
                }
                plugin.emit("fileReceived", new JSObject().put("file", metadata).put("connectionId", id).put("transferId", receive.transferId));
                diagnostic("info", "file.received", "connectionId=" + id + " size=" + receive.size);
                pendingReceive = null;
            }

            JSObject stateJson(String state, String error) {
                JSObject peer = new JSObject().put("id", id).put("name", name).put("host", host).put("port", port).put("source", source)
                    .put("deviceId", remoteDeviceId).put("platform", remotePlatform);
                return new JSObject().put("id", id).put("peer", peer).put("state", state).put("incoming", incoming).put("error", error == null ? JSONObject.NULL : error);
            }

            void fail(String error) {
                diagnostic("error", "connection.failed", "connectionId=" + id + " " + error);
                plugin.emit("connectionState", new JSObject().put("connection", stateJson("failed", error)));
                close(error, false);
            }

            synchronized void close(String reason, boolean notify) {
                if (closed) return;
                closed = true;
                connected = false;
                diagnostic("debug", "connection.closed", "connectionId=" + id + " reason=" + reason);
                try { if (pendingReceive != null && pendingReceive.output != null) pendingReceive.output.close(); } catch (IOException ignored) {}
                try { if (socket != null) socket.close(); } catch (IOException ignored) {}
                connections.remove(id, this);
                if (notify) plugin.emit("connectionState", new JSObject().put("connection", stateJson("closed", reason)));
            }
        }

        private static final class PendingReceive {
            final String transferId;
            final String fileName;
            final String mimeType;
            final long size;
            long bytes;
            File path;
            FileOutputStream output;
            PendingReceive(String transferId, String fileName, String mimeType, long size) {
                this.transferId = transferId; this.fileName = fileName; this.mimeType = mimeType; this.size = size;
            }
        }
    }
}
