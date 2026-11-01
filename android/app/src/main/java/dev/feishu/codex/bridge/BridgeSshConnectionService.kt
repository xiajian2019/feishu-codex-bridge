package dev.feishu.codex.bridge

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/** Keeps the app process hosting active SSH sessions important while their UI is away. */
internal class BridgeSshConnectionService : Service() {
    private var foregroundStarted = false

    override fun onCreate() {
        super.onCreate()
        try {
            val notifications = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notifications.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "SSH 连接", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "SSH 会话在后台保持连接时显示"
                },
            )
            val openApp = Intent(this, MainActivity::class.java).apply {
                action = Intent.ACTION_MAIN
                addCategory(Intent.CATEGORY_LAUNCHER)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            val contentIntent = PendingIntent.getActivity(
                this, 0, openApp, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val notification = NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_bridge)
                .setContentTitle("SSH 会话保持连接")
                .setContentText("连接活动期间保持运行；可在 SSH 工作区断开。")
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(contentIntent)
                .build()
            val serviceType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            } else 0
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, serviceType)
            foregroundStarted = true
            BridgeSshAppState.onBackgroundServiceStarted()
        } catch (error: Exception) {
            BridgeSshAppState.onBackgroundServiceFailed(error)
            stopSelf()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!foregroundStarted) stopSelf(startId)
        // A killed process cannot retain an SSH socket or recover credentials here.
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        BridgeSshAppState.onBackgroundServiceStopped()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "bridge-ssh-connections"
        private const val NOTIFICATION_ID = 731021
    }
}
