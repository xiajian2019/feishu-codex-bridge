package dev.feishu.codex.bridge;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class BridgePluginNumbersTest {
    private PluginCall call(String json) throws Exception {
        return new PluginCall(null, "BridgeUpdater", "test", "verifyApk", new JSObject(json));
    }

    @Test
    public void readsSmallJsonNumbersThatCapacitorGetLongRejects() throws Exception {
        PluginCall call = call("{\"size\":5493340,\"versionCode\":87585966,\"id\":701}");
        assertTrue(call.getData().opt("size") instanceof Integer);
        // Reproduce the old failure with the actual Capacitor implementation, not a TS mock.
        assertNull(call.getLong("size"));
        assertNull(call.getLong("versionCode"));
        assertNull(call.getLong("id"));
        assertEquals(Long.valueOf(5493340), BridgePluginNumbers.positiveSafeLong(call, "size"));
        assertEquals(Long.valueOf(87585966), BridgePluginNumbers.positiveSafeLong(call, "versionCode"));
        assertEquals(Long.valueOf(701), BridgePluginNumbers.positiveSafeLong(call, "id"));
    }

    @Test
    public void preservesLongValuesWithoutIntOverflow() throws Exception {
        PluginCall call = call("{\"size\":4294967296,\"id\":9007199254740991}");
        assertTrue(call.getData().opt("size") instanceof Long);
        assertEquals(Long.valueOf(4294967296L), BridgePluginNumbers.positiveSafeLong(call, "size"));
        assertEquals(Long.valueOf(9007199254740991L), BridgePluginNumbers.positiveSafeLong(call, "id"));
    }

    @Test
    public void acceptsIntegralDoubleRepresentation() {
        assertEquals(Long.valueOf(5493340), BridgePluginNumbers.positiveSafeLong(Double.valueOf(5493340)));
    }

    @Test
    public void rejectsNonNumbersAndMissingFields() throws Exception {
        PluginCall call = call("{\"size\":\"5493340\",\"versionCode\":true,\"id\":null}");
        assertNull(BridgePluginNumbers.positiveSafeLong(call, "size"));
        assertNull(BridgePluginNumbers.positiveSafeLong(call, "versionCode"));
        assertNull(BridgePluginNumbers.positiveSafeLong(call, "id"));
        assertNull(BridgePluginNumbers.positiveSafeLong(call, "missing"));
        assertNull(BridgePluginNumbers.positiveSafeLong(JSONObject.NULL));
    }

    @Test
    public void rejectsFractionalNonPositiveNonFiniteAndUnsafeNumbers() {
        for (Number value : new Number[]{0, -1, 1.5, Double.NaN, Double.POSITIVE_INFINITY,
            Double.NEGATIVE_INFINITY, 9007199254740992L, Long.MAX_VALUE}) {
            assertNull("must reject " + value, BridgePluginNumbers.positiveSafeLong(value));
        }
    }
}
