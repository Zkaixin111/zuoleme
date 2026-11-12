package com.zuoleme.app.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.zuoleme.app.MainActivity
import com.zuoleme.app.R
import com.zuoleme.app.data.TodoEntity
import com.zuoleme.app.domain.ReminderKind
import com.zuoleme.app.domain.ReminderPlan
import com.zuoleme.app.domain.RemainingText
import com.zuoleme.app.reminder.CompleteReceiver

object NotificationIds {
    /** 常驻通知固定 id */
    const val PINNED = 1001

    /** 每条提醒独立 id：不同事项、不同档位互不覆盖 */
    fun reminder(todoId: String, kind: ReminderKind): Int =
        2000 + (("$todoId:${kind.storageKey}").hashCode() and 0x3FFFFFFF)
}

/** 通知渠道与构建集中一处，提醒通知与常驻通知分开两个渠道，用户可在系统里分别管理。 */
object Notifier {
    const val CHANNEL_REMINDERS = "reminders"
    const val CHANNEL_PINNED = "pinned"

    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_REMINDERS, "到期提醒", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "截止前六档提醒与到点提醒"
                enableVibration(true)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_PINNED, "常驻显示", NotificationManager.IMPORTANCE_LOW).apply {
                description = "前台服务常驻通知：最近一件待办与倒计时"
                enableVibration(false)
                setSound(null, null)
            },
        )
    }

    private fun openAppIntent(context: Context, todoId: String?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            if (todoId != null) putExtra(MainActivity.EXTRA_TODO_ID, todoId)
        }
        return PendingIntent.getActivity(
            context,
            todoId?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun completeAction(context: Context, todoId: String, requestCodeSeed: String): PendingIntent {
        val intent = Intent(context, CompleteReceiver::class.java).apply {
            action = CompleteReceiver.ACTION_COMPLETE
            putExtra(CompleteReceiver.EXTRA_TODO_ID, todoId)
        }
        return PendingIntent.getBroadcast(
            context,
            requestCodeSeed.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /** 六档提醒通知：每件事、每档位独立一条，带「完成」动作 */
    fun showReminder(context: Context, todo: TodoEntity, kind: ReminderKind) {
        val notification = NotificationCompat.Builder(context, CHANNEL_REMINDERS)
            .setSmallIcon(R.drawable.ic_stat_reminder)
            .setContentTitle(todo.title)
            .setContentText(ReminderPlan.body(kind))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setOngoing(false)
            .setContentIntent(openAppIntent(context, todo.id))
            .addAction(0, "完成", completeAction(context, todo.id, "reminder:${todo.id}:${kind.storageKey}"))
            .build()
        context.getSystemService(NotificationManager::class.java)
            ?.notify(NotificationIds.reminder(todo.id, kind), notification)
    }

    fun dismissReminder(context: Context, todoId: String, kind: ReminderKind) {
        context.getSystemService(NotificationManager::class.java)
            ?.cancel(NotificationIds.reminder(todoId, kind))
    }

    /** 常驻通知内容：最近一件未完成的事 + 剩余时间；没有待办时显示提示文案 */
    fun buildPinned(context: Context, todo: TodoEntity?, now: Long): android.app.Notification {
        val builder = NotificationCompat.Builder(context, CHANNEL_PINNED)
            .setSmallIcon(R.drawable.ic_stat_reminder)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)

        if (todo == null) {
            builder
                .setContentTitle("做了么")
                .setContentText("现在没有待办，点这里添加")
                .setContentIntent(openAppIntent(context, null))
        } else {
            val remaining = RemainingText.format(todo.deadline - now)
            builder
                .setContentTitle(todo.title)
                .setContentText(if (todo.deadline - now <= 0) "已到截止时间" else "还剩 $remaining")
                .setContentIntent(openAppIntent(context, todo.id))
                .addAction(0, "完成", completeAction(context, todo.id, "pinned:${todo.id}"))
        }
        return builder.build()
    }
}
