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
 * @property legacyBody 旧格式（v1）里已经算好的正文；只在本机内部透传，**不跨 JS 桥**
 */
data class AlarmRecord(
    val id: Int,
    val todoId: String,
    val title: String,
    val deadline: Long,
    val fireAt: Long,
    val legacyBody: String? = null
)

/**
 * 常驻通知要显示的那一件事。
 *
 * **为什么由 JS 算好再传进来**：原生侧只有闹钟列表（[AlarmRecord]），它不知道哪条是
 * 重复任务、哪条已经完成、哪条只是没设时间 —— 这些是业务规则，全在 JS 里
 * （`src/lib/ongoing.ts` 的 `pickOngoingItem`）。原生只负责显示，不复制一份规则，
 * 否则两边迟早不一致（比如「重复任务不算最近一件」这条改了一边忘了另一边）。
 *
 * @property todoId 待办 id（点通知时用它打开对应编辑页）
 * @property title 通知标题（= 待办标题）
 * @property deadline 截止时刻（epoch 毫秒），通知正文由它现算
 */
data class OngoingItem(
    val todoId: String,
    val title: String,
    val deadline: Long
)

/**
 * 一次读盘的结果：记录本身 + 被丢弃的条数。
 *
 * `dropped` 是给界面用的可观测信号：不为 0 说明磁盘上的记录格式和当前解析器对不上，
 * 用户应该被明确告知「有提醒没能恢复」，而不是等他某天发现「提醒没响」。
 *
 * @property records 成功解析出的提醒
 * @property dropped 解析失败被丢弃的条数（正常为 0）
 */
