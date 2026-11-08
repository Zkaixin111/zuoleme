package com.zkaixin.zuoleme

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.util.Log

/**
 * 提醒到点时的接收器：发一条静音通知。
 *
 * 由 `AlarmManager.setExactAndAllowWhileIdle` 触发，因此**不需要应用在运行**，
 * 也不需要屏幕点亮（RTC_WAKEUP 会把设备从 Doze 里唤醒）。
 *
 * 通知正文在这里现算：`deadline - 当前时间`。所以补发（晚触发）时文案依然准确，
 * 例如关机一夜后补发，会说「已逾期 9小时」而不是「还有 1小时截止」。
 */
class AlarmReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val alarmId = intent.getIntExtra(ReminderStore.EXTRA_ID, 0)
        val todoId = intent.getStringExtra(ReminderStore.EXTRA_TODO_ID) ?: ""
        val title = intent.getStringExtra(ReminderStore.EXTRA_TITLE) ?: DEFAULT_TITLE
        val deadline = intent.getLongExtra(ReminderStore.EXTRA_DEADLINE, 0L)

        if (alarmId <= 0) {
            Log.w(TAG, "收到非法提醒广播，忽略")
            return
        }

        // 部分机型在 Doze 唤醒后只给极短的处理窗口，短暂持锁确保通知能发出去
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        var wakeLock: PowerManager.WakeLock? = null
        try {
            wakeLock = powerManager?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "zuoleme:reminder")?.apply {
                setReferenceCounted(false)
                acquire(WAKE_LOCK_TIMEOUT_MS)
            }
        } catch (error: Exception) {
            Log.w(TAG, "获取 WakeLock 失败，继续尝试发通知", error)
        }

        try {
            val remaining = if (deadline > 0L) deadline - System.currentTimeMillis() else 0L
            // 旧格式（v1）救回来的记录没有 deadline（它是 0），正文是当时就算好的那句。
            // 绝不能拿 0 去算剩余时间 —— 那会得到「已逾期 56 年」这种荒谬文案。
            val legacyBody = if (deadline > 0L) null else ReminderStore.findLegacyBody(context, alarmId)
            val body = legacyBody ?: ReminderNotifier.remainingText(remaining)
            ReminderNotifier.notifyReminder(context, alarmId, todoId, title, body)
        } catch (error: Exception) {
            Log.e(TAG, "发送提醒通知失败 id=$alarmId", error)
        } finally {
            try {
                if (wakeLock?.isHeld == true) {
                    wakeLock.release()
                }
            } catch (error: Exception) {
                Log.w(TAG, "释放 WakeLock 失败", error)
            }
        }
    }

    private companion object {
        const val TAG = "AlarmReceiver"

        /** 标题兜底文案 */
        const val DEFAULT_TITLE = "做了么"

        /** WakeLock 最长持有时长：10 秒足够发一条通知 */
        const val WAKE_LOCK_TIMEOUT_MS = 10_000L
    }
}
