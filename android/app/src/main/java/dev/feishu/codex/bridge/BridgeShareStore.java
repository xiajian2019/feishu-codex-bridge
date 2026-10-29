package dev.feishu.codex.bridge;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/** Durable private share records; these methods never resolve a caller-supplied absolute path. */
final class BridgeShareStore {
    private BridgeShareStore() {}

    static void copy(InputStream input, File destination) throws IOException {
        try (FileOutputStream output = new FileOutputStream(destination)) {
            byte[] buffer = new byte[65536]; int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            output.getFD().sync();
        }
    }

    static void write(File directory, JSONObject record) throws Exception {
        File temporary = new File(directory, "record.tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(record.toString().getBytes(StandardCharsets.UTF_8)); output.getFD().sync();
        }
        if (!temporary.renameTo(new File(directory, "record.json"))) throw new IOException("cannot persist share");
    }

    static JSONObject read(File directory) throws Exception {
        try (FileInputStream input = new FileInputStream(new File(directory, "record.json"))) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            return new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
        }
    }

    static File file(File root, String shareId, String fileId) throws Exception {
        if (shareId == null || fileId == null || !shareId.matches("[a-f0-9-]{36}") || !fileId.matches("[a-f0-9-]{36}")) throw new IOException("invalid id");
        File directory = new File(root, shareId).getCanonicalFile();
        File file = new File(directory, fileId).getCanonicalFile();
        if (!directory.getPath().startsWith(root.getCanonicalPath() + File.separator)
            || !file.getPath().startsWith(directory.getCanonicalPath() + File.separator) || !file.isFile()) throw new IOException("outside share inbox");
        JSONArray files = read(directory).getJSONArray("files");
        for (int index = 0; index < files.length(); index++) if (fileId.equals(files.getJSONObject(index).getString("id"))) return file;
        throw new IOException("file not registered in share");
    }
}
