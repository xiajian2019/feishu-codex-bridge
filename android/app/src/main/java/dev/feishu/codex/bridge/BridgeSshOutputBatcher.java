package dev.feishu.codex.bridge;

import java.io.ByteArrayOutputStream;
import java.util.Arrays;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

/** Coalesces SSH PTY bytes so the Capacitor bridge is not called per byte. */
final class BridgeSshOutputBatcher implements AutoCloseable {
    static final int MAX_BATCH_BYTES = 16 * 1024;
    static final long FLUSH_INTERVAL_MILLIS = 20L;

    interface Listener {
        void onBatch(byte[] bytes);
    }

    // Keep a bounded queue so a fast remote stream cannot grow native memory
    // without limit while Capacitor/WebView event delivery is slower.
    private final BlockingQueue<byte[]> chunks = new ArrayBlockingQueue<>(256);
    private final Listener listener;
    private final Thread worker;
    private volatile boolean closed;

    BridgeSshOutputBatcher(String threadName, Listener listener) {
        this.listener = listener;
        this.worker = new Thread(this::run, threadName);
        this.worker.setDaemon(true);
        this.worker.start();
    }

    void offer(byte[] source, int offset, int length) {
        if (closed || source == null || length <= 0) return;
        if (offset < 0 || length > source.length - offset) throw new IndexOutOfBoundsException();
        byte[] copy = Arrays.copyOfRange(source, offset, offset + length);
        while (!closed) {
            try {
                if (chunks.offer(copy, FLUSH_INTERVAL_MILLIS, TimeUnit.MILLISECONDS)) return;
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    private void run() {
        ByteArrayOutputStream batch = new ByteArrayOutputStream(MAX_BATCH_BYTES);
        while (!closed || !chunks.isEmpty()) {
            byte[] first;
            try {
                first = chunks.poll(FLUSH_INTERVAL_MILLIS, TimeUnit.MILLISECONDS);
            } catch (InterruptedException error) {
                if (closed) break;
                Thread.currentThread().interrupt();
                break;
            }
            if (first == null) {
                emit(batch);
                continue;
            }
            appendAndEmit(batch, first);
            long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(FLUSH_INTERVAL_MILLIS);
            while (batch.size() < MAX_BATCH_BYTES) {
                long remaining = deadline - System.nanoTime();
                if (remaining <= 0) break;
                byte[] next;
                try {
                    next = chunks.poll(remaining, TimeUnit.NANOSECONDS);
                } catch (InterruptedException error) {
                    if (closed) break;
                    Thread.currentThread().interrupt();
                    break;
                }
                if (next == null) break;
                appendAndEmit(batch, next);
            }
            emit(batch);
        }
        emit(batch);
    }

    private void appendAndEmit(ByteArrayOutputStream batch, byte[] bytes) {
        int offset = 0;
        while (offset < bytes.length) {
            int remaining = MAX_BATCH_BYTES - batch.size();
            int count = Math.min(remaining, bytes.length - offset);
            batch.write(bytes, offset, count);
            offset += count;
            if (batch.size() == MAX_BATCH_BYTES) emit(batch);
        }
    }

    private void emit(ByteArrayOutputStream batch) {
        if (batch.size() == 0) return;
        byte[] bytes = batch.toByteArray();
        batch.reset();
        try {
            listener.onBatch(bytes);
        } catch (RuntimeException ignored) {
            // Event delivery must not kill the SSH reader or leak terminal data to logs.
        }
    }

    @Override
    public void close() {
        if (closed) return;
        closed = true;
        worker.interrupt();
        if (Thread.currentThread() != worker) {
            try {
                worker.join(500L);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            }
        }
    }
}
