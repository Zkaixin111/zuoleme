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
 * 一条待触发的提醒。
 *
 * 与前端 `src/lib/alarms.ts` 的 `ReminderAlarm` 一一对应，只保留原生真正需要的字段：
 * - 没有 `body`：正文在触发时刻用 `deadline - 当前时间` 现算（见 [ReminderNotifier.remainingText]）；
 * - 没有 `content`：待办详细内容只在应用内详情页显示，绝不进通知。
 *
 * @property id 正整数，同时作为通知 id 与 PendingIntent requestCode
 * @property todoId 来源待办 id，点通知后用它打开详情页
 * @property title 通知标题（= 待办标题）
 * @property deadline 该实例的截止时刻
 * @property fireAt 触发时刻（epoch 毫秒）
 */
data class AlarmRecord(
    val id: Int,
    val todoId: String,
    val title: String,
    val deadline: Long,
    val fireAt: Long
)

/**
 * 提醒的持久化与排程中心（`SharedPreferences` + `AlarmManager`）。
 *
 * 为什么要持久化：`AlarmManager` 里的闹钟在设备重启后会**全部丢失**，
 * 而「重启后照常提醒」是硬需求。所以每次排程都要把列表写到磁盘，
 * 由 `BootReceiver` 在开机广播里读回来重排。
 *
 * 存盘格式带版本号：格式变化时旧数据直接丢弃（提醒是**派生数据**，
 * 丢失不影响用户待办，下次前台会整体重建），而不是冒险解析错位。
 */
object ReminderStore {

    private const val TAG = "ReminderStore"

    /** SharedPreferences 文件名 */
    private const val PREFS_NAME = "zuoleme_alarms"

    /** 提醒数组的键 */
    private const val KEY_ALARMS = "alarms"

    /** 存盘格式版本：v2 起字段变为 id/todoId/title/deadline/fireAt */
    private const val KEY_VERSION = "alarms_version"

    /** 当前存盘格式版本 */
    private const val FORMAT_VERSION = 2

    /** 「用户点了哪条通知」的键（MainActivity 写，插件读一次即清空） */
    private const val KEY_PENDING_OPEN = "pending_open_todo"

    /** 闹钟广播 action 前缀 */
    const val ACTION_FIRE_PREFIX = "com.zkaixin.zuoleme.action.REMINDER_FIRE"

    /** Intent extra：提醒 id */
    const val EXTRA_ID = "alarm_id"

    /** Intent extra：待办 id */
    const val EXTRA_TODO_ID = "alarm_todo_id"

    /** Intent extra：通知标题 */
    const val EXTRA_TITLE = "alarm_title"

