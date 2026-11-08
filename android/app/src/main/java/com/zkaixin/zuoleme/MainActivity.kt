package com.zkaixin.zuoleme

import android.content.Intent
import android.os.Bundle
import com.getcapacitor.BridgeActivity

/**
 * 应用唯一的 Activity：承载 Capacitor WebView。
 *
 * 四件必须在这里做的事：
 * 1. `registerPlugin` 必须在 `super.onCreate` **之前**调用，否则 Capacitor 建 Bridge 时
 *    还看不到我们的插件，JS 侧 `registerPlugin('ReminderAlarm')` 就会拿到空实现；
 * 2. 创建通知渠道（Android 8+ 没有渠道的通知会被系统丢弃）；
 * 3. 用户点通知进来时，把待办 id 记下来，供 JS 启动后跳转到编辑页；
 * 4. 系统返回键 / 侧滑手势：子页面上拦下来交给 JS，首页才真的退出应用。
 */
class MainActivity : BridgeActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(ReminderAlarmPlugin::class.java)
        super.onCreate(savedInstanceState)
        ReminderNotifier.ensureChannel(this)
        captureNotificationOpen(intent)
    }

    /**
     * 返回键 / 侧滑返回手势的统一入口。
     *
     * 为什么必须重写：本项目没有注册 Capacitor 的 `backButton` 监听，WebView 又是单页应用
     * （视图由 React state 管，没有可后退的 history 条目），所以不拦的话系统返回键会
     * **直接销毁 Activity**，用户在编辑页/历史页按返回就等于退出应用。
     *
     * 为什么不用 `webView.evaluateJavascript("history.back()")`：那是异步的（要等 JS 执行
     * 完才知道有没有后退成功），而 `onBackPressed` 必须同步决定「拦还是放」；
     * 这里用一个由 JS 主动上报的深度计数（`setViewDepth`）判断，同步、无竞态。
     *
     * 兜底：Bridge 未就绪或没人接手时一律 `super.onBackPressed()`，
     * 宁可退出应用也不要让用户按返回没反应。
     *
     * **将来若开启 predictive back**（清单里把 `android:enableOnBackInvokedCallback`
     * 设为 true），这个 override 就**不再被调用**了：必须改成
     * `onBackPressedDispatcher.addCallback(...)` 的 `OnBackPressedCallback`，
     * 否则返回会绕过这里的拦截、直接退出应用。当前 targetSdk 35 且未开启该开关，
     * 走的是 legacy 路径，所以保持现状。
     */
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (ReminderAlarmPlugin.currentViewDepth() > 0 && ReminderAlarmPlugin.notifyBackRequested()) {
            return
        }
        super.onBackPressed()
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
