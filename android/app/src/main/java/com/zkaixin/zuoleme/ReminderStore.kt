package com.zkaixin.zuoleme

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * 一条待触发的提醒闹钟。
 *
 * 与前端 `src/lib/alarms.ts` 里的 `ReminderAlarm` 一一对应：
 * id 由前端用 `hash(todoId + kind)` 算出，保证「每件事、每一档」都有独立 id，
 * 因此两条提醒不会互相覆盖，也能用 id 反查是哪条待办的哪一档。
 *
 * @property id 正整数，同时作为通知 id 与 PendingIntent requestCode
 * @property title 通知标题（= 待办标题）
 * @property body 通知正文（「还有 3 小时截止」这类）
 * @property fireAt 触发时刻（epoch 毫秒）
 */
data class AlarmRecord(
    val id: Int,
    val title: String,
    val body: String,
    val fireAt: Long
)

/**
 * 闹钟的持久化与排程中心（`SharedPreferences` + `AlarmManager`）。
 *
 * 为什么要持久化：`AlarmManager` 里的闹钟在设备重启后会**全部丢失**，
 * 而「重启后照常提醒」是产品硬需求。所以每次排钟都要把列表写到磁盘，
 * 由 `BootReceiver` 在开机广播里读回来重排。
 *
 * 这个文件被三处使用：
 * 1. `ReminderAlarmPlugin.scheduleAll()` —— 应用内数据变化时全量重排；
 * 2. `ReminderAlarmPlugin.cancelAll()` —— 用户清空时取消；
 * 3. `BootReceiver` —— 开机 / 应用更新后重建。
 */
object ReminderStore {

    private const val TAG = "ReminderStore"

    /** SharedPreferences 文件名 */
    private const val PREFS_NAME = "zuoleme_alarms"

    /** 闹钟数组的键 */
    private const val KEY_ALARMS = "alarms"

    /** 闹钟广播 action 前缀（完整 action 会拼上 id，保证每个 PendingIntent 唯一） */
    const val ACTION_FIRE_PREFIX = "com.zkaixin.zuoleme.action.REMINDER_FIRE"

    /** Intent extra：闹钟 id */
    const val EXTRA_ID = "alarm_id"

    /** Intent extra：通知标题 */
    const val EXTRA_TITLE = "alarm_title"

    /** Intent extra：通知正文 */
    const val EXTRA_BODY = "alarm_body"

