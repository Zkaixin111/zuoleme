package com.zuoleme.app.domain

import org.junit.Assert.assertEquals
import org.junit.Test

/** 倒计时文案测试：与网页版 shared/format.ts 的口径一致。 */
class RemainingTextTest {
    @Test
    fun `已逾期显示已逾期`() {
        assertEquals("已逾期", RemainingText.format(-1))
        assertEquals("已逾期", RemainingText.format(0))
    }

    @Test
    fun `不足一小时显示分钟`() {
        assertEquals("45分钟", RemainingText.format(45 * 60_000L))
    }

    @Test
    fun `不足一天显示小时`() {
        assertEquals("3小时", RemainingText.format(3 * 3_600_000L))
    }

    @Test
    fun `超过一天显示天和小时`() {
        assertEquals("3天2小时", RemainingText.format(3 * 86_400_000L + 2 * 3_600_000L))
    }
}
