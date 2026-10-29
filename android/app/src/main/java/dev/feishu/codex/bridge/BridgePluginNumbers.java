package dev.feishu.codex.bridge;

import com.getcapacitor.PluginCall;

/** JSON bridge numbers may be Integer, Long, or Double; PluginCall.getLong only accepts Long. */
final class BridgePluginNumbers {
    private static final double MAX_SAFE_INTEGER = 9_007_199_254_740_991d;

    private BridgePluginNumbers() {}

    static Long positiveSafeLong(PluginCall call, String name) {
        return positiveSafeLong(call.getData().opt(name));
    }

    static Long positiveSafeLong(Object value) {
        if (!(value instanceof Number)) return null;
        double numeric = ((Number) value).doubleValue();
        if (Double.isNaN(numeric) || Double.isInfinite(numeric) || numeric <= 0
            || numeric > MAX_SAFE_INTEGER || numeric != Math.rint(numeric)) return null;
        return ((Number) value).longValue();
    }
}
