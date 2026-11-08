# 做了么

> 输入**标题**和**具体内容**，选一个截止时间；应用在 **截止前 7 天 / 3 天 / 1 天 / 3 小时 / 1 小时** 以及 **到点** 各静音弹出一条提醒。
> 每件事、每个档位都是独立一条通知，互不覆盖；通知里只显示标题和剩余时间，**具体内容点进去才看**。
> 截止时间**可以不设**（「无期限」），提前提醒**也可以关掉**（只到点提醒一次）；默认仍然是提前提醒。
> 最近一件**带截止时间的**未完成事项在应用顶部**常驻**显示剩余时间，**通知栏也常驻一条**（点进去就是它的编辑页）。
> 已完成的待办移出主页，进「历史任务」页，按完成时间倒序。

**纯本地 Android APK**（Capacitor 6 + Android 系统闹钟），侧载安装，不上架应用商店。

- 数据只存在手机本地（`localStorage`，键名 `zuoleme.todos.v2`，自动兼容旧的 `.v1`），**不联网**、无账号、无服务器；
- 提醒由 Android `AlarmManager` 的精确闹钟触发：**断网、息屏、关机重启后**都会照常触发；
- 不依赖 Web Push，也就不存在 `*.workers.dev` 在国内被 DNS 污染的问题。

---

## 功能

| 能力 | 说明 |
|---|---|
| 新建待办 | **标题**（必填，≤100 字）+ **具体内容**（可空，≤2000 字）+ 截止时间（带 30 分钟 / 1 小时 / 3 小时 / 明天 9 点快捷选项），也可以直接选**「不设时间」** |
| 无期限待办 | 只有标题和内容、没有截止时间：**不产生任何提醒**，单独归到列表最下面的「无期限」分组；周期任务必须有时间锚点，所以无期限时「重复」会被禁用 |
| 提前提醒开关 | 默认**开**（六档按周期收缩）。关掉后这条待办**只在到点那一刻**提醒一次；重复任务的每个实例各提醒一次 |
| 点待办直接编辑 | 列表里只看标题与截止/倒计时；**点整行直接进编辑页**（不再有只读详情页），改完保存即可；点左侧圆圈则直接标记完成 |
| 长按批量删除 | 长按任意一行进入选择模式（顶部「已选 N 项 / 全选 / 取消」，底部红色「删除」），确认后逐条删除并**同时取消提醒**；滚动列表不会误触发 |
| 返回手势 | 系统返回键 / 侧滑手势在子页面**返回上一页**（首页才退出应用）；另有右下角 48×48 浮动返回按钮，不依赖手势 |
| 历史任务 | 已完成的待办移出主页，进「历史任务 · N」页：按**完成时间倒序**，显示「完成于 … · 原定 …」，可「恢复」或长按批量删除。**整行点击不做任何事**（只有「恢复」按钮可点），避免「主页点行 = 进编辑、历史点行 = 恢复」这种同手势不同语义 |
| 六档提醒 | 截止前 7 天、3 天、1 天、3 小时、1 小时、到点，共 6 条独立通知；**已过去的档位不补发**；关掉提前提醒则只剩「到点」 |
| 静音横幅 | 高重要性渠道（能弹出横幅）+ 无声音 + 无震动 + 锁屏可见；不会打断音乐，也不会震手 |
| 每件事单独通知 | 每条闹钟有独立整型 id = `hash(todoId + 档位 + 实例时刻)`，同时作为通知 id 与 PendingIntent requestCode，互不覆盖 |
| 点通知直达 | 通知点开就是对应的编辑页（原生侧记 `pending_open_todo`，JS 启动后取走并跳转） |
| 重复任务 | 每天 / 每周（周几多选，至少留一天）/ 每月（几号，月底自动取当月最后一天）/ 每隔 N 天或 N 小时；「完成」= 推进到下一次，不是消失 |
| 常驻卡片 | 顶部固定显示**最近一件带截止时间的**未完成事项：标题 22px 最醒目，第二行「今天 18:00 截止 · 还有 2 小时 13 分」（逾期整行转红并带小圆点），第三行「还有 N 档提醒」；列表里还有无期限待办时提示「另有 N 件无期限」 |
| 通知栏常驻 | 前台服务在通知栏常驻一条「最近一件要做的一次性事情」（标题 + 绝对时间 + **系统计时器走秒的倒计时**，逾期后变正计时），点它直接进对应编辑页；**独立静音渠道 `ongoing`**，不弹横幅、不响、不显示角标 |
| 重启后照常提醒 | 闹钟列表持久化在 `SharedPreferences`，`BootReceiver` 在 `BOOT_COMPLETED` / `LOCKED_BOOT_COMPLETED` / `QUICKBOOT_POWERON` / `MY_PACKAGE_REPLACED` 时重建；旧格式提醒会被**宽容解析**救回来（见下节） |
| 断网可用 | 全部数据在本地，无需网络即可新建、查看、提醒 |
| 运行检查 | 逐项显示「通知权限 / 准时触发 / 电池优化」状态，并一键跳转对应系统设置页；若磁盘上有旧提醒没能恢复，额外显示琥珀色提示条 |
| 完成 / 删除 | 任何数据变化后**全量重排**提醒，删除待办即取消其全部提醒 |

