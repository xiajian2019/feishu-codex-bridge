package dev.feishu.codex.bridge

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import androidx.lifecycle.Lifecycle
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/** Deliver foreground accelerometer samples even when the SSH view covers the WebView. */
@CapacitorPlugin(name = "BridgeMotion")
class BridgeMotionPlugin : Plugin(), SensorEventListener {
    private var enabled = false
    private var resumed = false
    private var listening = false
    private var lastSampleNanos = 0L
    private val manager: SensorManager by lazy { context.getSystemService(Context.SENSOR_SERVICE) as SensorManager }
    private val accelerometer: Sensor? by lazy { manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) }

    @PluginMethod
    fun setEnabled(call: PluginCall) {
        val requested = call.getBoolean("enabled", false) ?: false
        activity.runOnUiThread {
            enabled = requested
            resumed = activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
            updateListening()
            call.resolve(JSObject().put("available", accelerometer != null && (!requested || !resumed || listening)))
        }
    }

    private fun updateListening() {
        val sensor = accelerometer
        if (enabled && resumed && sensor != null && !listening) {
            lastSampleNanos = 0L
            listening = manager.registerListener(this, sensor, SensorManager.SENSOR_DELAY_GAME)
        } else if ((!enabled || !resumed || sensor == null) && listening) {
            manager.unregisterListener(this)
            listening = false
            lastSampleNanos = 0L
        }
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (!enabled || !resumed || event.sensor.type != Sensor.TYPE_ACCELEROMETER || event.values.size < 3) return
        if (lastSampleNanos != 0L && event.timestamp - lastSampleNanos < 30_000_000L) return
        lastSampleNanos = event.timestamp
        notifyListeners("motion", JSObject().apply {
            put("x", event.values[0].toDouble())
            put("y", event.values[1].toDouble())
            put("z", event.values[2].toDouble())
            put("timestampMs", event.timestamp / 1_000_000.0)
        })
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    override fun handleOnResume() {
        resumed = true
        updateListening()
    }

    override fun handleOnPause() {
        resumed = false
        updateListening()
    }

    override fun handleOnDestroy() {
        enabled = false
        updateListening()
    }
}
