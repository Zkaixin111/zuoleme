package com.zuoleme.app.service

import android.app.AlarmManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import androidx.core.app.ServiceCompat
import com.zuoleme.app.data.TodoRepository
import com.zuoleme.app.notify.NotificationIds
import com.zuoleme.app.notify.Notifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * 前台服务常驻通知（原生应用才有的能力，PWA 做不到）：
 * 持续显示最近一件未完成的事与倒计时，每分钟刷新一次。
 *
 * 存活策略（不承诺「永不消失」，只做系统允许范围内的最大自愈）：
 * - START_STICKY：被系统杀掉后由系统择机重启；
 * - onTaskRemoved / onDestroy：用 AlarmManager 安排一次自拉起；
 * - 开机由 BootReceiver 拉起；安卓 14+ 用户划掉常驻通知时服务仍在运行，
 *   下一次每分钟刷新会重新贴出通知。
 */
class PinnedTodoService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var observeJob: Job? = null
    private var tickJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Notifier.ensureChannels(this)
        startAsForeground()
        observeNearest()
        startTicker()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startAsForeground()
        if (observeJob == null) observeNearest()
        if (tickJob == null) startTicker()
        return START_STICKY
    }

    private fun startAsForeground() {
        val notification = Notifier.buildPinned(this, null, System.currentTimeMillis())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceCompat.startForeground(
                this,
                NotificationIds.PINNED,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(NotificationIds.PINNED, notification)
        }
    }

    private fun observeNearest() {
        observeJob = scope.launch {
            TodoRepository.get(this@PinnedTodoService).observeNearestPending().collectLatest { todo ->
                val notification = Notifier.buildPinned(this@PinnedTodoService, todo, System.currentTimeMillis())
                getSystemService(android.app.NotificationManager::class.java)
                    ?.notify(NotificationIds.PINNED, notification)
            }
        }
    }

    /** 倒计时每分钟走一格：直接重读最近待办并刷新常驻通知 */
    private fun startTicker() {
        tickJob = scope.launch {
            while (true) {
                delay(60_000L)
                val todo = TodoRepository.get(this@PinnedTodoService).nearestPending()
                val notification = Notifier.buildPinned(this@PinnedTodoService, todo, System.currentTimeMillis())
                getSystemService(android.app.NotificationManager::class.java)
                    ?.notify(NotificationIds.PINNED, notification)
            }
        }
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        scheduleRestart()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        scheduleRestart()
        scope.cancel()
        super.onDestroy()
    }

    /** 自拉起兜底：1 秒后通过闹钟重新启动本服务（被划卡/被杀时用） */
    private fun scheduleRestart() {
        try {
            val restartIntent = Intent(applicationContext, PinnedTodoService::class.java)
            val pending = PendingIntent.getService(
                applicationContext,
                RESTART_REQUEST_CODE,
                restartIntent,
                PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE,
            )
            getSystemService(AlarmManager::class.java)?.set(
                AlarmManager.ELAPSED_REALTIME,
                SystemClock.elapsedRealtime() + 1_000L,
                pending,
            )
        } catch (e: Exception) {
            Log.w(TAG, "安排服务自拉起失败", e)
        }
    }

    companion object {
        private const val TAG = "PinnedTodoService"
        private const val RESTART_REQUEST_CODE = 9001

        /** 启动常驻服务（已在前台/后台均可；开机场景走 BootReceiver 调用同一入口） */
        fun start(context: Context) {
            val intent = Intent(context, PinnedTodoService::class.java)
            try {
                androidx.core.content.ContextCompat.startForegroundService(context, intent)
            } catch (e: Exception) {
                // 安卓 12+ 后台启动前台服务受限：开机广播属于豁免场景，一般可达；
                // 失败不静默，留日志并等用户下次打开应用时再拉起。
                Log.w(TAG, "启动前台服务失败（可能处于后台启动限制），下次打开应用将重试", e)
            }
        }
    }
}