### 提醒档位随重复周期收缩

周期比提前量还短的档位没有意义（「每天 9:00」的任务提前 7 天提醒，会和上一周期的提醒完全重叠），所以：

| 重复方式 | 周期 | 保留档位 |
|---|---|---|
| 不重复 | ∞ | 7d / 3d / 1d / 3h / 1h / due（六档） |
| 每天 | 1 天 | 3h / 1h / due |
| 每周 | 7 天 | 3d / 1d / 3h / 1h / due |
| 每月 | 约 30 天 | 六档 |
| 每 N 天 / N 小时 | N | 只保留提前量短于 N 的档位（如每 6 小时 → 3h / 1h / due） |
| 任意重复 + **关掉提前提醒** | — | 只有 due（到点那一刻） |

### 返回键：为什么是「深度计数」而不是 WebView history

本项目没有注册 Capacitor 的 `backButton` 监听，WebView 又是单页应用（视图由 React state 管，
没有可后退的 history 条目），所以不拦的话系统返回键会**直接销毁 Activity** ——
用户在编辑页、历史页按返回就等于退出应用。

现在：

- JS 在视图切换后调 `ReminderAlarm.setViewDepth({ depth })`（0 = 首页，1 = 子页面）；
- `MainActivity.onBackPressed()` 里 `depth > 0` 就抛 `backRequested` 事件给 JS 并直接返回（不调 `super`），
  否则 `super.onBackPressed()` 退出应用；
- Plugin 实例用 `WeakReference` 挂静态引用，Bridge 没起来 / 没订阅时一律退回系统默认行为
  （宁可退出应用，也不要让返回键没反应）。

**为什么不用 `evaluateJavascript("history.back()")`**：那是异步的（要等 JS 执行完才知道有没有后退成功），
而 `onBackPressed` 必须**同步**决定「拦还是放」。深度计数由 JS 主动写入，同步、无竞态。

**别开 predictive back**：清单里若把 `android:enableOnBackInvokedCallback` 设为 `true`，
`onBackPressed` 这个 override 就不再被调用，返回会绕过拦截直接退出应用 ——
那时必须改成 `OnBackPressedDispatcher` + `OnBackPressedCallback`。当前 targetSdk 35 且未开启该开关。

### 通知栏常驻卡：为什么由 JS 决定显示哪一条

原生手里只有闹钟列表（`AlarmRecord`：id / todoId / title / deadline / fireAt），它不知道
哪条是重复任务、哪条已完成、哪条只是没设时间。所以「显示哪一条」这条业务规则只有一份实现，
在 `src/lib/ongoing.ts` 的 `pickOngoingItem` 里（一次性 + 未完成 + 有截止时间 + 时间最近），
原生只负责显示。复制一份到 Kotlin 里迟早会两边不一致。

三条实现约束（每条都是真机踩出来的）：

1. 常驻通知必须用**独立渠道** `ongoing`（`IMPORTANCE_LOW`）：渠道重要级别创建后不可修改，
   复用 `reminders_v3`（HIGH）会导致常驻通知一直弹横幅；
2. `onStartCommand` 返回 `START_STICKY`，被系统回收后重建时拿到的是**空 Intent**，
   内容必须从 `SharedPreferences`（键 `ongoing_item`）读回来；
