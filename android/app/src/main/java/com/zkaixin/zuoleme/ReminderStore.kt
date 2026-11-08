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
 * 与前端 `src/lib/alarms.ts` 里的 `ReminderAlarm` 一一对应（Kotlin 侧只保留四个字段）。
 * id 由前端用 `hash(todoId + kind)` 算出，保证「每件事、每一档」都有独立 id，
 * 因此两条提醒不会互相覆盖；但**原生侧无法反查**它属于哪条待办的哪一档 ——
 * 要反查必须拿 id 回前端与 `alarmId(todoId, kind)` 比对，或者看通知标题里的待办名。
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
     * 全量重排闹钟。
     *
     * 严格的执行顺序（每一步的顺序都是被 bug 教训过的）：
     * 1. **先读旧列表**：要取消哪些 PendingIntent 只能依据上一次落盘的记录；
     * 2. 过滤掉已过去的时刻（前端已过滤过，这里再兜一层，避免系统时钟漂移）；
     * 3. **先落盘新列表**：磁盘记录是重启后重建的**唯一**依据，
     *    它必须在「取消旧闹钟」之前就变成新列表 —— 否则「清盘」与「写盘」之间进程被杀，
     *    磁盘会停留在空列表，重启后 `BootReceiver` 读到空 → 所有提醒静默失效；
     * 4. 再取消上一次排的 PendingIntent（只取消，不碰磁盘）；
     * 5. 最后逐条精确排程。
     *
     * 这样任何一步崩溃，磁盘里要么是旧列表、要么是新列表，**永远不会是空**，
     * 最坏情况只是多响一条已经过期的旧闹钟，不会整批丢失。
     *
     * @param context 任意 Context
     * @param alarms 前端编译出的完整闹钟列表
     * @return 真正交给系统的闹钟条数（已过滤过去时刻、已扣除排程失败）
     */
    fun scheduleAll(context: Context, alarms: List<AlarmRecord>): Int {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
        if (alarmManager == null) {
            Log.e(TAG, "拿不到 AlarmManager，无法排程")
            return 0
        }

        // 1. 上一次排过的闹钟（取消时要用它，而不是新列表）
        val previous = load(context)

        // 2. 已过去的时刻不再排
        val now = System.currentTimeMillis()
        val future = alarms.filter { it.fireAt > now }

        // 3. 先落盘：重启后重建的唯一依据，必须在取消旧闹钟之前完成
        save(context, future)

        // 4. 只取消旧 PendingIntent（不清盘）
        cancelPendingIntents(context, alarmManager, previous)

        // 5. 逐条精确排程
        var scheduled = 0
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
                scheduled += 1
            } catch (error: SecurityException) {
                Log.e(TAG, "排程被系统拒绝（精确闹钟权限），降级处理 id=${record.id}", error)
                try {
                    alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, record.fireAt, pendingIntent)
                    scheduled += 1
                } catch (fallbackError: Exception) {
                    Log.e(TAG, "降级排程仍失败 id=${record.id}", fallbackError)
                }
            }
        }
        Log.i(TAG, "已排程 $scheduled/${future.size} 条闹钟")
        return scheduled
    }

    /**
     * 取消所有已排闹钟并清空磁盘记录（插件对外方法，行为不变）。
     *
     * 与 [scheduleAll] 的区别：这里**要**清盘。因为用户清空数据后如果磁盘还留着旧记录，
     * 下次开机 `BootReceiver` 会把已经取消的提醒重新排回来。
     *
     * @param context 任意 Context
     */
    fun cancelAll(context: Context) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
        cancelPendingIntents(context, alarmManager, load(context))
        clear(context)
    }

    /**
     * 取消一批闹钟对应的 PendingIntent（**不碰磁盘记录**）。
     *
     * 单独抽出来是必须的：如果让 [scheduleAll] 复用 [cancelAll]，就会在「清盘 → 写盘」
     * 之间出现一个全局丢失窗口（见 [scheduleAll] 注释）。
     *
     * @param context 任意 Context
     * @param alarmManager 系统 AlarmManager，可为 null（此时只取消 PendingIntent）
     * @param records 要取消的闹钟记录
     */
    private fun cancelPendingIntents(
        context: Context,
        alarmManager: AlarmManager?,
        records: List<AlarmRecord>
    ) {
        for (record in records) {
            val pendingIntent = buildPendingIntent(context, record)
            try {
                alarmManager?.cancel(pendingIntent)
            } catch (error: Exception) {
                Log.e(TAG, "取消失败 id=${record.id}", error)
            }
            pendingIntent.cancel()
        }
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
