package com.zuoleme.app.reminder

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import com.zuoleme.app.data.TodoEntity
import com.zuoleme.app.domain.ReminderKind
import com.zuoleme.app.domain.ReminderPlan

/**
 * 本地闹钟调度：每档提醒一个独立 PendingIntent。
 * 有精确闹钟权限时用 setExactAndAllowWhileIdle（Doze 下也能准时），
 * 没有时自动降级为 setAndAllowWhileIdle 并打日志，不静默失败。
 */
class AlarmScheduler(private val context: Context) {
    private val alarmManager = context.getSystemService(AlarmManager::class.java)

    private fun pendingIntent(todoId: String, kind: ReminderKind): PendingIntent {
        val intent = Intent(context, ReminderReceiver::class.java).apply {
            action = ReminderReceiver.ACTION_FIRE
            putExtra(ReminderReceiver.EXTRA_TODO_ID, todoId)
            putExtra(ReminderReceiver.EXTRA_KIND, kind.storageKey)
        }
        return PendingIntent.getBroadcast(
            context,
            ("alarm:$todoId:${kind.storageKey}").hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /** 按六档规则重排该待办全部提醒（先取消旧的，已过去的档位不生成） */
    fun scheduleAll(todo: TodoEntity) {
        cancelAll(todo.id)
        if (todo.done) return
        val manager = alarmManager ?: run {
            Log.e(TAG, "AlarmManager 不可用，提醒未调度 todo=${todo.id}")
            return
        }
        val now = System.currentTimeMillis()
        val canExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || manager.canScheduleExactAlarms()
        for (item in ReminderPlan.plan(todo.deadline, now)) {
            val pending = pendingIntent(todo.id, item.kind)
            if (canExact) {
                manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, item.fireAt, pending)
            } else {
                Log.w(TAG, "无精确闹钟权限，降级为非精确调度 todo=${todo.id} kind=${item.kind.storageKey}")
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, item.fireAt, pending)
            }
        }
    }

    fun cancelAll(todoId: String) {
        val manager = alarmManager ?: return
        for (kind in ReminderKind.entries) {
            manager.cancel(pendingIntent(todoId, kind))
        }
    }

    companion object {
        private const val TAG = "AlarmScheduler"
    }
}