3. `onDestroy` 里**不调** `stopForeground`，否则重启路径上通知会先消失再出现（用户看到闪一下）。

另外两点：

- **数字必须自己走**：卡上的倒计时/正计时交给系统计时器（`setWhen(deadline)` +
  `setUsesChronometer(true)` + `setChronometerCountDown(...)`），零唤醒；
  正文因此改放**绝对时间**（`deadlineText`：`今天 18:00` / `明天 09:00` / `11月12日 09:00`，
  规则与 `shared/format.ts::formatDeadline` 完全一致，`tests/ongoing-chronometer.test.ts` 逐条对账）。
  上一版把 `remainingText` 写死进正文，息屏两小时后会显示一个**停住的、错误的**数字。
- **通知 id 7011 被保留**：提醒的 id 同时是通知 id 与 PendingIntent requestCode，
  一旦哈希到 7011 会顶掉常驻卡。所以 `src/lib/alarms.ts` 的 `RESERVED_ALARM_IDS` 把 7011 排除，
  `allocateId` 探测时跳过它。新增原生通知 id 时要同步加到那个集合里。

### 排程名额怎么分配

一次最多往系统里排 **240** 条闹钟（`MAX_ALARMS`），分两级：

1. **单条待办**最多展开 **24 个实例**（`MAX_INSTANCES_PER_TODO`），且最多保留 `max(8, 240 ÷ 活跃待办数)` 条提醒
   （`MIN_ALARMS_PER_TODO = 8` 是保底，防止待办很多时平均下来变成 0 或 1）；
2. 再按**触发时刻升序**取前 240 条兜底。

这样一条「每 15 分钟」的任务不会把名额吃光（QA 实测过修复前它独占 235/240）。
界面上的「还有 N 条提醒未能排出」= 理论候选总数 − 最终保留数，两级丢弃都算进去。

没有截止时间的待办**不参与**这套配额计算（它本身不产生提醒，不该摊薄别人的名额）。

### 覆盖安装后，旧提醒必须还能响

**曾经的缺陷（P1）**：旧版本存的提醒是 `{id, title, body, fireAt}`，新版本 `load()` 一看到
`alarms_version != 2` 就 `return emptyList()`。而覆盖安装时系统会把已排的 `AlarmManager` 闹钟**全部清掉**，
紧接着 `MY_PACKAGE_REPLACED` 把 `BootReceiver` 叫醒 → 读盘 → 读到空 → **一条提醒都不响**，
而且一行日志都没有。用户不主动打开应用就永远发现不了。

现在：

| 磁盘上的情况 | 行为 |
|---|---|
| 没有 `alarms_version`（旧版本从没写过这个键）或 `< 2` | **宽容解析**：旧形状逐条认，正文原样放进 `legacyBody`，通知就用那句现成的文案（不会拿 `deadline = 0` 去算剩余时间，否则会说「已逾期 56 年」） |
| `== 2` | 正常解析 |
| `> 2`（未来版本，本版本不认识） | 放弃本次解析，留 `ERROR` 日志 |
| 单条坏记录 | 只丢那一条，绝不让整张表一起消失 |
| 有数据但一条都没解析出来 | 留 `ERROR` 日志 + 通过 `droppedAlarmCount` 报到界面 → **顶部琥珀色提示条「有 N 条旧提醒未能恢复」** |

这个页面上的提示条是刻意的：**「静默不响」是最难排查的一类故障**，宁可打扰用户一次，也不要让他某天发现提醒早就没了。

#### 真机验证步骤（没时间跑 CI 时就照这个走）

1. 先装**旧版本** APK（有 `alarms_version` 缺失那一版）；
2. 在旧版本里新建一条**10 分钟后**截止的待办（六档里 1h / 3h 等档位已过，只剩 due 与 1h，够验证）；
3. **不要打开旧版本挂后台**，直接**覆盖安装**新版本 APK；
4. 装完**不要打开应用**，把手机放着等到点；
5. 预期：**到点弹出提醒**，正文是「还有…截止 / 已到截止时间」（旧记录用自己的 `legacyBody`），
   而不是什么都没发生。装完打开应用的话，`App.tsx` 会全量重排，旧记录被 v2 覆盖，这条验证就失效了
   —— 所以第 3、4 步「不动应用」是这条 recipe 的关键。

