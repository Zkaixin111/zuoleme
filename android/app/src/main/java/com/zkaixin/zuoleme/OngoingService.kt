package com.zkaixin.zuoleme

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * 常驻通知的前台服务：在通知栏一直显示「最近一件要做的事」。
 *
 * 为什么需要前台服务而不是普通通知：普通通知会被用户在通知栏随手划掉，
 * 而且不会跟着数据变化刷新；前台服务的通知带 `setOngoing(true)`，
 * 系统不允许划掉，语义上也正确地表达「应用正在后台保持一件事可见」。
 *
 * 三条硬约束（每一条都在真机上验证过才知道必须这么写）：
 *
 * 1. **必须有自己的通知渠道**（[CHANNEL_ID]，`IMPORTANCE_LOW`）：
 *    渠道的「重要级别」创建后不可修改，如果复用提醒渠道 `reminders_v3`（HIGH），
 *    这条常驻通知就会一直弹横幅 —— 用户看到的是「每秒弹一次的提醒」。
 *    LOW + 静音 + 不显示角标，才是「安静地挂在通知栏」。
 * 2. **`onStartCommand` 返回 `START_STICKY`**：被系统回收后自动重建，
 *    重建时拿到的是**空 Intent**，所以内容必须从 [ReminderStore.loadOngoing] 读回来。
 * 3. **`onDestroy` 里不调 `stopForeground`**：`START_STICKY` 的重启路径上，
 *    主动 `stopForeground` 会让通知先消失再重建（用户看到通知闪一下）；
 *    而显式停止（用户清空了待办 / 应用退出）走 [stop]，由系统在服务销毁时移除通知。
 *
 * 已知限制（不替用户打包票）：部分定制 ROM（realme / OPPO / vivo 等）有自己的
 * 「后台冻结」「智能省电」策略，可能在息屏后杀掉前台服务。此时常驻卡会消失，
 * 但**提醒不会丢** —— 提醒走的是 `AlarmManager.setExactAndAllowWhileIdle`，
 * 与这个服务无关。也就是说最坏情况是「常驻卡没了，提醒照旧」。
 */
