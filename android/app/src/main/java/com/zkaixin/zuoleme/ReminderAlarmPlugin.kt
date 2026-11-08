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
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import org.json.JSONArray

/**
 * 自研的「系统闹钟」原生插件。
 *
 * 为什么不用 `@capacitor/local-notifications`：它在设备重启后不会重建闹钟，
 * 而「重启后照常提醒」是本产品的硬需求。自己控制 AlarmManager 才能做到
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
     * 全量替换所有闹钟。
     *
     * JS 调用：`ReminderAlarm.scheduleAll({ alarms: [{ id, title, body, fireAt }] })`
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
                    Log.w(TAG, "跳过非法闹钟条目 index=$index")
                    continue
                }
                records.add(
                    AlarmRecord(
                        id = id,
                        title = if (title.isEmpty()) DEFAULT_TITLE else title,
                        body = item.optString("body", ""),
                        fireAt = fireAt
                    )
                )
            }
        }

        try {
            ReminderNotifier.ensureChannel(context)
            // 回报「真正排上的条数」而不是入参条数：原生会过滤掉已过去的时刻、
            // 排程失败也不会计入，这样界面上「已排程 N 条」才是真的
            val scheduled = ReminderStore.scheduleAll(context, records)
            val result = JSObject()
            result.put("scheduled", scheduled)
            call.resolve(result)
        } catch (error: Exception) {
            Log.e(TAG, "scheduleAll 失败", error)
            call.reject("设置系统闹钟失败：${error.message ?: "未知错误"}")
        }
    }

    /**
     * 取消所有闹钟并清空持久化记录。
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
            call.reject("取消系统闹钟失败：${error.message ?: "未知错误"}")
        }
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
     * 跳转系统「精确闹钟」授权页（Android 12+ 才有该页面）。
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
                // 个别 ROM 删掉了这个页面，退回到应用详情页
                startIntent(appDetailsIntent())
            }
        } else {
            // Android 12 以下无需授权，给用户看应用详情页作为兜底反馈
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
     * 跳转「本应用的通知设置页」。
     *
     * 用户拒绝过一次通知权限后，系统不再弹框（`requestPermissionForAlias` 直接返回 denied），
     * 这时唯一能打开开关的地方就是这里，所以它不是一个可有可无的入口。
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
            // Android 8 以下没有按应用的通知设置页，退回到应用详情页
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
     * Android 13（TIRAMISU）起 POST_NOTIFICATIONS 是运行时权限；更低版本
     * 只要没被用户关闭通知渠道，就视为已授予。
     */
    private fun hasNotificationPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return true
        }
        return context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    private companion object {
        const val TAG = "ReminderAlarmPlugin"

        /** 通知权限的 Capacitor 别名（对应类上的 @Permission） */
        const val ALIAS_NOTIFICATIONS = "notifications"

        /** 标题兜底文案 */
        const val DEFAULT_TITLE = "做了么"
    }
}
