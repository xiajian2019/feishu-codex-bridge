package dev.feishu.codex.bridge;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

public class BridgeTransferFilesTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void acceptsOnlyExistingFilesInsideTransferCache() throws Exception {
        File cache = temporary.getRoot();
        File transfer = temporary.newFolder("bridge-downloads");
        File file = new File(transfer, "clipboard.png");
        Files.write(file.toPath(), new byte[]{1, 2, 3});
        assertEquals(file.getCanonicalFile(), BridgeTransferFiles.requireTransferFile(cache, file.getPath()));
        assertThrows(IOException.class, () -> BridgeTransferFiles.requireTransferFile(cache, transfer.getPath()));
        assertThrows(IOException.class, () -> BridgeTransferFiles.requireTransferFile(cache, new File(transfer, "missing").getPath()));
    }

    @Test
    public void rejectsTraversalAndSimilarPrefixOutsideTheCache() throws Exception {
        File cache = temporary.getRoot();
        File transfer = temporary.newFolder("bridge-downloads");
        File secret = temporary.newFile("secret");
        File sibling = temporary.newFolder("bridge-downloads-other");
        File siblingFile = new File(sibling, "image.png"); Files.write(siblingFile.toPath(), new byte[]{1});
        assertThrows(IOException.class, () -> BridgeTransferFiles.requireTransferFile(cache, new File(transfer, "../secret").getPath()));
        assertThrows(IOException.class, () -> BridgeTransferFiles.requireTransferFile(cache, siblingFile.getPath()));
    }

    @Test
    public void rejectsSymlinksEscapingTheCache() throws Exception {
        File cache = temporary.getRoot();
        File transfer = temporary.newFolder("bridge-downloads");
        File secret = temporary.newFile("secret");
        File link = new File(transfer, "image.png");
        Files.createSymbolicLink(link.toPath(), secret.toPath());
        assertThrows(IOException.class, () -> BridgeTransferFiles.requireTransferFile(cache, link.getPath()));
    }
}
