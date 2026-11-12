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
 * 有精确闹钟权限时用 setAlarmClock——这是系统里优先级最高的闹钟通道
 * （锁屏/Doze/国产系统省电下存活率都高于普通精确闹钟，状态栏还会显示下次提醒）；
 * 没有权限时降级 setExactAndAllowWhileIdle，再不行 setAndAllowWhileIdle，全程打日志不静默。
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
                // 点状态栏闹钟图标回到应用（showIntent 可为待办本身，简化为最近触发的这条）
                val showIntent = android.app.PendingIntent.getActivity(
                    context,
                    ("clockshow:${todo.id}").hashCode(),
                    Intent(context, com.zuoleme.app.MainActivity::class.java).apply {
                        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
                        putExtra(com.zuoleme.app.MainActivity.EXTRA_TODO_ID, todo.id)
                    },
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
                )
                try {
                    manager.setAlarmClock(AlarmManager.AlarmClockInfo(item.fireAt, showIntent), pending)
                    continue
                } catch (e: SecurityException) {
                    Log.w(TAG, "setAlarmClock 被拒绝，降级精确闹钟 todo=${todo.id} kind=${item.kind.storageKey}", e)
                }
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
