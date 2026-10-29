package dev.feishu.codex.bridge;

import java.io.File;
import java.io.IOException;

final class BridgeTransferFiles {
    private BridgeTransferFiles() {}

    static File requireTransferFile(File cacheDirectory, String path) throws IOException {
        File source = new File(path).getCanonicalFile();
        String root = new File(cacheDirectory, "bridge-downloads").getCanonicalPath() + File.separator;
        if (!source.isFile() || !source.getPath().startsWith(root)) throw new IOException("file outside transfer cache");
        return source;
    }
}
