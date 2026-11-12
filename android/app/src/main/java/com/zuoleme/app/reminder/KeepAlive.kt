package com.zuoleme.app.reminder

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.zuoleme.app.data.TodoRepository
import com.zuoleme.app.domain.NextTick
import com.zuoleme.app.notify.Notifier
import com.zuoleme.app.service.PinnedTodoService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

private val keepAliveScope = CoroutineScope(Dispatchers.IO)

/**
 * 服务自拉起与常驻通知重贴的统一入口（底层存活机制，与界面无关）。
 *
 * 旧实现的问题：服务被杀后用 PendingIntent.getService 定时自拉起，
 * 安卓 12+ 从后台直接启动服务会被系统拦截，这条路等于没有。
 * 新实现三层兜底，任一层活着都能把通知拉回来：
 * 1. 每分钟闹钟（TickAlarm）：唤醒进程重贴常驻通知，不依赖服务存活；
 * 2. 重启广播（RestartReceiver）：闹钟触发广播属于精确闹钟豁免场景，
 *    在广播里再 startForegroundService 成功率高得多；
 * 3. WorkManager 周期自检（KeepAliveWorker）：每 15 分钟核对并修复
 *    服务、常驻通知与全部闹钟。
 */
object ServiceRestarter {
    private const val TAG = "ServiceRestarter"
    private const val RESTART_REQUEST_CODE = 9001
    private const val TICK_REQUEST_CODE = 9002

    /** 服务被杀/被划卡后 1 秒：先走广播，再由广播拉起前台服务 */
    fun scheduleRestart(context: Context) {
        try {
            val intent = Intent(context, RestartReceiver::class.java).apply {
                action = RestartReceiver.ACTION_RESTART
            }
            val pending = PendingIntent.getBroadcast(
                context,
                RESTART_REQUEST_CODE,
                intent,
                PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE,
            )
            val manager = context.getSystemService(AlarmManager::class.java) ?: return
            manager.setAndAllowWhileIdle(
                AlarmManager.RTC_WAKEUP,
                System.currentTimeMillis() + 1_000L,
                pending,
            )
        } catch (e: Exception) {
            Log.w(TAG, "安排服务重启失败，等待下一层兜底（分钟闹钟/周期自检）", e)
        }
    }

    /** 启动/续订每分钟重贴闹钟链（幂等：同一 requestCode 反复调用只更新触发时间） */
    fun scheduleNextTick(context: Context) {
        try {
            val intent = Intent(context, TickReceiver::class.java).apply {
                action = TickReceiver.ACTION_TICK
            }
            val pending = PendingIntent.getBroadcast(
                context,
                TICK_REQUEST_CODE,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val manager = context.getSystemService(AlarmManager::class.java) ?: return
            val fireAt = NextTick.nextMinuteBoundary(System.currentTimeMillis())
            val canExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || manager.canScheduleExactAlarms()
            if (canExact) {
                manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fireAt, pending)
            } else {
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fireAt, pending)
            }
        } catch (e: Exception) {
            Log.w(TAG, "安排分钟重贴闹钟失败", e)
        }
    }

    /** 注册周期自检（已存在则保持，不重复排） */
    fun enqueuePeriodicCheck(context: Context) {
        try {
            val request = PeriodicWorkRequestBuilder<KeepAliveWorker>(15, TimeUnit.MINUTES).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                KeepAliveWorker.UNIQUE_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        } catch (e: Exception) {
            Log.w(TAG, "注册周期自检失败", e)
        }
    }

    /** 一次完整自检：重贴常驻通知、续订分钟闹钟、尝试拉起服务、修复全部提醒闹钟 */
    suspend fun runHealthCheck(context: Context, source: String) {
        val repository = TodoRepository.get(context)
        Notifier.repostPinned(context, repository.nearestPending())
        scheduleNextTick(context)
        repository.rescheduleAll()
        PinnedTodoService.start(context)
        Log.i(TAG, "自检完成 source=$source")
    }
}

/** 每分钟闹钟到点：重贴常驻通知并续上下一分钟，同时尝试把服务拉回来 */
class TickReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_TICK) return
        val pending = goAsync()
        keepAliveScope.launch {
            try {
                ServiceRestarter.runHealthCheck(context, "tick")
            } catch (e: Exception) {
                Log.e(TAG, "分钟重贴失败", e)
                ServiceRestarter.scheduleNextTick(context)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_TICK = "com.zuoleme.app.action.TICK"
        private const val TAG = "TickReceiver"
    }
}

/** 服务自拉起广播：在广播上下文里启动前台服务（精确闹钟链路豁免场景） */
class RestartReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_RESTART) return
        PinnedTodoService.start(context)
        ServiceRestarter.scheduleNextTick(context)
    }

    companion object {
        const val ACTION_RESTART = "com.zuoleme.app.action.RESTART_SERVICE"
    }
}

/** 周期自检：进程被杀时由系统择机唤醒，核对并修复通知、服务与闹钟 */
class KeepAliveWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        return try {
            ServiceRestarter.runHealthCheck(applicationContext, "worker")
            Result.success()
        } catch (e: Exception) {
            Log.e(TAG, "周期自检失败，等待下轮重试", e)
            Result.retry()
        }
    }

    companion object {
        const val UNIQUE_NAME = "zuoleme-keepalive"
        private const val TAG = "KeepAliveWorker"
    }
}
