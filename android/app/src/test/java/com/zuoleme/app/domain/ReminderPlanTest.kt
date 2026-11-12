package com.zuoleme.app.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 六档提醒纯逻辑测试，规则与网页版 shared/reminders.ts 保持一致：
 * 只生成严格晚于当前时间的档位，已过去的档位不补发。
 */
class ReminderPlanTest {
    private val now = 1_700_000_000_000L
    private val dayMs = 86_400_000L
    private val hourMs = 3_600_000L

    @Test
    fun `10 天后截止生成全部六档且按时间升序`() {
        val plans = ReminderPlan.plan(deadline = now + 10 * dayMs, now = now)

        assertEquals(
            listOf(ReminderKind.D7, ReminderKind.D3, ReminderKind.D1, ReminderKind.H3, ReminderKind.H1, ReminderKind.DUE),
            plans.map { it.kind },
        )
        assertEquals(plans.map { it.fireAt }.sorted(), plans.map { it.fireAt })
        assertEquals(now + 10 * dayMs, plans.last().fireAt)
    }

    @Test
    fun `2 小时后截止只剩 1 小时和到点两档`() {
        val plans = ReminderPlan.plan(deadline = now + 2 * hourMs, now = now)

        assertEquals(listOf(ReminderKind.H1, ReminderKind.DUE), plans.map { it.kind })
    }

    @Test
    fun `档位时间恰好等于当前时间时丢弃不补发`() {
        // 截止 = 1 小时后：1h 档的 fireAt 恰好 == now，必须丢弃
        val plans = ReminderPlan.plan(deadline = now + hourMs, now = now)

        assertEquals(listOf(ReminderKind.DUE), plans.map { it.kind })
    }

    @Test
    fun `截止时间已过时不生成任何档位`() {
        assertTrue(ReminderPlan.plan(deadline = now - 1, now = now).isEmpty())
    }

    @Test
    fun `每档文案正确`() {
        assertEquals("还有 7 天截止", ReminderPlan.body(ReminderKind.D7))
        assertEquals("还有 1 小时截止", ReminderPlan.body(ReminderKind.H1))
        assertEquals("已到截止时间", ReminderPlan.body(ReminderKind.DUE))
    }
}
