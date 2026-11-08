package com.zkaixin.zuoleme

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.util.Log

/**
 * 闹钟到点时的接收器：发出通知。
 *
 * 由 `AlarmManager.setExactAndAllowWhileIdle` 触发，因此**不需要应用在运行**，
 * 甚至不需要屏幕点亮（RTC_WAKEUP 会把设备从 Doze 里唤醒）。
 *
 * 通知 id 用闹钟 id，所以同一件事的六档提醒是 6 条互不覆盖的通知。
 */
class AlarmReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val alarmId = intent.getIntExtra(ReminderStore.EXTRA_ID, 0)
        val title = intent.getStringExtra(ReminderStore.EXTRA_TITLE) ?: "做了么"
        val body = intent.getStringExtra(ReminderStore.EXTRA_BODY) ?: "已到截止时间"

        if (alarmId <= 0) {
            Log.w(TAG, "收到非法闹钟广播，忽略")
            return
        }

        // 部分机型在 Doze 唤醒后会给极短的处理窗口，短暂持锁确保通知能发出去
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
            ReminderNotifier.notifyReminder(context, alarmId, title, body)
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

        /** WakeLock 最长持有时长：10 秒足够发一条通知 */
        const val WAKE_LOCK_TIMEOUT_MS = 10_000L
    }
}
