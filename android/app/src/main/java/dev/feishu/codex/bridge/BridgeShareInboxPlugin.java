package dev.feishu.codex.bridge;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Parcelable;
import android.provider.OpenableColumns;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/** Incoming shares are copied to private storage, never uploaded or executed automatically. */
@CapacitorPlugin(name = "BridgeShareInbox")
public class BridgeShareInboxPlugin extends Plugin {
    private final ExecutorService copies = Executors.newSingleThreadExecutor();
    @Override public void load() { capture(getActivity().getIntent()); }
    @Override protected void handleOnNewIntent(Intent intent) { capture(intent); }
    @Override protected void handleOnDestroy() { copies.shutdown(); }

    private File root() {
        File root = new File(getContext().getFilesDir(), "mobile-share-inbox");
        root.mkdirs();
        return root;
    }

    private void capture(Intent intent) {
        try { captureShare(intent); }
        catch (RuntimeException error) {
            JSObject event = new JSObject(); event.put("error", "分享参数不可读取，请回到来源重新分享。");
            notifyListeners("shareReceived", event, true);
        }
    }

    private void captureShare(Intent intent) {
        if (intent == null || intent.getBooleanExtra("bridgeShareCaptured", false)
            || !(Intent.ACTION_SEND.equals(intent.getAction()) || Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction()))) return;
        intent.putExtra("bridgeShareCaptured", true);
        // Read grant-bearing URIs before the activity intent can be replaced.
        ArrayList<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Parcelable> values = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (values != null) for (Parcelable value : values) if (value instanceof Uri) uris.add((Uri) value);
        } else {
            Parcelable value = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (value instanceof Uri) uris.add((Uri) value);
        }
        if (intent.getClipData() != null) for (int index = 0; index < intent.getClipData().getItemCount(); index++) {
            Uri uri = intent.getClipData().getItemAt(index).getUri();
            if (uri != null && !uris.contains(uri)) uris.add(uri);
        }
        CharSequence sharedText = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String text = sharedText == null ? "" : sharedText.toString();
        String title = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        String id = UUID.randomUUID().toString();
        JSObject beginning = new JSObject(); beginning.put("id", id); beginning.put("state", "copying");
        notifyListeners("shareReceived", beginning, true);
        copies.execute(() -> {
            File directory = new File(root(), id);
            directory.mkdirs();
            JSObject share = new JSObject();
            JSArray files = new JSArray();
            share.put("id", id); share.put("text", text); share.put("title", title == null ? "" : title);
            share.put("createdAt", System.currentTimeMillis()); share.put("files", files);
            List<String> errors = new ArrayList<>();
            for (Uri uri : uris) {
                File destination = null;
                try {
                    // Never let an exported share activity read arbitrary private file:// paths.
                    if (!"content".equals(uri.getScheme())) throw new IllegalArgumentException("仅接收系统授权的内容 URI");
                    String fileId = UUID.randomUUID().toString();
                    String name = "shared-file";
                    try (Cursor cursor = getContext().getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                        if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) name = cursor.getString(0);
                    }
                    destination = new File(directory, fileId);
                    try (InputStream input = getContext().getContentResolver().openInputStream(uri)) {
                        if (input == null) throw new IllegalStateException("无法读取分享文件");
                        BridgeShareStore.copy(input, destination);
                    }
                    JSObject file = new JSObject();
                    file.put("id", fileId); file.put("name", name); file.put("size", destination.length());
                    String type = getContext().getContentResolver().getType(uri);
                    file.put("type", type == null ? "application/octet-stream" : type); files.put(file);
                } catch (Exception error) {
                    if (destination != null) destination.delete(); // Only an incomplete private copy, never the source document.
                    errors.add("部分文件未能复制，请保留原文件并重新分享；检查授权和剩余空间。");
                }
            }
            if (!errors.isEmpty()) share.put("error", errors.get(0));
            else if (files.length() == 0 && text.isEmpty()) share.put("error", "分享中没有可读取的文字或文件，请回到来源重新分享。");
            try {
                write(directory, share);
                JSObject event = new JSObject(); event.put("id", id); event.put("state", "saved");
                getActivity().runOnUiThread(() -> {
                    intent.putExtra("bridgeShareDurable", true);
                    notifyListeners("shareReceived", event, true);
                });
            } catch (Exception error) {
                JSObject event = new JSObject(); event.put("id", id); event.put("state", "error"); event.put("error", "分享未能保存到本机，请检查空间并重新分享。");
                notifyListeners("shareReceived", event, true);
            }
        });
    }

    private void write(File directory, JSONObject share) throws Exception {
        BridgeShareStore.write(directory, share);
    }

    private JSONObject read(File directory) throws Exception {
        return BridgeShareStore.read(directory);
    }

    private File shareDirectory(String id) throws Exception {
        if (id == null || !id.matches("[a-f0-9-]{36}")) throw new IllegalArgumentException("invalid share id");
        File directory = new File(root(), id).getCanonicalFile();
        if (!directory.getPath().startsWith(root().getCanonicalPath() + File.separator)) throw new IllegalArgumentException("invalid share path");
        return directory;
    }

    @PluginMethod public void listShares(PluginCall call) {
        getBridge().execute(() -> {
            JSArray shares = new JSArray();
            File[] directories = root().listFiles();
            if (directories != null) for (File directory : directories) {
                try { if (directory.isDirectory()) shares.put(read(directory)); }
                catch (Exception error) { /* A still-copying item is published by shareReceived once durable. */ }
            }
            JSObject result = new JSObject(); result.put("shares", shares); call.resolve(result);
        });
    }

    @PluginMethod public void getFile(PluginCall call) {
        try {
            File file = BridgeShareStore.file(root(), call.getString("shareId"), call.getString("fileId"));
            JSObject result = new JSObject(); result.put("uri", Uri.fromFile(file).toString()); call.resolve(result);
        } catch (Exception error) { call.reject("分享文件已不可用，请重新分享原文件。", "SHARE_FILE_UNAVAILABLE"); }
    }
}
