package com.zkaixin.zuoleme

import android.content.Intent
import android.os.Bundle
import com.getcapacitor.BridgeActivity

/**
 * 应用唯一的 Activity：承载 Capacitor WebView。
 *
 * 三件必须在这里做的事：
 * 1. `registerPlugin` 必须在 `super.onCreate` **之前**调用，否则 Capacitor 建 Bridge 时
 *    还看不到我们的插件，JS 侧 `registerPlugin('ReminderAlarm')` 就会拿到空实现；
 * 2. 创建通知渠道（Android 8+ 没有渠道的通知会被系统丢弃）；
 * 3. 用户点通知进来时，把待办 id 记下来，供 JS 启动后跳转到详情页。
 */
class MainActivity : BridgeActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(ReminderAlarmPlugin::class.java)
        super.onCreate(savedInstanceState)
        ReminderNotifier.ensureChannel(this)
        captureNotificationOpen(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // singleTask：应用已在后台时点通知走这里，必须把新 Intent 接住
        setIntent(intent)
        captureNotificationOpen(intent)
    }

    /**
     * 把通知里带的待办 id 记进 SharedPreferences，等 JS 起来后取走。
     *
     * 不在这里直接跳转：页面切换由 React 管，原生只负责「留言」。
     *
     * @param intent 启动或唤醒本 Activity 的 Intent
     */
    private fun captureNotificationOpen(intent: Intent?) {
        val todoId = intent?.getStringExtra(ReminderStore.EXTRA_TODO_ID) ?: return
        if (todoId.isEmpty()) {
            return
        }
        ReminderStore.setPendingOpen(this, todoId)
    }
}
