package com.zkaixin.zuoleme

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * 通知构造与通知渠道管理。
 *
 * 产品要求：**要弹出来，但不许出声**。
 * - 只有 `IMPORTANCE_HIGH` 才能在屏幕上方弹出横幅（heads-up）；
 * - 但同时必须 `setSound(null, null)` + 关闭震动，所以听觉上是「静音提醒」。
 *
 * 关键坑：**渠道的声音/震动属性创建后不可修改**。只要用户装过一次旧版本，
 * 渠道 `reminders` 就永远带着声音；因此这里放弃旧 id，改用 `reminders_v3`
 * 并把旧渠道删除。
 */
object ReminderNotifier {

    private const val TAG = "ReminderNotifier"

    /** 当前渠道 id（换 id 的原因见类注释） */
    const val CHANNEL_ID = "reminders_v3"

    /** 历史渠道 id，必须在创建新渠道时一并删除 */
    private val LEGACY_CHANNEL_IDS = listOf("reminders")

    /** 渠道名（用户在系统设置里看到的名字） */
    private const val CHANNEL_NAME = "待办提醒"

    /** 渠道描述 */
    private const val CHANNEL_DESCRIPTION = "截止前的分档提醒"

    private const val MINUTE_MS = 60_000L
    private const val HOUR_MS = 3_600_000L
    private const val DAY_MS = 86_400_000L

    /**
     * 确保通知渠道存在（幂等）。
     *
     * @param context 任意 Context
     */
    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return

        val channel = NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH).apply {
            description = CHANNEL_DESCRIPTION
            // 静音：不出声、不震动、不亮灯，但仍然以横幅形式弹出
            setSound(null, null)
            enableVibration(false)
            vibrationPattern = null
            enableLights(false)
            setShowBadge(true)
            // 锁屏上完整显示标题与剩余时间
            lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
        }
        manager.createNotificationChannel(channel)

        // 旧渠道带着声音且无法修改，只能删掉（已存在的旧通知会随之消失，可以接受）
        for (legacyId in LEGACY_CHANNEL_IDS) {
            try {
                manager.deleteNotificationChannel(legacyId)
            } catch (error: Exception) {
                Log.w(TAG, "删除旧通知渠道失败：$legacyId", error)
            }
        }
    }

    /**
     * 把剩余毫秒说成人话，规则与前端 `shared/format.ts` 的 `formatRemaining` 完全一致。
     *
     * @param remainingMs 剩余毫秒（必须 > 0）
     */
    fun durationText(remainingMs: Long): String {
        val totalMinutes = remainingMs / MINUTE_MS
        if (totalMinutes < 1L) {
            return "不到1分钟"
        }
        val days = totalMinutes / (DAY_MS / MINUTE_MS)
        val minutesAfterDays = totalMinutes % (DAY_MS / MINUTE_MS)
        val hours = minutesAfterDays / (HOUR_MS / MINUTE_MS)
        val minutes = minutesAfterDays % (HOUR_MS / MINUTE_MS)
        return when {
            days > 0L && hours > 0L -> "${days}天${hours}小时"
            days > 0L -> "${days}天"
            hours > 0L && minutes > 0L -> "${hours}小时${minutes}分钟"
            hours > 0L -> "${hours}小时"
            else -> "${minutes}分钟"
        }
    }

    /**
     * 通知正文：在**触发时刻**根据真实剩余时间现算。
     *
     * 这样即使提醒因为关机被补发晚了 20 小时，文案也依然是准确的，
     * 不会出现「还有 3 小时截止」但实际已经逾期的情况。
     *
     * @param remainingMs 截止时间减当前时间
     */
    fun remainingText(remainingMs: Long): String {
        if (remainingMs > 0L) {
            return "还有${durationText(remainingMs)}截止"
        }
        val overdue = -remainingMs
        return if (overdue >= MINUTE_MS) {
            "已逾期${durationText(overdue)}"
        } else {
            "已到截止时间"
        }
    }

    /**
     * 发一条静音提醒通知。
     *
     * 通知里**只有标题和剩余时间**：待办的具体内容只在应用内的详情页显示，
     * 不进通知（锁屏可见的通知栏不适合放长正文）。
     *
     * @param context 任意 Context
     * @param alarmId 提醒 id（= 通知 id，不同实例不同档位互不覆盖）
     * @param todoId 来源待办 id，点通知后用它打开详情页
     * @param title 通知标题（= 待办标题）
     * @param body 通知正文（剩余时间文案）
     */
    fun notifyReminder(context: Context, alarmId: Int, todoId: String, title: String, body: String) {
        ensureChannel(context)

        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) {
            Log.w(TAG, "通知已被用户关闭，跳过本次提醒 id=$alarmId")
            return
        }

        val openAppIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(ReminderStore.EXTRA_ID, alarmId)
            putExtra(ReminderStore.EXTRA_TODO_ID, todoId)
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
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
            // 静音：不响铃、不震动（Android 8+ 由渠道保证，这里再兜一层旧系统）
            .setSilent(true)
            .setOnlyAlertOnce(false)
            .setContentIntent(contentIntent)

        try {
            manager.notify(alarmId, builder.build())
        } catch (error: SecurityException) {
            Log.e(TAG, "发通知被系统拒绝（缺少 POST_NOTIFICATIONS）id=$alarmId", error)
        }
    }
}
