package dev.feishu.codex.bridge;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.Test;

public class BridgeSshOutputBatcherTest {
    @Test
    public void batchesInputWithoutLossDuplicationOrEmptyEvents() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        CountDownLatch delivered = new CountDownLatch(1);
        BridgeSshOutputBatcher batcher = new BridgeSshOutputBatcher("test-ssh-output", bytes -> {
            synchronized (output) {
                output.write(bytes, 0, bytes.length);
                delivered.countDown();
            }
        });
        byte[] first = new byte[]{0, 1, 2};
        byte[] second = new byte[]{127, (byte) 0xff, 4, 5};
        try {
            batcher.offer(first, 0, first.length);
            batcher.offer(second, 0, second.length);
            assertTrue(delivered.await(2, TimeUnit.SECONDS));
        } finally {
            batcher.close();
        }
        assertArrayEquals(new byte[]{0, 1, 2, 127, (byte) 0xff, 4, 5}, output.toByteArray());
        assertFalse(output.size() == 0);
    }
}