对应的自动化保障（Kotlin 侧没法在 CI 里跑，见下面「为什么用 JS 镜像」）：

- `tests/fixtures/legacy-alarms.json`：4 条真实旧格式记录（`{id, title, body, fireAt}`，没有 `alarmsVersion`）；
- `tests/fixtures/mixed-alarms.json`：4 条旧 + 2 条新混装；
- `tests/helpers/reminder-store-mirror.ts`：`ReminderStore.kt` 解析路径（`loadWithStats` / `parseRecord` / `save` / `findLegacyBody`）
  的**逐行 JS 移植**，连 `org.json` 的 `optXxx` 宽松语义都保持一致；
- `tests/legacy-alarm-parse.test.ts`：用上面两份 fixture 喂给镜像，逐字段对账，并对 Kotlin 源码做静态断言
  （键名、分支顺序、两处 `Log.e`、`legacyBody` 透传、`droppedAlarmCount` 一路报到界面）。

**为什么用 JS 镜像而不是直接跑 Kotlin 单测**：本机 `~/.gradle/caches` 里没有 junit（加依赖要联网），
而 `android.jar` 里的 `org.json` 全是 `throw new RuntimeException("Stub!")`——
就算勉强配上 JVM 单测，`JSONObject` 也只会抛异常。所以用「同一份磁盘数据 + 一份被静态断言钉住的移植」
来保证等价性：一旦 Kotlin 侧改了形状而镜像忘了跟，静态断言会红。



---

## 技术架构

```
Android APK（Capacitor 6，完全离线）
├── WebView：React 18 + TypeScript + Tailwind 3（Vite 构建，产物 dist/）
│   ├── lib/api.ts             → localStorage 仓储层（zuoleme.todos.v2，含 v1 迁移）
│   ├── lib/alarms.ts          → 待办 → 扁平闹钟列表（含重复任务 30 天展开，纯函数可单测）
│   ├── lib/navigation.ts      → 视图类型与「返回该做什么」的判定（纯函数可单测）
│   ├── lib/long-press.ts      → 长按状态机（滚动不误触、长按后吞掉 click，纯状态机可单测）
│   ├── lib/ongoing.ts         → 挑出「通知栏常驻卡要显示哪一件事」（纯函数可单测）
│   └── lib/reminder-bridge.ts → 调原生 ReminderAlarm 插件（Web 上自动降级为空操作）
└── 原生层（Kotlin）
    ├── ReminderAlarmPlugin.kt → JS 桥：scheduleAll / cancelAll / 权限三连 / getPendingOpen / setViewDepth / updateOngoing
    ├── ReminderStore.kt       → SharedPreferences 持久化 + AlarmManager 排程 + 常驻卡内容落盘
    ├── ReminderNotifier.kt    → 通知渠道（reminders_v3，IMPORTANCE_HIGH + 静音）+ 发通知
    ├── OngoingService.kt      → 前台服务：通知栏常驻「最近一件事」（渠道 ongoing，IMPORTANCE_LOW + 静音，
    │                            倒计时/正计时交给系统计时器，零唤醒）
    ├── AlarmReceiver.kt       → 到点广播 → 现算剩余时间 → 发一条独立通知
    └── BootReceiver.kt        → 开机 / 升级后重建全部闹钟
```

- 一次性提醒的时间语义仍由 `shared/reminders.ts` 的 `planReminders(deadline, now)` 决定（签名与行为**未改**），
  重复任务走 `planRemindersFor(deadline, repeat, now, advance?)`；`advance` 与 `reminderOffsetsFor` 的第二个参数
  都是**可选参数**且默认 `true`，所以「关掉提前提醒」是新能力，不是行为变更；
- 无期限用 `deadline: null` 表示（**不是 `0`**）：`null` 参与减法会变成 1970 年，
  于是会被判成「已逾期 56 年」顶到列表最前面并试图排一堆过去的闹钟。所以排序、分组、提醒、闹钟编译
  每一处都**先判 `null` 再算数**（`shared/types.ts` 里 `deadline: number | null` 是强制类型约束）；
- 重复规则的时间推进在 `shared/repeat.ts`：全部用 `setDate / setMonth` 按本地日历推进，
  不用 `+86400000`（夏令时那天会漂一小时），也不用 `setMonth(+1)` 直接跳月（31 号会溢出成下下个月）；
