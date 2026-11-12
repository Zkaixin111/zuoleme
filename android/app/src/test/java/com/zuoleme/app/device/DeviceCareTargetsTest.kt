package com.zuoleme.app.device

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 真我 / ColorOS 保活跳转目标测试。
 * 真我 Neo6 SE（realme UI，基于 ColorOS）的自启动页没有公开接口，
 * 只能按已知的系统组件名依次尝试，这里保证关键组件名不被误删。
 */
class DeviceCareTargetsTest {
    @Test
    fun `自启动候选包含 ColorOS 安全中心主流组件`() {
        val targets = DeviceCare.autoStartTargets.map { "${it.packageName}/${it.className}" }

        assertTrue(targets.contains("com.coloros.safecenter/com.coloros.safecenter.permission.startup.StartupAppListActivity"))
        assertTrue(targets.contains("com.coloros.safecenter/com.coloros.safecenter.startupapp.StartupAppListActivity"))
        assertTrue(targets.contains("com.oppo.safe/com.oppo.safe.permission.startup.StartupAppListActivity"))
    }

    @Test
    fun `自启动候选包含新版 OPlus 与 realme 组件`() {
        val targets = DeviceCare.autoStartTargets.map { it.packageName }

        assertTrue(targets.contains("com.oplus.safe"))
        assertTrue(targets.contains("com.realme.security"))
    }

    @Test
    fun `realme 与 OPPO 一加识别为 ColorOS 系`() {
        assertTrue(DeviceCare.isColorOsLike("realme", "realme"))
        assertTrue(DeviceCare.isColorOsLike("OPPO", "OPPO"))
        assertTrue(DeviceCare.isColorOsLike("OnePlus", "OnePlus"))
        assertFalse(DeviceCare.isColorOsLike("Xiaomi", "Redmi"))
        assertFalse(DeviceCare.isColorOsLike("HUAWEI", "HONOR"))
    }
}
