# 做了么

> 输入待办和截止时间，应用在 **截止前 7 天 / 3 天 / 1 天 / 3 小时 / 1 小时** 以及 **到点** 各提醒一次；
> 每件事单独弹出一条通知；最近一件事在应用顶部**常驻**显示倒计时。

**纯本地 Android APK**（Capacitor 6 + Android 系统闹钟），侧载安装，不上架应用商店。

- 数据只存在手机本地（`localStorage`，键名 `zuoleme.todos.v1`），**不联网**、无账号、无服务器；
- 提醒由 Android `AlarmManager` 的精确闹钟触发：**断网、息屏、关机重启后**都会照常响；
- 不依赖 Web Push，也就不存在 `*.workers.dev` 在国内被 DNS 污染的问题。

---

## 功能

| 能力 | 说明 |
|---|---|
| 新建待办 | 标题 + 截止时间（`datetime-local`，带 30 分钟 / 1 小时 / 3 小时 / 明天 9 点快捷选项） |
| 六档提醒 | 截止前 7 天、3 天、1 天、3 小时、1 小时、到点，共 6 条独立通知；**已过去的档位不补发** |
| 每件事单独通知 | 每条闹钟有独立整型 id = `hash(todoId + kind)`，同时作为通知 id 与 PendingIntent requestCode，互不覆盖 |
| 常驻卡片 | 顶部固定显示最近一件未完成的事 + 剩余时间倒计时（`3天2小时` / `45分钟` / `已逾期`）+ 下次提醒倒计时 |
| 重启后照常提醒 | 闹钟列表持久化在 `SharedPreferences`，`BootReceiver` 在 `BOOT_COMPLETED` / `MY_PACKAGE_REPLACED` 时重建 |
| 断网可用 | 全部数据在本地，无需网络即可新建、查看、提醒 |
| 运行检查 | 逐项显示「通知权限 / 精确闹钟 / 电池优化」状态，并一键跳转对应系统设置页 |
| 完成 / 删除 | 任何数据变化后**全量重排**闹钟，删除待办即取消其全部提醒 |

---

## 技术架构

```
Android APK（Capacitor 6，完全离线）
├── WebView：React 18 + TypeScript + Tailwind 3（Vite 构建，产物 dist/）
│   ├── lib/api.ts             → localStorage 仓储层（zuoleme.todos.v1）
│   ├── lib/alarms.ts          → 待办 → 扁平闹钟列表（纯函数，可单测）
│   └── lib/reminder-bridge.ts → 调原生 ReminderAlarm 插件（Web 上自动降级为空操作）
└── 原生层（Kotlin）
    ├── ReminderAlarmPlugin.kt → JS 桥：scheduleAll / cancelAll / 权限三连
    ├── ReminderStore.kt       → SharedPreferences 持久化 + AlarmManager 排程
    ├── ReminderNotifier.kt    → 通知渠道（reminders，IMPORTANCE_HIGH）+ 发通知
    ├── AlarmReceiver.kt       → 到点广播 → 发一条独立通知
    └── BootReceiver.kt        → 开机 / 升级后重建全部闹钟
```

- 六档提醒的时间语义复用 `shared/reminders.ts` 的 `planReminders(deadline, now)`（未重写，行为与旧版一致）；
- 本地方案不持久化「提醒是否已发」：闹钟交给系统后由系统保证触发，`fireAt <= now` 的档位在编译阶段就被丢弃；
- `worker/` 目录（原 Cloudflare Worker + D1 + Web Push）**保留但不再被引用**，仅作为将来做同步的参考实现。

## 目录结构

```
shared/
  types.ts          # 待办模型（本地唯一真相）
  reminders.ts      # 六档提醒纯函数 planReminders / reminderBody
  format.ts         # 倒计时 / 截止时间格式化纯函数
src/
  main.tsx  App.tsx  index.css
  components/       # PinnedCard 常驻卡片 / TodoList / AddTodoPanel / HealthPanel
  lib/              # api(localStorage) / alarms / reminder-bridge / useNow / sw 辅助
  sw.ts             # 仅网页版使用；APK 内不注册 Service Worker
android/            # Capacitor 生成的 Android 工程 + 自研闹钟插件（Kotlin）
tests/              # Vitest：提醒规则、闹钟编译、格式化、Web Push 加解密（worker 保留测试）
worker/             # 已停用：原 Cloudflare Worker（APK 版本不使用该目录）
```