    /** Intent extra：该实例的截止时刻 */
    const val EXTRA_DEADLINE = "alarm_deadline"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /**
     * 读取磁盘上的提醒列表。
     *
     * 版本不匹配或解析失败都返回空列表：提醒是派生数据，宁可这次不响也不要崩溃，
     * 用户下次打开应用时前台会重新编译并排程。
     *
     * @param context 任意 Context
     */
    fun load(context: Context): List<AlarmRecord> {
        val store = prefs(context)
        val version = store.getInt(KEY_VERSION, 0)
        if (version != FORMAT_VERSION) {
            if (version != 0) {
                Log.w(TAG, "存盘格式版本 $version != $FORMAT_VERSION，丢弃旧提醒记录")
            }
            return emptyList()
        }

        val raw = store.getString(KEY_ALARMS, null) ?: return emptyList()
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
                // 非法条目直接丢弃：宁可少一条，也不要在 AlarmManager 里排一个错误时间
                if (id <= 0 || fireAt <= 0L) {
                    continue
                }
                records.add(
                    AlarmRecord(
                        id = id,
                        todoId = item.optString("todoId", ""),
                        title = item.optString("title", ""),
                        deadline = item.optLong("deadline", fireAt),
                        fireAt = fireAt
                    )
                )
            }
            records
        } catch (error: Exception) {
            Log.e(TAG, "读取本地提醒记录失败，按空列表处理", error)
            emptyList()
        }
    }

    /**
     * 覆盖写入提醒列表（连同格式版本号）。
     *
     * @param context 任意 Context
     * @param alarms 待保存的提醒
     */
    fun save(context: Context, alarms: List<AlarmRecord>) {
        val array = JSONArray()
        for (alarm in alarms) {
            val item = JSONObject()
            item.put("id", alarm.id)
            item.put("todoId", alarm.todoId)
            item.put("title", alarm.title)
            item.put("deadline", alarm.deadline)
            item.put("fireAt", alarm.fireAt)
            array.put(item)
        }
        prefs(context).edit()
            .putInt(KEY_VERSION, FORMAT_VERSION)
            .putString(KEY_ALARMS, array.toString())
            .apply()
    }

    /**
     * 清空磁盘上的提醒记录（不动 AlarmManager，由 [cancelAll] 负责）。
     *
     * @param context 任意 Context
     */
    fun clear(context: Context) {
        prefs(context).edit()
            .remove(KEY_ALARMS)
            .remove(KEY_VERSION)
            .apply()
    }

    /**
     * 记录「用户点了哪条通知」，供下次 JS 启动时取走。
     *
     * @param context 任意 Context
     * @param todoId 待办 id
     */
    fun setPendingOpen(context: Context, todoId: String) {
        prefs(context).edit().putString(KEY_PENDING_OPEN, todoId).apply()
    }

    /**
     * 取走并清空「待打开的待办」。
     *
     * 读一次就清，避免切回前台时反复跳转同一个详情页。
     *
     * @param context 任意 Context
     */
    fun consumePendingOpen(context: Context): String? {
        val store = prefs(context)
        val todoId = store.getString(KEY_PENDING_OPEN, null)
        if (todoId != null) {
            store.edit().remove(KEY_PENDING_OPEN).apply()
        }
        return if (todoId.isNullOrEmpty()) null else todoId
    }

    /**
     * 是否具备精确闹钟能力。
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
     * 全量重排提醒。
     *
     * 严格的执行顺序（每一步的顺序都是被 bug 教训过的）：
     * 1. **先读旧列表**：要取消哪些 PendingIntent 只能依据上一次落盘的记录；
     * 2. 过滤掉已过去的时刻（前端已过滤过，这里再兜一层，避免系统时钟漂移）；
     * 3. **先落盘新列表**：磁盘记录是重启后重建的**唯一**依据，
     *    它必须在「取消旧提醒」之前就变成新列表 —— 否则「清盘」与「写盘」之间进程被杀，
     *    磁盘会停留在空列表，重启后 `BootReceiver` 读到空 → 所有提醒静默失效；
     * 4. 再取消上一次排的 PendingIntent（只取消，不碰磁盘）；
     * 5. 最后逐条精确排程。
     *
     * @param context 任意 Context
     * @param alarms 前端编译出的完整提醒列表
     * @return 真正交给系统的条数（已过滤过去时刻、已扣除排程失败）
     */
    fun scheduleAll(context: Context, alarms: List<AlarmRecord>): Int {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
        if (alarmManager == null) {
            Log.e(TAG, "拿不到 AlarmManager，无法排程")
            return 0
        }

        // 1. 上一次排过的提醒（取消时要用它，而不是新列表）
        val previous = load(context)

        // 2. 已过去的时刻不再排
        val now = System.currentTimeMillis()
        val future = alarms.filter { it.fireAt > now }

        // 3. 先落盘：重启后重建的唯一依据，必须在取消旧提醒之前完成
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
                    // 未授予精确闹钟权限时的降级路径：仍会触发，但可能延迟
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
        Log.i(TAG, "已排程 $scheduled/${future.size} 条提醒")
        return scheduled
    }

    /**
     * 取消所有已排提醒并清空磁盘记录（插件对外方法，行为不变）。
     *
     * 与 [scheduleAll] 的区别：这里**要**清盘。否则用户清空数据后，
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
     * 取消一批提醒对应的 PendingIntent（**不碰磁盘记录**）。
     *
     * @param context 任意 Context
     * @param alarmManager 系统 AlarmManager，可为 null
     * @param records 要取消的提醒记录
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
     * 构造某条提醒对应的 PendingIntent。
     *
     * 唯一性来自三处：action 拼了 id、data 是 `zuoleme://alarm/<id>`、requestCode = id。
     * 三者只要有一处不同，系统就会认为是不同的 PendingIntent，不会互相覆盖。
     *
     * @param context 任意 Context
     * @param record 提醒记录
     */
    fun buildPendingIntent(context: Context, record: AlarmRecord): PendingIntent {
        val intent = Intent(context, AlarmReceiver::class.java).apply {
            action = "$ACTION_FIRE_PREFIX.${record.id}"
            data = Uri.parse("zuoleme://alarm/${record.id}")
            putExtra(EXTRA_ID, record.id)
            putExtra(EXTRA_TODO_ID, record.todoId)
            putExtra(EXTRA_TITLE, record.title)
            putExtra(EXTRA_DEADLINE, record.deadline)
        }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        return PendingIntent.getBroadcast(context, record.id, intent, flags)
    }
}
