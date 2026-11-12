package com.zuoleme.app

import android.app.Application
import com.zuoleme.app.notify.Notifier

class ZuolemeApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifier.ensureChannels(this)
        // 进程每次被拉起都把底层自检链续上（分钟重贴 + 周期自检）；
        // 常驻通知的持续存在不再单依赖前台服务进程是否存活。
        com.zuoleme.app.reminder.ServiceRestarter.scheduleNextTick(this)
        com.zuoleme.app.reminder.ServiceRestarter.enqueuePeriodicCheck(this)
    }
}
