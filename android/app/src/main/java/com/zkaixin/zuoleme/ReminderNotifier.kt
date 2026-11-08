package com.zkaixin.zuoleme

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * 通知构造与通知渠道管理。
 *
 * Android 8（API 26）起，没有 NotificationChannel 的通知会被系统**直接丢弃**，
 * 所以渠道必须在应用启动时（`MainActivity.onCreate`）和发通知前都确保存在。
 */
object ReminderNotifier {

    private const val TAG = "ReminderNotifier"

    /** 提醒专用渠道 id（前端不需要知道，写死在这里即可） */
    const val CHANNEL_ID = "reminders"

    /** 渠道名（用户在系统设置里看到的名字） */
    private const val CHANNEL_NAME = "待办提醒"

    /** 渠道描述 */
    private const val CHANNEL_DESCRIPTION = "截止前的六档提醒：7 天 / 3 天 / 1 天 / 3 小时 / 1 小时 / 到点"

    /**
     * 确保通知渠道存在（幂等，重复调用无副作用）。
     *
     * @param context 任意 Context
     */
    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) {
            return
        }
        val soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val audioAttributes = AudioAttributes.Builder()
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .build()

        val channel = NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH).apply {
            description = CHANNEL_DESCRIPTION
            enableVibration(true)
            vibrationPattern = longArrayOf(0L, 400L, 200L, 400L)
            enableLights(true)
            setShowBadge(true)
            setSound(soundUri, audioAttributes)
            // 锁屏上也完整显示标题与正文，不隐藏内容
            lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
        }
        manager.createNotificationChannel(channel)
    }

    /**
     * 发一条提醒通知。
     *
     * 通知 id 直接用闹钟 id：不同事项、不同档位的 id 一定不同（前端保证），
     * 所以六档提醒会各自独立堆叠，不会互相覆盖。
     *
     * @param context 任意 Context
     * @param alarmId 闹钟 id（= 通知 id）
     * @param title 通知标题（= 待办标题）
     * @param body 通知正文（「还有 1 小时截止」这类）
     */
    fun notifyReminder(context: Context, alarmId: Int, title: String, body: String) {
        ensureChannel(context)

        val manager = NotificationManagerCompat.from(context)
        // 用户关掉通知权限时不要抛异常刷日志，直接放弃（界面「运行检查」会提示去授权）
        if (!manager.areNotificationsEnabled()) {
            Log.w(TAG, "通知已被用户关闭，跳过本次提醒 id=$alarmId")
            return
        }

        val openAppIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(ReminderStore.EXTRA_ID, alarmId)
        }
        val contentIntentFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val contentIntent = PendingIntent.getActivity(context, alarmId, openAppIntent, contentIntentFlags)

        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_reminder)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
            .setContentIntent(contentIntent)

        // Android 8 以下没有渠道，声音/震动必须在构造器上单独声明
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setDefaults(NotificationCompat.DEFAULT_ALL)
            builder.setVibrate(longArrayOf(0L, 400L, 200L, 400L))
        }

        try {
            manager.notify(alarmId, builder.build())
        } catch (error: SecurityException) {
            Log.e(TAG, "发通知被系统拒绝（缺少 POST_NOTIFICATIONS）id=$alarmId", error)
        }
    }
}
