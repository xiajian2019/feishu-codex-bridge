package dev.feishu.codex.bridge;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.Test;

public class BridgeSshHostKeyGateTest {
    @Test
    public void waitsForExplicitApprovalAndOnlyAllowsOneDecision() throws Exception {
        BridgeSshHostKeyGate gate = new BridgeSshHostKeyGate("fingerprint");
        CountDownLatch waiting = new CountDownLatch(1);
        AtomicBoolean accepted = new AtomicBoolean();
        Thread verifier = new Thread(() -> {
            waiting.countDown();
            accepted.set(gate.await(2000L));
        });
        verifier.start();
        assertTrue(waiting.await(1, TimeUnit.SECONDS));
        assertFalse(gate.wasDecided());
        assertTrue(gate.approve(true));
        assertFalse(gate.approve(false));
        verifier.join(1000L);
        assertTrue(accepted.get());
    }

    @Test
    public void denialAndTimeoutFailClosed() throws Exception {
        BridgeSshHostKeyGate denied = new BridgeSshHostKeyGate("denied");
        assertTrue(denied.approve(false));
        assertFalse(denied.await(10L));

        BridgeSshHostKeyGate timedOut = new BridgeSshHostKeyGate("timeout");
        assertFalse(timedOut.await(1L));
        assertFalse(timedOut.wasDecided());
    }
}
