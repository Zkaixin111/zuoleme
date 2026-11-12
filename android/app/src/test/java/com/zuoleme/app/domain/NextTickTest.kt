package com.zuoleme.app.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 下一分钟边界计算测试：常驻通知改为闹钟每分钟唤醒重贴，
 * 触发点必须落在整分钟上，且永远在当前时间之后。
 */
class NextTickTest {
    @Test
    fun `返回严格大于当前时间的下一个整分钟`() {
        val now = 1_700_000_123_456L // 任意非整分钟时刻
        val next = NextTick.nextMinuteBoundary(now)

        assertTrue(next > now)
        assertEquals(0L, next % 60_000L)
        assertTrue(next - now <= 60_000L)
    }

    @Test
    fun `恰好整分钟时返回下一分钟`() {
        val now = 1_700_000_160_000L // 整分钟
        assertEquals(now + 60_000L, NextTick.nextMinuteBoundary(now))
    }
}
