package dev.feishu.codex.bridge;

import android.Manifest;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.media.MediaScannerConnection;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.MimeTypeMap;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

/** Downloads authenticated files and opens downloaded APKs in Android's package installer. */
@CapacitorPlugin(
    name = "BridgeUpdater",
    permissions = {
        @Permission(
            alias = "publicStorage",
            strings = { Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE }
        )
    }
)
public class BridgeUpdaterPlugin extends Plugin {
    private static final String PUBLIC_STORAGE = "publicStorage";

    @PluginMethod
    public void download(PluginCall call) {
        if (!isPublicStorageGranted()) {
            requestPermissionForAlias(PUBLIC_STORAGE, call, "permissionCallback");
            return;
        }
        enqueueDownload(call);
    }

    @PluginMethod
    public void save(PluginCall call) {
        if (!isPublicStorageGranted()) {
            requestPermissionForAlias(PUBLIC_STORAGE, call, "permissionCallback");
            return;
        }
        saveBlob(call);
    }

    @PluginMethod
    public void getDownloads(PluginCall call) {
        JSArray requestedIds = call.getArray("ids");
        if (requestedIds == null || requestedIds.length() > 100) {
            call.reject("请提供最多 100 个有效下载编号。", "INVALID_DOWNLOAD_IDS");
            return;
        }
        long[] ids = new long[requestedIds.length()];
        for (int index = 0; index < requestedIds.length(); index++) {
            Object value = requestedIds.opt(index);
            if (!(value instanceof Number)) {
                call.reject("下载编号无效。", "INVALID_DOWNLOAD_IDS");
                return;
            }
            double numericId = ((Number) value).doubleValue();
            if (Double.isNaN(numericId) || Double.isInfinite(numericId) || numericId <= 0
                || numericId > 9_007_199_254_740_991d || numericId != Math.rint(numericId)) {
                call.reject("下载编号无效。", "INVALID_DOWNLOAD_IDS");
                return;
            }
            ids[index] = ((Number) value).longValue();
        }
        JSArray downloads = new JSArray();
        if (ids.length == 0) {
            JSObject result = new JSObject();
            result.put("downloads", downloads);
            call.resolve(result);
            return;
        }
        DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) {
            call.reject("系统下载服务不可用。", "DOWNLOAD_SERVICE_UNAVAILABLE");
            return;
        }
        // The default DownloadManager query only exposes downloads owned by this app.
        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(ids))) {
            if (cursor == null) {
                call.reject("暂时无法读取下载进度，请稍后重试。", "DOWNLOAD_QUERY_FAILED");
                return;
            }
            Map<Long, JSObject> found = new HashMap<>();
            while (cursor.moveToNext()) {
                long id = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_ID));
                JSObject download = new JSObject();
                download.put("id", id);
                download.put("fileName", downloadFileName(cursor));
                download.put("downloadedBytes", Math.max(0L,
                    cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))));
                // DownloadManager uses -1 when the server has not supplied a total size.
                download.put("totalBytes", Math.max(0L,
                    cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))));
                int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                switch (status) {
                    case DownloadManager.STATUS_PENDING:
                        download.put("state", "queued");
                        break;
                    case DownloadManager.STATUS_RUNNING:
                        download.put("state", "downloading");
                        break;
                    case DownloadManager.STATUS_PAUSED:
                        download.put("state", "paused");
                        download.put("reason", pausedDownloadReason(reason));
                        break;
                    case DownloadManager.STATUS_SUCCESSFUL:
                        download.put("state", "done");
                        break;
                    case DownloadManager.STATUS_FAILED:
                        download.put("state", "error");
                        download.put("reason", failedDownloadReason(reason));
                        break;
                    default:
                        download.put("state", "error");
                        download.put("reason", "无法识别下载状态，请在系统下载中确认。");
                }
                found.put(id, download);
            }
            for (long id : ids) {
                JSObject download = found.get(id);
                if (download == null) {
                    download = new JSObject();
                    download.put("id", id);
                    download.put("fileName", "");
                    download.put("state", "error");
                    download.put("downloadedBytes", 0);
                    download.put("totalBytes", 0);
                    download.put("reason", "下载记录已移除，请在系统下载中确认文件。");
                }
                downloads.put(download);
            }
            JSObject result = new JSObject();
            result.put("downloads", downloads);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("暂时无法读取下载进度，请稍后重试。", "DOWNLOAD_QUERY_FAILED");
        }
    }

    private String downloadFileName(Cursor cursor) {
        String localUri = cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI));
        if (localUri != null) {
            String fileName = Uri.parse(localUri).getLastPathSegment();
            if (fileName != null && !fileName.isEmpty()) return fileName;
        }
        String title = cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TITLE));
        return title == null ? "" : title;
    }

    private String pausedDownloadReason(int reason) {
        switch (reason) {
            case DownloadManager.PAUSED_WAITING_TO_RETRY:
                return "网络暂时异常，系统正在等待重试。";
            case DownloadManager.PAUSED_WAITING_FOR_NETWORK:
                return "等待网络连接后继续下载。";
            case DownloadManager.PAUSED_QUEUED_FOR_WIFI:
                return "等待 Wi-Fi 连接后继续下载。";
            default:
                return "系统已暂停下载，等待恢复。";
        }
    }

    private String failedDownloadReason(int reason) {
        switch (reason) {
            case DownloadManager.ERROR_INSUFFICIENT_SPACE:
                return "设备存储空间不足，请清理后重新下载。";
            case DownloadManager.ERROR_DEVICE_NOT_FOUND:
                return "存储设备不可用，请检查后重新下载。";
            case DownloadManager.ERROR_FILE_ALREADY_EXISTS:
                return "已存在同名文件，请在系统下载中确认。";
            case DownloadManager.ERROR_FILE_ERROR:
                return "无法保存文件，请检查存储权限和剩余空间。";
            case DownloadManager.ERROR_CANNOT_RESUME:
                return "下载中断且无法续传，请重新下载。";
            case DownloadManager.ERROR_HTTP_DATA_ERROR:
                return "网络传输失败，请检查连接后重新下载。";
            case DownloadManager.ERROR_TOO_MANY_REDIRECTS:
            case DownloadManager.ERROR_UNHANDLED_HTTP_CODE:
                return "下载服务响应异常，请重新下载。";
            case 401:
            case 403:
                return "下载授权已失效或无权访问，请重新下载。";
            case 404:
                return "文件已不存在，请刷新页面后重试。";
            default:
                if (reason >= 400 && reason <= 599) return "下载服务返回错误（HTTP " + reason + "），请重试。";
                return "系统下载失败，请检查网络和存储后重试。";
        }
    }

    @PluginMethod
    public void openDownloads(PluginCall call) {
        try {
            Intent intent = new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("无法打开系统下载，请在文件管理器中查看 Downloads 文件夹。", "DOWNLOADS_UNAVAILABLE");
        }
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        if (!isPublicStorageGranted()) {
            call.reject("没有获得保存到系统 Downloads 的权限。", "PUBLIC_STORAGE_PERMISSION_DENIED");
            return;
        }
        if ("save".equals(call.getMethodName())) saveBlob(call);
        else enqueueDownload(call);
    }

    private boolean isPublicStorageGranted() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.R || getPermissionState(PUBLIC_STORAGE) == PermissionState.GRANTED;
    }

    private void enqueueDownload(PluginCall call) {
        String rawUrl = call.getString("url");
        String token = call.getString("token");
        String suppliedName = call.getString("fileName");
        if (rawUrl == null || token == null || suppliedName == null) {
            call.reject("下载参数不完整。", "INVALID_DOWNLOAD_REQUEST");
            return;
        }
        Uri url = Uri.parse(rawUrl);
        if (!("http".equals(url.getScheme()) || "https".equals(url.getScheme())) || url.getUserInfo() != null
            || !token.matches("[A-Za-z0-9_-]{40,128}")) {
            call.reject("下载地址或授权信息无效。", "INVALID_DOWNLOAD_REQUEST");
            return;
        }
        String safeName = sanitizeFileName(suppliedName);
        String downloadName = "Bridge-" + System.currentTimeMillis() + "-" + safeName;
        String userAgent = call.getString("userAgent");
        if (userAgent != null && (userAgent.length() > 2048 || userAgent.indexOf('\r') >= 0 || userAgent.indexOf('\n') >= 0)) {
            call.reject("下载客户端信息无效。", "INVALID_DOWNLOAD_REQUEST");
            return;
        }
        String mimeType = call.getString("mimeType");
        if (mimeType == null || mimeType.isEmpty()) mimeType = mimeTypeFor(safeName);
        try {
            DownloadManager.Request request = new DownloadManager.Request(url);
            request.addRequestHeader("Authorization", "Bearer " + token);
            if (userAgent != null && !userAgent.isEmpty()) request.addRequestHeader("User-Agent", userAgent);
            request.setTitle(safeName);
            request.setDescription("Bridge 文件下载");
            request.setMimeType(mimeType);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(false);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, downloadName);
            DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) {
                call.reject("系统下载服务不可用。", "DOWNLOAD_SERVICE_UNAVAILABLE");
                return;
            }
            long id = manager.enqueue(request);
            JSObject result = new JSObject();
            result.put("id", id);
            result.put("fileName", downloadName);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("无法开始下载，请检查系统存储权限和剩余空间。", "DOWNLOAD_START_FAILED");
        }
    }

    private void saveBlob(PluginCall call) {
        String data = call.getString("data");
        String suppliedName = call.getString("fileName");
        if (data == null || suppliedName == null || data.isEmpty()) {
            call.reject("保存参数不完整。", "INVALID_SAVE_REQUEST");
            return;
        }
        String safeName = sanitizeFileName(suppliedName);
        String savedName = "Bridge-" + System.currentTimeMillis() + "-" + safeName;
        String mimeType = call.getString("mimeType");
        if (mimeType == null || mimeType.isEmpty()) mimeType = mimeTypeFor(safeName);
        byte[] bytes;
        try {
            bytes = Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            call.reject("文件内容无效。", "INVALID_SAVE_REQUEST");
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, savedName);
                values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                ContentResolver resolver = getContext().getContentResolver();
                Uri item = resolver.insert(MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values);
                if (item == null) {
                    call.reject("无法创建系统下载文件。", "DOWNLOAD_SAVE_FAILED");
                    return;
                }
                try (OutputStream output = resolver.openOutputStream(item)) {
                    if (output == null) throw new IOException("download output unavailable");
                    output.write(bytes);
                } catch (Exception error) {
                    resolver.delete(item, null, null);
                    throw new IllegalStateException(error);
                }
                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                resolver.update(item, values, null, null);
            } else {
                File directory = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!directory.exists() && !directory.mkdirs()) throw new IOException("download directory unavailable");
                File file = new File(directory, savedName);
                try (FileOutputStream output = new FileOutputStream(file)) {
                    output.write(bytes);
                }
                MediaScannerConnection.scanFile(getContext(), new String[] { file.getAbsolutePath() }, new String[] { mimeType }, null);
            }
            JSObject result = new JSObject();
            result.put("fileName", savedName);
            result.put("size", bytes.length);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("无法保存文件，请检查系统存储权限和剩余空间。", "DOWNLOAD_SAVE_FAILED");
        }
    }

    private String sanitizeFileName(String suppliedName) {
        String name = suppliedName.replaceAll("[/\\\\\\u0000-\\u001f\\u007f]", "_").trim();
        if (name.isEmpty() || ".".equals(name) || "..".equals(name)) return "bridge-file";
        return name.length() > 180 ? name.substring(0, 180) : name;
    }

    private String mimeTypeFor(String fileName) {
        String extension = MimeTypeMap.getFileExtensionFromUrl(fileName);
        String mimeType = extension == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
        return mimeType == null ? "application/octet-stream" : mimeType;
    }

    @PluginMethod
    public void install(PluginCall call) {
        String expectedAuthority = getContext().getPackageName() + ".fileprovider";
        Uri uri = resolveUpdateUri(call.getString("uri"), expectedAuthority);
        if (uri == null) {
            call.reject("无法识别更新包，请重新下载后重试。", "INVALID_UPDATE_URI");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName())
            );
            getActivity().startActivity(settings);
            call.reject("请允许 Bridge 安装未知来源应用后重试。", "INSTALL_PERMISSION_REQUIRED");
            return;
        }
        try {
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(uri, "application/vnd.android.package-archive");
            install.setClipData(ClipData.newRawUri("Bridge update", uri));
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(install);
            call.resolve();
        } catch (Exception error) {
            call.reject("无法打开 Android 安装器。", "INSTALLER_UNAVAILABLE");
        }
    }

    private Uri resolveUpdateUri(String rawUri, String expectedAuthority) {
        if (rawUri == null || rawUri.isEmpty()) return null;
        Uri supplied = Uri.parse(rawUri);
        if ("content".equals(supplied.getScheme())) {
            return expectedAuthority.equals(supplied.getAuthority()) ? supplied : null;
        }
        if (!"file".equals(supplied.getScheme()) || supplied.getPath() == null) return null;

        File downloaded = new File(supplied.getPath());
        File downloadRoot = new File(getContext().getCacheDir(), "bridge-downloads");
        try {
            File canonicalFile = downloaded.getCanonicalFile();
            String rootPath = downloadRoot.getCanonicalFile().getPath() + File.separator;
            if (!canonicalFile.isFile()
                || !canonicalFile.getName().toLowerCase(java.util.Locale.ROOT).endsWith(".apk")
                || !canonicalFile.getPath().startsWith(rootPath)) {
                return null;
            }
            return FileProvider.getUriForFile(getContext(), expectedAuthority, canonicalFile);
        } catch (IOException error) {
            return null;
        }
    }
}
