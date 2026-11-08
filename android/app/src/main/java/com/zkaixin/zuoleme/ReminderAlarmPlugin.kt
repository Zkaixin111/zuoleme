package com.zkaixin.zuoleme

import android.Manifest
import android.app.AlarmManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.lang.ref.WeakReference
import org.json.JSONArray
import org.json.JSONObject

/**
 * 自研的「系统提醒」原生插件。
 *
 * 为什么不用 `@capacitor/local-notifications`：它在设备重启后不会重建闹钟，
 * 而「重启后照常提醒」是硬需求。自己控制 AlarmManager 才能做到
 * 「排程 → 持久化 → 开机重建」这条闭环（见 [ReminderStore] 与 [BootReceiver]）。
 *
 * JS 侧对应 `src/lib/reminder-bridge.ts`，方法名与参数一一对应。
 */
@CapacitorPlugin(
    name = "ReminderAlarm",
    permissions = [
        Permission(
            alias = "notifications",
            strings = [Manifest.permission.POST_NOTIFICATIONS]
        )
    ]
)
class ReminderAlarmPlugin : Plugin() {

    /**
     * JS 侧当前的视图深度：0 = 首页，>= 1 = 子页面（编辑页 / 历史页）。
     *
     * 由 `App.tsx` 在视图切换后调用 `setViewDepth` 写入，`MainActivity.onBackPressed`
     * 读它来决定「拦下来交给 JS」还是「交回系统退出应用」。
     */
    private var viewDepth: Int = 0

    /**
     * 把插件实例挂到静态引用上，供 `MainActivity` 在返回键里回调。
     *
     * 用 `WeakReference` 而不是直接持有：Activity 重建时旧实例应该能被回收，
     * 拿强引用会在旋转 / 多窗口切换时泄漏整个 Bridge。
     */
    override fun load() {
        instance = WeakReference(this)
    }

    override fun handleOnDestroy() {
        if (instance?.get() === this) {
            instance = null
        }
        super.handleOnDestroy()
    }

    /**
     * 上报当前视图深度。
     *
     * JS 调用：`ReminderAlarm.setViewDepth({ depth: 0 | 1 })`
     *
     * **为什么不靠 WebView history 判断返回**：本项目没有注册 Capacitor 的
     * `backButton` 监听，WebView 又没有可用的前进/后退栈（单页应用，视图由 React
     * state 管），所以系统返回键会一路走到 `Activity.onBackPressed` 然后**直接退出应用**。
     * 另一种写法是 `onBackPressed` 里 `evaluateJavascript("history.back()")`，
     * 但那是异步的、还要处理回调时序，且与 React 状态不同步；
     * 维护一个由 JS 主动写入的深度计数是同步的、无竞态的。
     */
    @PluginMethod
    fun setViewDepth(call: PluginCall) {
        val depth = call.getInt("depth") ?: 0
        viewDepth = if (depth > 0) depth else 0
        call.resolve()
    }

    /**
     * 通知 JS「用户按了返回」，返回是否成功通知到。
     *
     * 内部方法：只给 [notifyBackRequested] 调用，调用方已确认 depth > 0。
     */
    private fun dispatchBackRequested(): Boolean {
        return try {
            notifyListeners(EVENT_BACK_REQUESTED, JSObject())
            true
        } catch (error: Exception) {
            Log.w(TAG, "通知 JS 返回事件失败，交回系统处理", error)
            false
        }
    }

