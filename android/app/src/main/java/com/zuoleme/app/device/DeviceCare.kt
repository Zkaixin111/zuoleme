package com.zuoleme.app.device

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log

/** 一个系统设置页组件候选（包名 + 类名）。 */
data class ComponentTarget(val packageName: String, val className: String)

/**
 * 厂商保活设置跳转。
 *
 * 真我 Neo6 SE 跑 realme UI（基于 ColorOS，和 OPPO / 一加同源）：它默认冻结
 * 后台应用、自启动也没有公开 API，只能按已知的系统组件名依次尝试打开
 * 「自启动管理」页，全部打不开时兜底到应用详情页让用户手动点进去。
 * 这些开关应用自己改不了、也读不到状态，只能给文案指路——不要假装能检测。
 */
object DeviceCare {
    /** 自启动管理页候选（主流 ColorOS 组件 + 新版 OPlus + realme 自有组件） */
    val autoStartTargets: List<ComponentTarget> = listOf(
        ComponentTarget("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
        ComponentTarget("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
        ComponentTarget("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"),
        ComponentTarget("com.oplus.safe", "com.oplus.safe.permission.startup.StartupAppListActivity"),
        ComponentTarget("com.oplus.safecenter", "com.oplus.safecenter.startupapp.view.StartupAppListActivity"),
        ComponentTarget("com.realme.security", "com.realme.security.permission.startup.StartupAppListActivity"),
    )

    /** realme / OPPO / 一加 都是 ColorOS 系，保活设置同源 */
    fun isColorOsLike(manufacturer: String?, brand: String?): Boolean {
        val values = listOfNotNull(manufacturer, brand).map { it.lowercase() }
        return values.any { it.contains("realme") || it.contains("oppo") || it.contains("oneplus") }
    }

    fun isCurrentDeviceColorOsLike(): Boolean = isColorOsLike(Build.MANUFACTURER, Build.BRAND)

    /** 当前设备标识，如「realme RMX3850」，用于界面上确认适配是否命中 */
    fun deviceLabel(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

    /**
     * 打开自启动管理页。
     * @return 是否成功打开某个候选页；全部失败时已兜底打开应用详情页并返回 false
     */
    fun openAutoStartSettings(context: Context): Boolean {
        for (target in autoStartTargets) {
            val intent = Intent().apply {
                component = ComponentName(target.packageName, target.className)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            val resolved = context.packageManager.resolveActivity(intent, 0)
            if (resolved == null) continue
            try {
                context.startActivity(intent)
                return true
            } catch (e: Exception) {
                Log.w(TAG, "打开自启动页失败 ${target.packageName}/${target.className}", e)
            }
        }
        Log.w(TAG, "所有自启动页候选都打不开，兜底到应用详情页")
        openAppDetails(context)
        return false
    }

    /** 打开本应用的系统详情页（通知、耗电量、自启动开关都在这一页往下点） */
    fun openAppDetails(context: Context) {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.parse("package:${context.packageName}")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            context.startActivity(intent)
        } catch (e: Exception) {
            Log.e(TAG, "打开应用详情页失败", e)
        }
    }

    private const val TAG = "DeviceCare"
}