data class LoadResult(
    val records: List<AlarmRecord>,
    val dropped: Int
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

    /**
     * 标题缺失时的兜底文案。
     *
     * 这里必须自己声明一份（不能引用 `AlarmReceiver.DEFAULT_TITLE`）：
     * 那两处是各自的 `companion object` 常量，从 `ReminderStore` 里引用会变成
     * 「先初始化对方类」的隐式依赖，而解析路径是开机广播里最先跑的代码。
     */
    private const val DEFAULT_TITLE = "做了么"

    /** 「用户点了哪条通知」的键（MainActivity 写，插件读一次即清空） */
    private const val KEY_PENDING_OPEN = "pending_open_todo"

    /**
     * 常驻通知内容的键。
     *
     * 刻意与提醒数组分开存：提醒是「派生数据」，可以整体丢弃重建；
     * 常驻卡要在服务被系统重启（空 Intent）时重建，必须独立可读。
     */
    private const val KEY_ONGOING_ITEM = "ongoing_item"

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
     * **宽容解析**：这条路径是「覆盖安装之后唯一的救生索」。
     * 旧版本（v1 格式）根本没写 `alarms_version` 键（读到的是 0），而包替换时
     * 系统会把已排的 AlarmManager 闹钟全部清掉，接着 `BootReceiver` 被
     * `MY_PACKAGE_REPLACED` 叫醒 → 调这里 → 如果这时返回空列表，
     * 用户不主动打开应用就**一条提醒都不会响**，而且一行日志都没有。
     *
     * 所以：
     * - `version` 缺失或 `< FORMAT_VERSION`（旧格式）→ 照常读出，逐条按旧形状兜底；
     * - `version > FORMAT_VERSION`（未来格式，本版本不认识）→ 才返回空；
     * - 单条解析失败只丢那一条，绝不让整张表一起消失。
     *
     * @param context 任意 Context
     */
    fun load(context: Context): List<AlarmRecord> = loadWithStats(context).records

    /**
     * 同 [load]，但额外回报「丢弃了多少条」，供界面显示可观测信号。
     *
     * 为什么要这个数字：这条路径没法在 CI 里跑真实 Kotlin，
     * 一旦将来又把格式改坏、解析静默失效，用户只会「觉得提醒没响」。
     * 所以必须在应用里能直接看到「有 N 条旧提醒没能恢复」。
     *
     * @param context 任意 Context
     */
    fun loadWithStats(context: Context): LoadResult {
        val store = prefs(context)
        val version = store.getInt(KEY_VERSION, 0)
        if (version > FORMAT_VERSION) {
            Log.e(TAG, "存盘格式版本 $version 高于本版本 $FORMAT_VERSION，本次无法解析（提醒会缺失）")
            return LoadResult(emptyList(), 0)
        }
        if (version in 1 until FORMAT_VERSION) {
            Log.i(TAG, "读到旧格式提醒记录（v$version），按宽容模式解析")
        }

        val raw = store.getString(KEY_ALARMS, null) ?: return LoadResult(emptyList(), 0)
        if (raw.isEmpty()) {
            return LoadResult(emptyList(), 0)
        }

        return try {
            val array = JSONArray(raw)
            val records = ArrayList<AlarmRecord>(array.length())
            var dropped = 0
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index)
                val record = if (item == null) null else parseRecord(item)
                if (record == null) {
                    dropped += 1
                    continue
                }
                records.add(record)
            }
            if (records.isEmpty() && dropped > 0) {
                // 「有数据但一条都没解析出来」= 格式又一次变了，必须留下 ERROR 级日志
                Log.e(TAG, "存盘里有 $dropped 条提醒记录，但一条都没能解析（格式可能已变）")
            }
            LoadResult(records, dropped)
        } catch (error: Exception) {
            Log.e(TAG, "读取本地提醒记录失败，按空列表处理", error)
            LoadResult(emptyList(), 0)
        }
    }

    /**
     * 解析单条提醒记录（同时兼容 v2 与旧格式）。
     *
     * v2 形状：`{id, todoId, title, deadline, fireAt}`。
     * 旧格式：`{id, title, body, fireAt}` —— 有 `body`，没有 `todoId` / `deadline`。
     * 旧记录的 `body` 是当时算好的文案（「还有 1 小时截止」这类），
     * 虽然不如现算精确，但比一条都不响好得多，所以原样带进 [AlarmRecord.legacyBody]。
     *
     * **这里刻意不分「v2 分支 / 旧格式分支」，五个键全部无条件尝试读取。**
     * 原因是一条旧记录被 [save] 之后，磁盘上是「v2 形状 + 多一个 body 键」
     * （`todoId` / `deadline` 都写了，`body` 也写了）——正是 save/load 的对称性。
     * 如果将来有人把这里拆成两个分支，并且只让「旧格式分支」读 `body`，
     * 那条记录下次就会被判成 v2、`legacyBody` 丢掉，正文退回现算口径；
     * 而它的 `deadline` 是 0，于是弹出「已逾期 56 年」。
     * 所以「两个分支都要读 body」不是防御性编程，是**存盘必须能被自己读回来**的硬要求。
     *
     * @param item 单条 JSON
     * @return 解析结果；非法条目返回 null（宁可少一条，也不要在系统里排错误时间）
     */
    private fun parseRecord(item: JSONObject): AlarmRecord? {
        val id = item.optInt("id", 0)
        val fireAt = item.optLong("fireAt", 0L)
        if (id <= 0 || fireAt <= 0L) {
            return null
        }
        val title = item.optString("title", "").ifEmpty { DEFAULT_TITLE }
        val todoId = item.optString("todoId", "")
        // v2 记录才有 deadline；旧格式没有，保持 0 表示「不知道」
        val deadline = item.optLong("deadline", 0L)
        // 旧格式的已算好正文。**与版本无关地读**：save() 会把 legacyBody 写回 body，
        // 所以「已经救回来的旧记录」在磁盘上是 v2 形状 + body 键，必须还能读回来。
        val body = item.optString("body", "").ifEmpty { null }

        return AlarmRecord(
            id = id,
            todoId = todoId,
            title = title,
            deadline = deadline,
            fireAt = fireAt,
            legacyBody = body
        )
    }

    /**
     * 覆盖写入提醒列表（连同格式版本号）。
     *
     * 永远写 v2 形状；旧格式记录里那句「已算好的正文」（[AlarmRecord.legacyBody]）
     * 也一并透传，否则下次开机它就丢了，通知又变回现算口径。
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
            // 只有从旧格式救回来的记录才有这一步；新记录不写这个键
            alarm.legacyBody?.let { item.put("body", it) }
            array.put(item)
        }
        prefs(context).edit()
            .putInt(KEY_VERSION, FORMAT_VERSION)
            .putString(KEY_ALARMS, array.toString())
            .apply()
    }

    /**
     * 取某条提醒在旧格式里保存的、已经算好的正文。
     *
     * 只有 [AlarmReceiver] 在收到「deadline 为 0」的旧记录时才会调用；
     * 正常（v2）记录不会走这条路径，所以不影响常规触发的性能。
     *
     * @param context 任意 Context
     * @param alarmId 提醒 id
     * @return 旧正文；没有则为 null
     */
    fun findLegacyBody(context: Context, alarmId: Int): String? {
        return try {
            load(context).firstOrNull { it.id == alarmId }?.legacyBody
        } catch (error: Exception) {
            Log.w(TAG, "读取旧格式正文失败 id=$alarmId", error)
            null
        }
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
     * 保存常驻通知要显示的那一件事（null = 没有要显示的，清空）。
     *
     * 落盘的原因：`START_STICKY` 的服务被系统杀掉后会用**空的 Intent** 重启，
     * 那时拿不到任何参数，只能靠磁盘上的这份记录重建通知 —— 否则常驻卡会变成
     * 「空白通知」或者干脆消失。
     *
     * @param context 任意 Context
     * @param item 要显示的一件事，null 清除
     */
    fun saveOngoing(context: Context, item: OngoingItem?) {
        val editor = prefs(context).edit()
        if (item == null) {
            editor.remove(KEY_ONGOING_ITEM)
        } else {
            val json = JSONObject()
            json.put("todoId", item.todoId)
            json.put("title", item.title)
            json.put("deadline", item.deadline)
            editor.putString(KEY_ONGOING_ITEM, json.toString())
        }
        editor.apply()
    }

    /**
     * 读取常驻通知要显示的那一件事。
     *
     * 宽容解析：任何字段不合法都当作「没有」，宁可少一条常驻卡也不要显示一条错的。
     *
     * @param context 任意 Context
     */
    fun loadOngoing(context: Context): OngoingItem? {
        val raw = prefs(context).getString(KEY_ONGOING_ITEM, null) ?: return null
        if (raw.isEmpty()) {
            return null
        }
        return try {
            val json = JSONObject(raw)
            val todoId = json.optString("todoId", "")
            val title = json.optString("title", "").ifEmpty { DEFAULT_TITLE }
            val deadline = json.optLong("deadline", 0L)
            if (deadline <= 0L) {
                null
            } else {
                OngoingItem(todoId = todoId, title = title, deadline = deadline)
            }
        } catch (error: Exception) {
            Log.w(TAG, "读取常驻通知内容失败，按「没有」处理", error)
            null
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