    /**
     * 全量替换所有提醒。
     *
     * JS 调用：`ReminderAlarm.scheduleAll({ alarms: [{ id, todoId, title, deadline, fireAt }] })`
     *
     * @param call 参数里带 `alarms` 数组
     */
    @PluginMethod
    fun scheduleAll(call: PluginCall) {
        val raw: JSONArray? = call.getArray("alarms")
        val records = ArrayList<AlarmRecord>()
        if (raw != null) {
            for (index in 0 until raw.length()) {
                val item = raw.optJSONObject(index) ?: continue
                val id = item.optInt("id", 0)
                val fireAt = item.optLong("fireAt", 0L)
                val title = item.optString("title", "")
                if (id <= 0 || fireAt <= 0L) {
                    Log.w(TAG, "跳过非法提醒条目 index=$index")
                    continue
                }
                records.add(
                    AlarmRecord(
                        id = id,
                        todoId = item.optString("todoId", ""),
                        title = if (title.isEmpty()) DEFAULT_TITLE else title,
                        deadline = item.optLong("deadline", fireAt),
                        fireAt = fireAt
                    )
                )
            }
        }

        try {
            ReminderNotifier.ensureChannel(context)
            // 回报「真正排上的条数」而不是入参条数
            val scheduled = ReminderStore.scheduleAll(context, records)
            val result = JSObject()
            result.put("scheduled", scheduled)
            call.resolve(result)
        } catch (error: Exception) {
            Log.e(TAG, "scheduleAll 失败", error)
            call.reject("设置系统提醒失败：${error.message ?: "未知错误"}")
        }
    }

    /**
     * 取消所有提醒并清空持久化记录。
     *
     * JS 调用：`ReminderAlarm.cancelAll()`
     */
    @PluginMethod
    fun cancelAll(call: PluginCall) {
        try {
            ReminderStore.cancelAll(context)
            call.resolve()
        } catch (error: Exception) {
            Log.e(TAG, "cancelAll 失败", error)
            call.reject("取消系统提醒失败：${error.message ?: "未知错误"}")
        }
    }

    /**
     * 取走「用户点了哪条通知」。
     *
     * JS 调用：`ReminderAlarm.getPendingOpen()` → `{ todoId }`（没有则为 null）。
     * 读一次即清空，切回前台不会反复跳转同一个详情页。
     */
    @PluginMethod
    fun getPendingOpen(call: PluginCall) {
        val todoId = try {
            ReminderStore.consumePendingOpen(context)
        } catch (error: Exception) {
            Log.e(TAG, "读取待打开待办失败", error)
            null
        }
        val result = JSObject()
        if (todoId == null) {
            result.put("todoId", JSONObject.NULL)
        } else {
            result.put("todoId", todoId)
        }
        call.resolve(result)
    }

    /**
     * 读取三项系统授权状态。
     *
     * JS 调用：`ReminderAlarm.getPermissionState()` → `{ notifications, exactAlarm, batteryOptimized }`
     */
    @PluginMethod
    fun getPermissionState(call: PluginCall) {
        val result = JSObject()
        result.put("notifications", hasNotificationPermission())

        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
        result.put("exactAlarm", alarmManager != null && ReminderStore.canScheduleExact(alarmManager))

        val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val ignored = if (powerManager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            powerManager.isIgnoringBatteryOptimizations(context.packageName)
        } else {
            // Android 6 以下没有电池优化概念，视为不受限
            true
        }
        // 字段语义：true = 仍被系统优化限制（不理想）
        result.put("batteryOptimized", !ignored)

        // 磁盘上有记录但解析不出来 = 提醒已经丢了，必须让界面能显示出来，不能静默
        val loadResult = try {
            ReminderStore.loadWithStats(context)
        } catch (error: Exception) {
            Log.e(TAG, "读取提醒记录失败（用于统计丢弃条数）", error)
            null
        }
        result.put("droppedAlarmCount", loadResult?.dropped ?: 0)

        call.resolve(result)
    }

