package com.zuoleme.app.reminder

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.zuoleme.app.data.TodoRepository
import com.zuoleme.app.domain.ReminderKind
import com.zuoleme.app.notify.Notifier
import com.zuoleme.app.service.PinnedTodoService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

private val receiverScope = CoroutineScope(Dispatchers.IO)

/** 六档提醒到点：弹出该档位独立通知；待办已完成/已删除则跳过，不误报。 */
class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_FIRE) return
        val todoId = intent.getStringExtra(EXTRA_TODO_ID) ?: return
        val kind = ReminderKind.fromStorageKey(intent.getStringExtra(EXTRA_KIND))
        val pending = goAsync()
        receiverScope.launch {
            try {
                val todo = TodoRepository.get(context).findById(todoId)
                if (todo != null && !todo.done) {
                    Notifier.showReminder(context, todo, kind)
                }
            } catch (e: Exception) {
                Log.e(TAG, "处理提醒失败 todo=$todoId kind=${kind.storageKey}", e)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_FIRE = "com.zuoleme.app.action.REMINDER_FIRE"
        const val EXTRA_TODO_ID = "todo_id"
        const val EXTRA_KIND = "kind"
        private const val TAG = "ReminderReceiver"
    }
}

/** 通知上的「完成」动作：标记完成、取消后续档位、刷新常驻通知。 */
class CompleteReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_COMPLETE) return
        val todoId = intent.getStringExtra(EXTRA_TODO_ID) ?: return
        val pending = goAsync()
        receiverScope.launch {
            try {
                TodoRepository.get(context).setDone(todoId, true)
                // 把这条待办已弹出的各档通知一并收掉，避免点完一条还留着旧的
                for (kind in ReminderKind.entries) {
                    Notifier.dismissReminder(context, todoId, kind)
                }
                PinnedTodoService.start(context)
            } catch (e: Exception) {
                Log.e(TAG, "通知完成动作失败 todo=$todoId", e)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_COMPLETE = "com.zuoleme.app.action.COMPLETE_TODO"
        const val EXTRA_TODO_ID = "todo_id"
        private const val TAG = "CompleteReceiver"
    }
}

/** 开机 / 应用被更新覆盖后：恢复全部闹钟并拉起常驻服务，不需要用户打开应用。 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val pending = goAsync()
        receiverScope.launch {
            try {
                ServiceRestarter.runHealthCheck(context, "boot")
                ServiceRestarter.enqueuePeriodicCheck(context)
            } catch (e: Exception) {
                Log.e(TAG, "开机恢复提醒失败", e)
            } finally {
                pending.finish()
            }
        }
    }

    private companion object {
        const val TAG = "BootReceiver"
    }
}
