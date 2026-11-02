package dev.feishu.codex.bridge;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Blocks SSHJ's host-key verifier until the WebView explicitly decides. */
final class BridgeSshHostKeyGate {
    private final String fingerprint;
    private final CountDownLatch decision = new CountDownLatch(1);
    private final AtomicBoolean decided = new AtomicBoolean(false);
    private volatile boolean accepted;

    BridgeSshHostKeyGate(String fingerprint) {
        this.fingerprint = fingerprint;
    }

    String fingerprint() {
        return fingerprint;
    }

    boolean approve(boolean accept) {
        if (!decided.compareAndSet(false, true)) return false;
        accepted = accept;
        decision.countDown();
        return true;
    }

    boolean await(long timeoutMillis) {
        try {
            return decision.await(timeoutMillis, TimeUnit.MILLISECONDS) && accepted;
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    boolean wasDecided() {
        return decided.get();
    }
}
