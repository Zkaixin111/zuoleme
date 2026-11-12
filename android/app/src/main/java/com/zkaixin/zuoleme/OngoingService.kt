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
import java.util.Calendar
import java.util.Locale

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
            // Android 12+ 在后台启动前台服务会被拒绝；这里不能崩，下次回前台会重试。
            // **注意：这里吞掉异常 + stopSelf 是刻意的**，不要改成「重试几次」或「起闹钟再拉」：
            // 后台启动被拒意味着本进程此刻没有资格做前台服务，硬留着一个半死不活的服务
            // 只会占着进程位不干活；[ensureAlive]（提醒触发 / 开机时机）和前台 [start]
            // 都会再给它一次机会。
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
     *
     * **也刻意不在这里「重启自己」**：`onDestroy` 不保证被调用（进程被直接杀掉时根本没有这条路径），
     * 而 `START_STICKY` 的系统重建与「onDestroy 里再 start 一次」会互相打架
     * （两次 `startForeground` 抢同一个通知位，用户看到通知闪烁）。
     * 「服务死了之后怎么活回来」这件事归 [ensureAlive] 管。
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
     * **倒计时由系统计时器走秒**（`setUsesChronometer` + `setWhen`）：
     * 这是「不额外唤醒、又不会显示一个停住的数字」的唯一做法 ——
     * 自己起个每分钟的定时器就成了第二个 wake 源，代价远高于收益。
     *
     * 三种形态：
     * 1. 未到期（API ≥ 24）：`setChronometerCountDown(true)` → 系统每秒往回数；
     *    正文放**绝对时间**（「今天 18:00」），相对量由计时器负责，避免两句话打架；
     * 2. 已逾期（API ≥ 24）：`setChronometerCountDown(false)` → 变成正计时，
     *    显示「已逾期多久」，同样自己走；
     * 3. API 23：没有 `setChronometerCountDown`，降级为静态文案
     *    （`ReminderNotifier.remainingText`）。targetSdk 35、minSdk 23，
     *    只有 Android 6.0 会走到这条路径。
     *
     * 内容**只有标题与时间**：正文（待办详情）不进通知，与提醒通知保持一致。
     * 点通知 → 打开应用并定位到这条待办（复用 `pending_open_todo` 那套机制）。
     *
     * @param item 要显示的一件事
     */
    private fun buildNotification(item: OngoingItem): Notification {
        ensureChannel(this)

        val now = System.currentTimeMillis()
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

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_reminder)
            .setContentTitle(item.title)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            // 常驻 + 只在内容变化时提示一次，避免刷新时反复打扰
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(contentIntent)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            builder.setWhen(item.deadline)
            builder.setUsesChronometer(true)
            if (item.deadline > now) {
                builder.setChronometerCountDown(true)
                builder.setContentText(deadlineText(item.deadline, now))
            } else {
                builder.setChronometerCountDown(false)
                builder.setContentText("已逾期")
            }
        } else {
            // API 23 降级路径：静态文案，不随秒变化（这个版本上没有更好的办法）
            builder.setShowWhen(false)
            builder.setContentText(ReminderNotifier.remainingText(item.deadline - now))
        }

        return builder.build()
    }

    /**
     * 把截止时刻说成人话：`今天 18:00` / `明天 09:00` / `昨天 10:00` /
     * `11月12日 09:00` / `2027年1月3日 09:00`。
     *
     * **规则与 `shared/format.ts` 的 `formatDeadline` 完全一致，改动必须两边一起改**
     * （`tests/ongoing-deadline-text.test.ts` 用 JS 镜像逐条对账）。
     * 之所以不第三套逻辑：常驻通知只需要「今天/明天/昨天 + HH:mm」这几种形态，
     * 比 `remainingText` 简单得多，单写一个函数比引一整套本地化框架划算。
     *
     * @param deadline 截止时刻（epoch 毫秒）
     * @param now 当前时刻（epoch 毫秒），用于判断「今天/明天/昨天」与跨年
     */
    fun deadlineText(deadline: Long, now: Long): String {
        val target = Calendar.getInstance().apply { timeInMillis = deadline }
        val current = Calendar.getInstance().apply { timeInMillis = now }
        val clock = String.format(
            Locale.US,
            "%02d:%02d",
            target.get(Calendar.HOUR_OF_DAY),
            target.get(Calendar.MINUTE)
        )
        // 用「当天 0 点」相减再取整，和 JS 侧 `Math.round((startOfTarget - startOfToday) / DAY_MS)` 一致
        val dayDiff = Math.round(
            (startOfDay(target) - startOfDay(current)).toDouble() / DAY_MS.toDouble()
        )
        return when {
            dayDiff == 0L -> "今天 $clock"
            dayDiff == 1L -> "明天 $clock"
            dayDiff == -1L -> "昨天 $clock"
            target.get(Calendar.YEAR) == current.get(Calendar.YEAR) ->
                "${target.get(Calendar.MONTH) + 1}月${target.get(Calendar.DAY_OF_MONTH)}日 $clock"
            else ->
                "${target.get(Calendar.YEAR)}年${target.get(Calendar.MONTH) + 1}月" +
                    "${target.get(Calendar.DAY_OF_MONTH)}日 $clock"
        }
    }

    /**
     * 取某个时刻「当天 0 点」的毫秒值。
     *
     * @param calendar 目标时刻（不会被修改，内部先 clone）
     */
    private fun startOfDay(calendar: Calendar): Long {
        val copy = calendar.clone() as Calendar
        copy.set(Calendar.HOUR_OF_DAY, 0)
        copy.set(Calendar.MINUTE, 0)
        copy.set(Calendar.SECOND, 0)
        copy.set(Calendar.MILLISECOND, 0)
        return copy.timeInMillis
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
         * **这个值必须与 `src/lib/alarms.ts` 的 `RESERVED_ALARM_IDS` 保持一致**：
         * 提醒的 id 同时是通知 id 与 PendingIntent requestCode，一旦撞上，
         * 那条提醒会把常驻卡顶掉（用户以为「常驻功能坏了」）。
         * JS 侧已经在 `allocateId` 里跳过这个 id，两边改动要一起做。
         */
        private const val NOTIFICATION_ID = 7011

        /** 一天的毫秒数（与 JS 侧 `DAY_MS` 一致，用于「今天/明天/昨天」的判定） */
        private const val DAY_MS = 86_400_000L

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

        /**
         * **该有常驻卡的时候，确保它真的在显示。**
         *
         * 为什么需要这个方法 —— 三个缺口，都不是猜测：
         * 1. [BootReceiver] 原来只重建闹钟：`ongoing_item` 明明还在磁盘上，却没人调 [start]，
         *    所以**关机重启后、以及每次覆盖安装（`MY_PACKAGE_REPLACED`）后，常驻卡都会消失**，
         *    直到用户手动打开应用；
         * 2. 提醒的 exact alarm 触发是现成的自愈时机，却从没被用上（见下面的豁免依据）；
         * 3. Android 14 起用户可以划掉前台服务的通知：服务可能还活着，通知没了。
         *
         * 为什么只在「提醒触发后 / 开机重建后」调用是**合法**的：
         * Android 12+ 在应用处于后台时启动前台服务会抛 `ForegroundServiceStartNotAllowedException`，
         * 但系统文档把两类时刻明确列为豁免 —— 由 `AlarmManager.setExactAndAllowWhileIdle`
         * 触发的广播（本应用的 [AlarmReceiver] 正是），以及 `BOOT_COMPLETED` /
         * `MY_PACKAGE_REPLACED` 这类系统广播（[BootReceiver]）。所以本方法只被这两个
         * 接收器调用；应用内的其余场合一律走前台的 [start]，不要把 [ensureAlive]
         * 挪到别的后台路径上去。
         *
         * 为什么**不**做「每 N 分钟一次的看护闹钟」：那是拿持续的电池唤醒去换一个纯视觉
         * 元素 —— 开机（缺口 1）和每一次提醒（缺口 2）已经免费覆盖了绝大多数丢失场景；
         * 真被国产 ROM 杀掉、又还没等到下一次提醒的间隙，就让它先缺着，用户回到前台
         * 会立刻补上（[start] 路径）。**不要以后「顺手」加看护闹钟。**
         *
         * 三步，每一步都刻意吞异常（调用方是广播接收器，这里崩了会连累提醒）：
         * 1. [ReminderStore.loadOngoing] 为 null → 直接返回（**不许凭空拉起服务**，
         *    否则会凭空出现一条空白常驻卡）；
         * 2. `getActiveNotifications()` 里能找到 [NOTIFICATION_ID] → 通知还挂着，返回；
         * 3. 否则 [start]：服务已死就走正常启动；服务活着只是通知被划掉，
         *    `startForegroundService` 会再投递一次 `onStartCommand` 并重新 `startForeground`，
         *    正好把通知补回来。
         *
         * `getActiveNotifications()` 只返回**本应用**的通知，不需要权限；它是 API 23 加入的，
         * 本工程 minSdk 恰好是 23，可以直接用。个别 ROM 在这条路径上抛
         * `SecurityException` / `DeadObjectException`，整个方法体都在 try/catch 里 ——
         * `LOCKED_BOOT_COMPLETED`（直启模式、加密存储不可读）导致的读盘异常也在其内，
         * 随后的 `BOOT_COMPLETED` 会补上。
         *
         * @param context 任意 Context
         */
        fun ensureAlive(context: Context) {
            try {
                // 1. 没有要显示的事，绝不拉起服务
                if (ReminderStore.loadOngoing(context) == null) {
                    return
                }
                // 2. 通知还挂在通知栏就什么都不做
                val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                if (manager == null) {
                    return
                }
                val alive = manager.activeNotifications.any { it.id == NOTIFICATION_ID }
                if (alive) {
                    return
                }
                // 3. 该有却没有：拉起来
                Log.i(TAG, "常驻通知不在了，磁盘上仍有要显示的事，重新拉起")
                start(context)
            } catch (error: Exception) {
                // 只记日志，绝不抛给调用方（BootReceiver / AlarmReceiver 崩了会连累提醒）
                Log.w(TAG, "确认/重建常驻通知失败", error)
            }
        }
    }
}
