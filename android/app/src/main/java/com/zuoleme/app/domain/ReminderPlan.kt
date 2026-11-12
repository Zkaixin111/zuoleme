package com.zuoleme.app.domain

/** 六档提醒类型，命名与网页版 shared/types.ts 保持一致。 */
enum class ReminderKind(val storageKey: String, val offsetMs: Long, val label: String) {
    D7("7d", 7 * 86_400_000L, "7 天"),
    D3("3d", 3 * 86_400_000L, "3 天"),
    D1("1d", 86_400_000L, "1 天"),
    H3("3h", 3 * 3_600_000L, "3 小时"),
    H1("1h", 3_600_000L, "1 小时"),
    DUE("due", 0L, "到点"),
    ;

    companion object {
        fun fromStorageKey(key: String?): ReminderKind = entries.firstOrNull { it.storageKey == key } ?: DUE
    }
}

/** 一档待触发提醒计划。 */
data class ReminderPlanItem(val kind: ReminderKind, val fireAt: Long)

/**
 * 六档提醒纯逻辑（从网页版 shared/reminders.ts 移植，规则完全一致）：
 * 只生成 fireAt 严格大于当前时间的档位，已过去的档位不补发。
 */
object ReminderPlan {
    fun plan(deadline: Long, now: Long): List<ReminderPlanItem> =
        ReminderKind.entries
            .map { kind -> ReminderPlanItem(kind, deadline - kind.offsetMs) }
            .filter { it.fireAt > now }
            .sortedBy { it.fireAt }

    /** 某档位的通知正文。 */
    fun body(kind: ReminderKind): String =
        if (kind == ReminderKind.DUE) "已到截止时间" else "还有 ${kind.label}截止"
}

/** 倒计时文案，口径与网页版 shared/format.ts 一致。 */
object RemainingText {
    fun format(remainingMs: Long): String {
        if (remainingMs <= 0) return "已逾期"
        val totalMinutes = remainingMs / 60_000L
        if (totalMinutes < 1) return "不到1分钟"
        val days = totalMinutes / (24 * 60)
        val hours = (totalMinutes % (24 * 60)) / 60
        val minutes = totalMinutes % 60
        return when {
            days > 0 -> if (hours > 0) "${days}天${hours}小时" else "${days}天"
            hours > 0 -> if (minutes > 0) "${hours}小时${minutes}分钟" else "${hours}小时"
            else -> "${minutes}分钟"
        }
    }
}