class OngoingService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    /**
     * 启动 / 重建服务。
     *
     * 入口有三处：JS 传来的新内容（[ReminderAlarmPlugin.updateOngoing]）、
     * `START_STICKY` 的系统重启（Intent 为 null）、以及显式停止（[ACTION_STOP]）。
     */
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopForegroundCompat()
            stopSelf()
            return START_NOT_STICKY
        }

        // START_STICKY 重启时 Intent 为空：内容只能从磁盘里读回来
        val item = ReminderStore.loadOngoing(this)
        if (item == null) {
            Log.i(TAG, "没有要常驻显示的事，服务直接停止")
            stopSelf()
            return START_NOT_STICKY
        }

        val notification = buildNotification(item)
        try {
            startForegroundCompat(notification)
        } catch (error: Exception) {
            // Android 12+ 在后台启动前台服务会被拒绝；这里不能崩，下次回前台会重试
            Log.w(TAG, "启动前台服务失败，常驻通知暂不可用", error)
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    /**
     * 服务销毁。
     *
     * **刻意不调 `stopForeground`**：见类注释第 3 条。
     * 显式停止时系统会跟着移除通知；被系统杀掉时不会有这条路径。
     */
    override fun onDestroy() {
        Log.i(TAG, "常驻服务结束")
        super.onDestroy()
    }

    /** 按平台能力提交前台通知（Android 14 起必须显式声明 type） */
    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    /** 显式移除前台通知（只在用户主动收起时常驻卡时使用） */
    private fun stopForegroundCompat() {
        try {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        } catch (error: Exception) {
            Log.w(TAG, "移除前台通知失败", error)
        }
    }

    /**
     * 构造常驻通知。
     *
     * 内容**只有标题与剩余时间**：正文（待办详情）不进通知，与提醒通知保持一致。
     * 点通知 → 打开应用并定位到这条待办（复用 `pending_open_todo` 那套机制）。
     *
     * @param item 要显示的一件事
     */
    private fun buildNotification(item: OngoingItem): Notification {
        ensureChannel(this)

        val body = ReminderNotifier.remainingText(item.deadline - System.currentTimeMillis())
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(ReminderStore.EXTRA_TODO_ID, item.todoId)
        }
        val pendingIntentFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val contentIntent = PendingIntent.getActivity(this, NOTIFICATION_ID, openIntent, pendingIntentFlags)

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_reminder)
            .setContentTitle(item.title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            // 常驻 + 只在内容变化时提示一次，避免每秒刷新时反复打扰
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setContentIntent(contentIntent)
            .build()
    }

    companion object {

        private const val TAG = "OngoingService"

        /** 常驻通知的渠道 id（与提醒渠道 `reminders_v3` 完全不同） */
        const val CHANNEL_ID = "ongoing"

        /** 渠道名 */
        private const val CHANNEL_NAME = "最近一件事"

        /** 渠道描述 */
        private const val CHANNEL_DESCRIPTION = "在通知栏常驻显示最近一件要做的事"

        /**
         * 通知 id。
         *
         * 取一个不会和提醒 id 撞车的小常数：提醒 id 是 `hashAlarmKey` 出来的正整数，
         * 理论上可能等于任何值，但常驻通知 id 固定、且提醒通知用的是各自 id，
         * 万一撞上也只是那一条提醒覆盖常驻卡，不会丢提醒。
         */
        private const val NOTIFICATION_ID = 7011

        /** 显式停止服务的 action */
        private const val ACTION_STOP = "com.zkaixin.zuoleme.action.STOP_ONGOING"

        /**
         * 确保常驻通知渠道存在（幂等）。
         *
         * `IMPORTANCE_LOW`：不弹横幅、不出声，只挂在通知栏；
         * `setShowBadge(false)`：不污染桌面图标的小红点。
         *
         * @param context 任意 Context
         */
        fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                return
            }
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
            val channel = NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW).apply {
                description = CHANNEL_DESCRIPTION
                setSound(null, null)
                enableVibration(false)
                enableLights(false)
                setShowBadge(false)
                lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
            }
            manager.createNotificationChannel(channel)
        }

        /**
         * 启动或更新常驻通知。
         *
         * 只在**应用处于前台**时调用：Android 12+ 从后台启动前台服务会抛
         * `ForegroundServiceStartNotAllowedException`，调用方必须自己 try/catch。
         *
         * @param context 任意 Context
         */
        fun start(context: Context) {
            ensureChannel(context)
            val intent = Intent(context, OngoingService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /**
         * 停止常驻通知。
         *
         * 两步都要做，且**各自 try/catch**：
         * - `startService(ACTION_STOP)`：服务还活着时走显式 `stopForeground(STOP_FOREGROUND_REMOVE)`，
         *   通知立刻消失；但应用在后台时 Android 8+ 不允许后台启动服务，会抛异常；
         * - `stopService`：无论前面成功与否都把服务停掉（服务销毁时系统也会移除通知）。
         *
         * 如果把两步塞进同一个 try，第一步抛异常就会把第二步跳过去 —— 那才是「删完了
         * 待办，常驻卡却还在」的成因。
         *
         * @param context 任意 Context
         */
        fun stop(context: Context) {
            val intent = Intent(context, OngoingService::class.java)
            try {
                context.startService(Intent(intent).apply { action = ACTION_STOP })
            } catch (error: Exception) {
                Log.i(TAG, "常驻服务未在运行或不允许后台启动，直接 stopService", error)
            }
            try {
                context.stopService(intent)
            } catch (error: Exception) {
                Log.w(TAG, "停止常驻服务失败", error)
            }
        }
    }
}