    /**
     * 请求通知权限（Android 13+ 为运行时权限；更低版本安装即授予）。
     *
     * JS 调用：`ReminderAlarm.requestNotificationPermission()` → `{ notifications }`
     */
    @PluginMethod
    fun requestNotificationPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || hasNotificationPermission()) {
            val result = JSObject()
            result.put("notifications", hasNotificationPermission())
            call.resolve(result)
            return
        }
        requestPermissionForAlias(ALIAS_NOTIFICATIONS, call, "notificationPermissionCallback")
    }

    /**
     * 通知权限请求结果的回调（由 Capacitor 反射调用）。
     *
     * @param call 被挂起的原始调用
     */
    @PermissionCallback
    fun notificationPermissionCallback(call: PluginCall) {
        val result = JSObject()
        result.put("notifications", hasNotificationPermission())
        call.resolve(result)
    }

    /**
     * 跳转系统「准时触发」授权页（Android 12+ 才有该页面）。
     *
     * JS 调用：`ReminderAlarm.openExactAlarmSettings()`
     */
    @PluginMethod
    fun openExactAlarmSettings(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
                data = Uri.parse("package:${context.packageName}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            if (!startIntent(intent)) {
                startIntent(appDetailsIntent())
            }
        } else {
            startIntent(appDetailsIntent())
        }
        call.resolve()
    }

    /**
     * 跳转系统「电池优化」设置页。
     *
     * JS 调用：`ReminderAlarm.openBatterySettings()`
     */
    @PluginMethod
    fun openBatterySettings(call: PluginCall) {
        val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        if (!startIntent(intent)) {
            startIntent(appDetailsIntent())
        }
        call.resolve()
    }

    /**
     * 跳转「本应用的通知设置页」（拒绝过权限后系统不再弹框，只能从这里手动打开）。
     *
     * JS 调用：`ReminderAlarm.openNotificationSettings()`
     */
    @PluginMethod
    fun openNotificationSettings(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            if (!startIntent(intent)) {
                startIntent(appDetailsIntent())
            }
        } else {
            startIntent(appDetailsIntent())
        }
        call.resolve()
    }

    /**
     * 安全启动一个系统页面。
     *
     * @param intent 目标 Intent
     * @return 是否成功交给系统
     */
    private fun startIntent(intent: Intent): Boolean {
        return try {
            context.startActivity(intent)
            true
        } catch (error: Exception) {
            Log.e(TAG, "打开系统设置页失败：${intent.action}", error)
            false
        }
    }

    /** 当前应用详情页 Intent（所有 ROM 都有） */
    private fun appDetailsIntent(): Intent {
        return Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.parse("package:${context.packageName}")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    /**
     * 是否已授予通知权限。
     *
     * Android 13（TIRAMISU）起 POST_NOTIFICATIONS 是运行时权限；更低版本只要
     * 用户没在系统里关掉应用通知，就视为已授予。
     */
    private fun hasNotificationPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return true
        }
        return context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    companion object {
        private const val TAG = "ReminderAlarmPlugin"

        /** 通知权限的 Capacitor 别名（对应类上的 @Permission） */
        private const val ALIAS_NOTIFICATIONS = "notifications"

        /** 标题兜底文案 */
        private const val DEFAULT_TITLE = "做了么"

        /** 返回键事件名，JS 侧 `ReminderAlarm.addListener('backRequested', …)` 对应它 */
        const val EVENT_BACK_REQUESTED = "backRequested"

        /** 当前插件实例（Bridge 创建后写入，销毁时清空） */
        @Volatile
        private var instance: WeakReference<ReminderAlarmPlugin>? = null

        /**
         * 当前视图深度；插件还没起来（Bridge 未就绪 / 界面还没渲染）时按 0 处理，
         * 也就是「交回系统」，宁可退出应用也不要吞掉返回键。
         */
        fun currentViewDepth(): Int {
            val plugin = instance?.get() ?: return 0
            return plugin.viewDepth
        }

        /**
         * 让 JS 处理这次返回。
         *
         * @return true = JS 已接手（调用方不要再调 super）；false = 没人接手，交回系统
         */
        fun notifyBackRequested(): Boolean {
            val plugin = instance?.get() ?: return false
            return plugin.dispatchBackRequested()
        }
    }
}