- **不持久化「提醒是否已发」**：闹钟交给系统后由系统保证触发，`fireAt <= now` 的档位在编译阶段就被丢弃；
- `worker/` 目录（原 Cloudflare Worker + D1 + Web Push）**保留但不再被引用**，仅作为将来做同步的参考实现。

## 目录结构

```
shared/
  types.ts          # 待办模型 + 重复规则类型（本地唯一真相）
  repeat.ts         # 重复规则纯函数 nextOccurrence / repeatLabel / cycleLengthMs
  reminders.ts      # 六档提醒纯函数 planReminders / reminderOffsetsFor / planRemindersFor
  format.ts         # 倒计时 / 截止时间格式化纯函数
src/
  main.tsx  App.tsx  index.css
  components/       # HomeView / PinnedCard / TodoRow / TodoEditor / HistoryView / SelectionToolbar / FloatingBack / RepeatPicker / HealthPanel
  lib/              # api(localStorage) / alarms / reminder-bridge / ongoing / navigation / long-press / history / group-todos / useNow / idb
  sw.ts             # 仅网页版使用；APK 内不注册 Service Worker
android/            # Capacitor 生成的 Android 工程 + 自研提醒插件（Kotlin）
tests/              # Vitest：重复规则、档位收缩、闹钟编译与配额、存储迁移、原生契约、旧格式宽容解析
  fixtures/         # 真实磁盘数据样本（旧格式 / 新旧混装），供解析镜像对账
  helpers/          # reminder-store-mirror（Kotlin 解析路径的逐行 JS 移植）等
worker/             # 已停用：原 Cloudflare Worker（APK 版本不使用该目录）
```

---

## 本地开发