    /**
     * 读取磁盘上的闹钟列表。
     *
     * 任何解析异常都返回空列表而不是抛异常：开机广播里崩溃会让用户以为
     * 「重启后提醒没了」，而提前 return 至少还能保住应用本身可用。
     *
     * @param context 任意 Context
     */
    fun load(context: Context): List<AlarmRecord> {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_ALARMS, null) ?: return emptyList()
        if (raw.isEmpty()) {
            return emptyList()
        }
        return try {
            val array = JSONArray(raw)
            val records = ArrayList<AlarmRecord>(array.length())
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index) ?: continue
                val id = item.optInt("id", 0)
                val fireAt = item.optLong("fireAt", 0L)
                // 非法条目直接丢弃：宁可少一条，也不要在 AlarmManager 里排一个已过去的时间
                if (id <= 0 || fireAt <= 0L) {
                    continue
                }
                records.add(
                    AlarmRecord(
                        id = id,
                        title = item.optString("title", ""),
                        body = item.optString("body", ""),
                        fireAt = fireAt
                    )
                )
            }
            records
        } catch (error: Exception) {
            Log.e(TAG, "读取本地闹钟记录失败，按空列表处理", error)
            emptyList()
        }
    }

    /**
     * 覆盖写入闹钟列表。
     *
     * @param context 任意 Context
     * @param alarms 待保存的闹钟
     */
    fun save(context: Context, alarms: List<AlarmRecord>) {
        val array = JSONArray()
        for (alarm in alarms) {
            val item = JSONObject()
            item.put("id", alarm.id)
            item.put("title", alarm.title)
            item.put("body", alarm.body)
            item.put("fireAt", alarm.fireAt)
            array.put(item)
        }
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_ALARMS, array.toString())
            .apply()
    }

    /**
     * 清空磁盘上的闹钟记录（不动 AlarmManager，由 [cancelAll] 负责）。
     *
     * @param context 任意 Context
     */
    fun clear(context: Context) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_ALARMS)
            .apply()
    }

    /**
     * 是否具备精确闹钟能力。
     *
     * Android 12（S）起 `setExact` 需要 `SCHEDULE_EXACT_ALARM` 或 `USE_EXACT_ALARM`，
     * 否则会抛 SecurityException；这里先问系统，避免异常路径。
     *
     * @param alarmManager 系统 AlarmManager
     */
    fun canScheduleExact(alarmManager: AlarmManager): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            alarmManager.canScheduleExactAlarms()
        } else {
            true
        }
    }

    /**
     * 全量重排闹钟：先取消旧的，再逐条精确排程，最后把新列表落盘。
     *
     * 注意顺序：**先落盘再排程**会让「排到一半崩溃」留下没排上的记录，
     * 「先排程再落盘」最多丢掉下一次重建的依据，所以这里选择
     * 「先取消旧闹钟 → 落盘新列表 → 逐条排程」，即使中途异常，
     * 磁盘记录与已排闹钟也是「新列表的子集」，重建时不会漏排。
     *
     * @param context 任意 Context
     * @param alarms 前端编译出的完整闹钟列表
     */
    fun scheduleAll(context: Context, alarms: List<AlarmRecord>) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
        if (alarmManager == null) {
            Log.e(TAG, "拿不到 AlarmManager，无法排程")
            return
        }

        // 1. 取消此前排过的所有闹钟（依据磁盘记录，而不是最新列表）
        cancelAll(context)

        // 2. 已过去的时刻不再排（前端已过滤过，这里再兜一层，避免系统时钟漂移）
        val now = System.currentTimeMillis()
        val future = alarms.filter { it.fireAt > now }

        // 3. 落盘：这是重启后重建的唯一依据
        save(context, future)

        // 4. 逐条精确排程
        for (record in future) {
            val pendingIntent = buildPendingIntent(context, record)
            try {
                if (canScheduleExact(alarmManager)) {
                    alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, record.fireAt, pendingIntent)
                } else {
                    // 未授予精确闹钟权限时的降级路径：仍然会在待机白名单窗口触发，但可能延迟
                    Log.w(TAG, "未获得精确闹钟权限，降级为 setAndAllowWhileIdle")
                    alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, record.fireAt, pendingIntent)
                }
            } catch (error: SecurityException) {
                Log.e(TAG, "排程被系统拒绝（精确闹钟权限），降级处理 id=${record.id}", error)
                try {
                    alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, record.fireAt, pendingIntent)
                } catch (fallbackError: Exception) {
                    Log.e(TAG, "降级排程仍失败 id=${record.id}", fallbackError)
                }
            }
        }
        Log.i(TAG, "已排程 ${future.size} 条闹钟")
    }

    /**
     * 取消所有已排闹钟并清空磁盘记录。
     *
     * @param context 任意 Context
     */
    fun cancelAll(context: Context) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
        for (record in load(context)) {
            val pendingIntent = buildPendingIntent(context, record)
            try {
                alarmManager?.cancel(pendingIntent)
            } catch (error: Exception) {
                Log.e(TAG, "取消失败 id=${record.id}", error)
            }
            pendingIntent.cancel()
        }
        clear(context)
    }

    /**
     * 构造某条闹钟对应的 PendingIntent。
     *
     * 唯一性来自三处：action 拼了 id、data 是 `zuoleme://alarm/<id>`、requestCode = id。
     * 三者只要有一处不同，系统就会认为是不同的 PendingIntent，从而不会互相覆盖。
     *
     * @param context 任意 Context
     * @param record 闹钟记录
     */
    fun buildPendingIntent(context: Context, record: AlarmRecord): PendingIntent {
        val intent = Intent(context, AlarmReceiver::class.java).apply {
            action = "$ACTION_FIRE_PREFIX.${record.id}"
            data = Uri.parse("zuoleme://alarm/${record.id}")
            putExtra(EXTRA_ID, record.id)
            putExtra(EXTRA_TITLE, record.title)
            putExtra(EXTRA_BODY, record.body)
        }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        return PendingIntent.getBroadcast(context, record.id, intent, flags)
    }
}