---

## 本地开发

```bash
npm install
npm run dev            # 浏览器里调试界面（此环境无系统闹钟，运行检查会提示「仅 APK 可用」）
npm run typecheck      # 前端 + Service Worker + Worker 三份 tsconfig
npm run build          # 类型检查 + vite build（产物 dist/）
npm test               # Vitest（119 个用例）
```

## 构建 APK

前置：JDK 17、Android SDK（`platforms/android-35`、`build-tools/35.0.0`）。

```bash
export ANDROID_HOME=/c/Android/sdk
export ANDROID_SDK_ROOT=/c/Android/sdk

npm run build                 # 1. 构建 Web 产物到 dist/
npx cap sync android          # 2. 把 dist 拷进 android/app/src/main/assets/public
cd android
./gradlew assembleDebug --no-daemon
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`

> `android/gradle.properties` 里没有代理配置；如需代理下载依赖，请写到**用户目录**的
> `~/.gradle/gradle.properties`（`systemProp.https.proxyHost/Port`），仓库里不保存任何本机路径。
> Gradle 版本由 `android/gradle/wrapper/` 决定（8.2.1），无需预装 Gradle。

## 安装到手机（侧载）

1. 把 `app-debug.apk` 传到手机（数据线 / 微信文件传输助手 / 网盘均可）；
2. 文件管理器里点开 APK → 允许「安装未知应用」→ 安装；
3. 打开「做了么」，按应用内 **运行检查** 面板逐项授权（见下节）。

### 首次使用必须在手机上打开的开关

| 位置 | 操作 | 不开的后果 |
|---|---|---|
| 应用内「运行检查 → 通知权限 → 去授权」 | 允许通知 | 闹钟照常触发，但**屏幕上什么都看不到** |
| 应用内「运行检查 → 精确闹钟 → 去开启」 | 允许「闹钟和提醒」 | 提醒会被推迟到系统省电窗口，可能晚十几分钟 |
| 应用内「运行检查 → 电池优化 → 去设置」 | 找到「做了么」→ 不限制 / 不优化 | 长时间不打开应用后，息屏时可能不响 |
| 系统设置 → 应用管理 → 做了么 → **自启动**（realme/OPPO/vivo/小米 有此项） | 打开 | 清理后台 / 重启后不再重建闹钟 |
| 系统设置 → 电池 → 应用耗电管理 → 做了么 | 允许后台活动 / 不限制 | 同上 |

> realme / OPPO 的路径大约在：设置 → 应用管理 → 做了么 → 耗电管理 → 「允许后台运行」+「允许自启动」。

---

## 已知限制与取舍

1. **不做云端同步**：数据只在这台手机上，卸载应用 = 数据丢失（`allowBackup=true` 时系统备份可能带回）。
2. **精确闹钟降级路径**：若用户拒绝「精确闹钟」权限，代码会降级为 `setAndAllowWhileIdle`
   （仍会响，但可能延迟）。这是刻意的降级而不是失败——宁可晚响也不要静默不响。
3. **未持久化「已触发」状态**：闹钟交给系统后应用被杀也不影响触发；但**同一条提醒不会补发**，
   如果手机在触发时刻处于关机状态，该档位会直接跳过（与「已过去的档位不补发」的产品语义一致）。
4. **国产 ROM 的后台管控无法从应用内绕过**：只能靠用户在系统设置里白名单，运行检查面板已给出提示。
5. **`INTERNET` 权限保留**：Capacitor 的 WebView 加载本地资源需要它，应用代码不做任何网络请求。
6. **未做**：分类、优先级、搜索、统计、深色模式切换、iOS。

## 安全说明

- 无网络请求、无账号、无 token；待办数据只写在应用私有目录的 WebView `localStorage` 里。
- `worker/` 目录里的密钥说明仍然有效（`wrangler secret put`，`.dev.vars` 不进仓库），
  但 APK 版本不会读取任何密钥。