```bash
npm install
npm run dev            # 浏览器里调试界面（此环境无系统提醒，运行检查会提示「仅 APK 可用」）
npm run typecheck      # 前端 + Service Worker + Worker 三份 tsconfig
npm run build          # 类型检查 + vite build（产物 dist/）
npm test               # Vitest（535 个用例）
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
| 首次启动弹出的系统授权框 | 允许通知 | 提醒照常触发，但**屏幕上什么都看不到** |
| 应用内「运行检查 → 通知权限 → 去授权」 | 允许通知（拒绝过系统就不再弹框，只能从「去设置」手动打开） | 同上 |
| 应用内「运行检查 → 准时触发 → 去开启」 | 允许「闹钟和提醒」 | 提醒会被推迟到系统省电窗口，可能晚十几分钟 |
| 应用内「运行检查 → 电池优化 → 去设置」 | 找到「做了么」→ 不限制 / 不优化 | 长时间不打开应用后，息屏时可能不触发 |
| 系统设置 → 应用管理 → 做了么 → **自启动**（realme/OPPO/vivo/小米 有此项） | 打开 | 清理后台 / 重启后不再重建闹钟 |
| 系统设置 → 电池 → 应用耗电管理 → 做了么 | 允许后台活动 / 不限制 | 同上 |

> realme / OPPO 的路径大约在：设置 → 应用管理 → 做了么 → 耗电管理 → 「允许后台运行」+「允许自启动」。
>
> 首次启动若检测到通知未授权，应用会自动展开「运行检查」并在顶部显示红色提示条
> 「通知未授权，提醒不会弹出」，附「去允许」「去系统设置」两个按钮。

---

## 已知限制与取舍

1. **重复任务只展开未来 30 天**：更远的实例需要重新打开应用续排（每次启动 / 回到前台都会全量重排）。
   这是刻意的：一次排太多会把系统闹钟数量撑爆（当前上限 240 条），而且用户随时可能改规则。
2. **带截止时间的待办很多（约 160 条以上）时，单次只能排 240 条提醒，会有部分待办暂时一条都排不上**。
   0 档意味着那条待办**当前完全没有提醒**，不只是「少了一两档」——这是必须说清楚的事实。
   实测（每条待办错开 1 小时的场景，`tests/qa-v2-alarm-scale.test.ts` 同款构造）：

   | 带截止时间的待办 | 排上的提醒 | 0 档的待办 |
   |---|---|---|
   | 40 条 | 240（满） | 0 条 —— 40 × 6 档恰好填满 |
   | 160 条 | 240 | 0 条 |
   | 170 条 | 240 | 10 条（6%） |
   | 200 条 | 240 | 40 条（20%） |
   | 300 条 | 240 | 140 条（47%） |

   **这不是永久丢失**：每次打开应用都会按当前时间重新全量排程，届时更近的档位会重新占上名额。
   真正需要留意的是「很久不打开应用 + 待办很多」这个组合。
   上表是**观测值不是数学保证**：具体哪些待办落到 0 档取决于各条截止时间的分布（越密集越容易挤）。
   这是**明示的容量策略，不是已知 bug** —— 「取最早」的真实语义是紧迫性优先：
   不管有多少条待办，时间上最近的提醒一定排得上，这比「人人均摊」更符合「不漏事」的目标。
   > 为什么不给每条待办保底 1 档：保底会让一条时间很远的「7 天档」挤掉另一条待办 1 小时后的提醒，
   > 等于用「远处占坑」换「近处失效」，比现状更差。
   > 为什么不按待办轮转：轮转意味着每条先拿自己**最早**的两条，而「最早」恒为 7 天档与 3 天档 ——
   > 结果是**所有待办一起失去「到点」那一档**，谁都收不到最该收到的那条通知。
3. **无期限待办不产生任何提醒**：「不设时间」= 用户明确说了「这件事不用提醒」。
   它也不占提醒名额，不会摊薄别人的档位。
4. **不做云端同步**：数据只在这台手机上，卸载应用 = 数据丢失（`allowBackup=true` 时系统备份可能带回）。
5. **精确闹钟降级路径**：若用户拒绝「准时触发」权限，代码会降级为 `setAndAllowWhileIdle`
   （仍会触发，但可能延迟）。这是刻意的降级而不是失败——宁可晚响也不要静默不响。
6. **未持久化「已触发」状态**：闹钟交给系统后应用被杀也不影响触发；但**同一条提醒不会补发**，
   如果手机在触发时刻处于关机状态，该档位会直接跳过（与「已过去的档位不补发」的产品语义一致）。
7. **通知里不放具体内容**：摘要只显示标题 + 剩余时间。这是刻意的——锁屏通知栏不适合放长正文，
   也不该把私事摊在锁屏上；正文点开**编辑页**看。
8. **国产 ROM 的后台管控无法从应用内绕过**：只能靠用户在系统设置里白名单，运行检查面板已给出提示。
9. **通知栏常驻卡不保证一直活着**：它靠前台服务（`OngoingService`，`foregroundServiceType=specialUse`，
   `START_STICKY`）。realme / OPPO / vivo 这类 ROM 的「智能省电 / 后台冻结」可能在息屏一段时间后
   把前台服务也杀掉，**此时常驻卡会消失，但提醒照旧** —— 提醒走的是
   `AlarmManager.setExactAndAllowWhileIdle`，与这个服务无关。回到应用前台会自动重新拉起常驻卡。
   另外 Android 12+ 不允许**后台**启动前台服务，所以只在前台刷新（数据变化 / 切回前台）。
   卡上的数字由**系统计时器**（`setUsesChronometer` + `setWhen(deadline)`）渲染，每秒自己走，
   不需要应用醒着：未到期是倒计时（正文写「今天 18:00」这样的绝对时间），逾期后自动切成正计时
   显示「已逾期」多久。只有 Android 6（API 23）没有 `setChronometerCountDown`，降级为静态文案。
10. **`INTERNET` 权限保留**：Capacitor 的 WebView 加载本地资源需要它，应用代码不做任何网络请求。
11. **未做**：分类、优先级、搜索、统计、深色模式切换、iOS。
12. **「今天 / 明天 / 本周」的分组边界用固定 `86_400_000` 偏移**，不是日历计算。
    中国全境不使用夏令时，一天恒等于 24 小时；换成日历计算只会徒增复杂度（代码里也有注释说明）。

## 安全说明

- 无网络请求、无账号、无 token；待办数据只写在应用私有目录的 WebView `localStorage` 里。
- `worker/` 目录里的密钥说明仍然有效（`wrangler secret put`，`.dev.vars` 不进仓库），
  但 APK 版本不会读取任何密钥。
