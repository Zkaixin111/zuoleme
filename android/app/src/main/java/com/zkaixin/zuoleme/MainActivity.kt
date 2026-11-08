package com.zkaixin.zuoleme

import android.os.Bundle
import com.getcapacitor.BridgeActivity

/**
 * 应用唯一的 Activity：承载 Capacitor WebView。
 *
 * 两件必须在这里做的事：
 * 1. `registerPlugin` 必须在 `super.onCreate` **之前**调用，否则 Capacitor 建 Bridge 时
 *    还看不到我们的插件，JS 侧 `registerPlugin('ReminderAlarm')` 就会拿到空实现；
 * 2. 创建通知渠道（Android 8+ 没有渠道的通知会被系统直接丢弃）。
 */
class MainActivity : BridgeActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(ReminderAlarmPlugin::class.java)
        super.onCreate(savedInstanceState)
        ReminderNotifier.ensureChannel(this)
    }
}
