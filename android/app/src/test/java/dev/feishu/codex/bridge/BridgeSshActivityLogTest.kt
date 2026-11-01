package dev.feishu.codex.bridge

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeSshActivityLogTest {
    private class MemoryStore : BridgeSshActivityLogStorage {
        var saved: String? = null
        override fun load(): String? = saved
        override fun save(value: String) { saved = value }
    }

    @Test
    fun recordingSurvivesRecreationAndStopsWithoutLosingEvents() {
        val store = MemoryStore()
        val first = BridgeSshActivityLog(store, wallClock = { 123L }, monotonicClock = { 42L }, capacity = 4)
        first.start()
        first.record(BridgeSshTraceEvent.ACTIVITY_PAUSED)
        val restored = BridgeSshActivityLog(store, wallClock = { 456L }, monotonicClock = { 99L }, capacity = 4)
        assertTrue(restored.recording)
        restored.record(BridgeSshTraceEvent.PROCESS_STARTED, BridgeSshTraceField.DETAIL to BridgeSshTraceDetail.RESTORED)
        restored.record(BridgeSshTraceEvent.SESSION_FAILED, BridgeSshTraceField.SESSION to 7)
        restored.stop()
        val stopped = BridgeSshActivityLog(store, capacity = 4)
        assertFalse(stopped.recording)
        assertTrue(stopped.hasCapture)
        val events = stopped.snapshot().getJSONArray("events")
        assertEquals(4, events.length())
        assertEquals("activity.paused", events.getJSONObject(0).getString("event"))
        assertEquals("capture.stopped", events.getJSONObject(3).getString("event"))
        stopped.record(BridgeSshTraceEvent.ACTIVITY_RESUMED)
        assertEquals(4, stopped.snapshot().getJSONArray("events").length())
    }

    @Test
    fun eventFieldsCannotLeakExceptionMessagesOrArbitraryStrings() {
        val store = MemoryStore()
        val log = BridgeSshActivityLog(store)
        log.start()
        log.record(BridgeSshTraceEvent.TRANSPORT_DISCONNECTED,
            BridgeSshTraceField.ERROR to IllegalStateException("password=secret host=private", java.io.EOFException("terminal secret")),
            BridgeSshTraceField.DETAIL to "untrusted secret", BridgeSshTraceField.SESSION to 3)
        val report = log.snapshot().toString()
        assertFalse(report.contains("secret"))
        assertFalse(report.contains("private"))
        val row = JSONObject(report).getJSONArray("events").getJSONObject(1)
        assertEquals("IllegalStateException", row.getJSONArray("error").getString(0))
        assertEquals("EOFException", row.getJSONArray("error").getString(1))
        assertEquals(3, row.getInt("session"))
        assertFalse(row.has("detail"))
        log.record(BridgeSshTraceEvent.TERMINAL_READ_FAILED,
            BridgeSshTraceField.ERROR to java.net.SocketException("Connection reset by peer; token=never-copy"))
        val reset = log.snapshot().getJSONArray("events").getJSONObject(2)
        assertEquals("connection_reset", reset.getString("error_reason"))
        assertFalse(reset.toString().contains("never-copy"))
    }
}
