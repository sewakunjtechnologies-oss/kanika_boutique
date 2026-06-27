package com.kanikadesigns.printbridge.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.kanikadesigns.printbridge.MainActivity
import com.kanikadesigns.printbridge.R

object NotificationHelper {
    const val CHANNEL_ID = "kanika_print_bridge"
    const val SERVICE_NOTIFICATION_ID = 1001
    private const val BOOT_NOTIFICATION_ID = 1002

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = context.getString(R.string.notification_channel_description)
            setShowBadge(false)
        }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    fun serviceNotification(context: Context, title: String, detail: String): Notification {
        val openIntent = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(title)
            .setContentText(detail.lines().firstOrNull().orEmpty())
            .setStyle(NotificationCompat.BigTextStyle().bigText(detail))
            .setContentIntent(openIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    fun showBootPrompt(context: Context) {
        val notification = serviceNotification(
            context,
            "Kanika Print Bridge",
            "Open the app and start the bridge if Android did not allow automatic restart.",
        )
        runCatching {
            NotificationManagerCompat.from(context).notify(BOOT_NOTIFICATION_ID, notification)
        }
    }
}
