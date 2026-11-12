package com.zuoleme.app.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
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
 * - onTaskRemoved / onDestroy：走 ServiceRestarter 的「闹钟→广播→拉服务」链路
 *   （旧版直接用闹钟启动 Service 在安卓 12+ 会被后台限制拦截，已弃用）；
 * - 即使服务没拉起来，每分钟闹钟（TickReceiver）与 15 分钟周期自检
 *   （KeepAliveWorker）都会把常驻通知重贴回来，常驻通知不再单吊在服务进程上；
 * - 开机由 BootReceiver 恢复；安卓 14+ 用户划掉常驻通知时，下一次分钟重贴会再贴出。
 */
class PinnedTodoService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var observeJob: Job? = null
    private var tickJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Notifier.ensureChannels(this)
        com.zuoleme.app.reminder.ServiceRestarter.scheduleNextTick(this)
        com.zuoleme.app.reminder.ServiceRestarter.enqueuePeriodicCheck(this)
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

    /**
     * 自拉起兜底：走「闹钟 → 广播 → 广播里启动前台服务」这条路。
     * 旧实现直接用闹钟启动 Service，安卓 12+ 从后台拉服务会被拦截，等于没有；
     * 广播属于精确闹钟链路，在广播里再拉前台服务成功率更高。
     * 同时启动/续订每分钟重贴与周期自检，即使服务这次没拉起来，通知也会被贴回。
     */
    private fun scheduleRestart() {
        com.zuoleme.app.reminder.ServiceRestarter.scheduleRestart(applicationContext)
        com.zuoleme.app.reminder.ServiceRestarter.scheduleNextTick(applicationContext)
        com.zuoleme.app.reminder.ServiceRestarter.enqueuePeriodicCheck(applicationContext)
    }

    companion object {
        private const val TAG = "PinnedTodoService"

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
