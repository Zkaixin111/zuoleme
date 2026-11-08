package com.zkaixin.zuoleme

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * 开机 / 应用更新后重建所有闹钟。
 *
 * 这是「手机关机重启后提醒照常响」的**唯一保证**：
 * `AlarmManager` 里的闹钟在重启后全部丢失，只有把列表持久化并在这里重排，提醒才不会断。
 *
 * 监听的广播：
 * - `BOOT_COMPLETED`：正常开机完成（最常见）；
 * - `LOCKED_BOOT_COMPLETED`：直接启动模式下解锁前（部分设备；此时加密存储不可读，读失败就跳过，
 *    随后的 BOOT_COMPLETED 会补上）；
 * - `QUICKBOOT_POWERON` / `com.htc.intent.action.QUICKBOOT_POWERON`：部分国产 ROM 的快速开机；
 * - `MY_PACKAGE_REPLACED`：应用升级安装后，闹钟同样会被清空，需要重排。
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (!HANDLED_ACTIONS.contains(action)) {
            Log.w(TAG, "未处理的广播：$action")
            return
        }

        // 广播接收器的 10 秒窗口足够完成几十条闹钟的排程，但仍用 goAsync 明确生命周期
        val pendingResult = goAsync()
        try {
            ReminderNotifier.ensureChannel(context)
            val alarms = ReminderStore.load(context)
            if (alarms.isEmpty()) {
                Log.i(TAG, "$action：没有需要重建的闹钟")
                return
            }
            Log.i(TAG, "$action：准备重建 ${alarms.size} 条闹钟")
            ReminderStore.scheduleAll(context, alarms)
        } catch (error: Throwable) {
            // 开机广播里绝不能崩：崩溃会被系统静默记录，用户只会觉得「提醒莫名失效」
            Log.e(TAG, "$action：重建闹钟失败", error)
        } finally {
            pendingResult.finish()
        }
    }

    private companion object {
        const val TAG = "BootReceiver"

        /** 需要重建闹钟的广播 action 集合 */
        val HANDLED_ACTIONS = setOf(
            Intent.ACTION_BOOT_COMPLETED,
            "android.intent.action.LOCKED_BOOT_COMPLETED",
            "android.intent.action.QUICKBOOT_POWERON",
            "com.htc.intent.action.QUICKBOOT_POWERON",
            Intent.ACTION_MY_PACKAGE_REPLACED
        )

        /** 便于日志/调试时判断当前 API（保留引用，避免被优化掉） */
        val supported: Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
    }
}
