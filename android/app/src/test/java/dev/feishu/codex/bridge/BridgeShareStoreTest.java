package dev.feishu.codex.bridge;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

public class BridgeShareStoreTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private final String shareId = "00000000-0000-0000-0000-000000000001";
    private final String fileId = "00000000-0000-0000-0000-000000000002";

    private File create() throws Exception {
        File directory = temporary.newFolder(shareId);
        Files.write(new File(directory, fileId).toPath(), new byte[]{1, 2, 3});
        JSONObject file = new JSONObject().put("id", fileId).put("name", "截图.png").put("size", 3);
        BridgeShareStore.write(directory, new JSONObject().put("id", shareId).put("text", "手机分享").put("files", new JSONArray().put(file)));
        return directory;
    }

    @Test public void reloadsDurableRecordsAndFilesWithoutAProcessMemoryDependency() throws Exception {
        File directory = create();
        assertEquals("手机分享", BridgeShareStore.read(directory).getString("text"));
        assertEquals("截图.png", BridgeShareStore.read(directory).getJSONArray("files").getJSONObject(0).getString("name"));
        assertArrayEquals(new byte[]{1, 2, 3}, Files.readAllBytes(BridgeShareStore.file(temporary.getRoot(), shareId, fileId).toPath()));
    }

    @Test public void refusesUnregisteredFilesAndTraversal() throws Exception {
        create();
        String extra = "00000000-0000-0000-0000-000000000003";
        Files.write(new File(new File(temporary.getRoot(), shareId), extra).toPath(), new byte[]{4});
        assertThrows(IOException.class, () -> BridgeShareStore.file(temporary.getRoot(), "../secret", fileId));
        assertThrows(IOException.class, () -> BridgeShareStore.file(temporary.getRoot(), shareId, extra));
    }

    @Test public void refusesLinksEscapingTheShareDirectory() throws Exception {
        File directory = create();
        File file = new File(directory, fileId); Files.delete(file.toPath());
        File outside = temporary.newFile("private");
        Files.createSymbolicLink(file.toPath(), outside.toPath());
        assertThrows(IOException.class, () -> BridgeShareStore.file(temporary.getRoot(), shareId, fileId));
    }

    @Test public void copiesLargeInputsWithABoundedBufferAndExactBytes() throws Exception {
        byte[] bytes = new byte[9 * 1024 * 1024 + 3];
        for (int index = 0; index < bytes.length; index++) bytes[index] = (byte) (index % 251);
        ByteArrayInputStream input = new ByteArrayInputStream(bytes) {
            @Override public synchronized int read(byte[] buffer, int offset, int length) {
                assertTrue(length <= 65536); return super.read(buffer, offset, length);
            }
        };
        File destination = temporary.newFile("large");
        BridgeShareStore.copy(input, destination);
        assertArrayEquals(bytes, Files.readAllBytes(destination.toPath()));
    }
}
