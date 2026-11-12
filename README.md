# 做了么

> **安卓用户优先用原生版**：`android/`（Kotlin + Compose）提醒在手机本地调度、带真前台服务
> 常驻通知，不依赖 Firefox / 谷歌服务 / 服务器，构建与安装见 [android/README.md](./android/README.md)。
> 下面是网页版（PWA）说明。

> 输入待办和截止时间，应用在 **截止前 7 天 / 3 天 / 1 天 / 3 小时 / 1 小时** 以及 **到点** 各提醒一次；
> 每件事单独弹出通知；最近一件事在应用顶部**常驻**显示倒计时，通知也不会自动消失。

一个可以装到手机主屏的 PWA（Android + Firefox for Android 实测路径），
后端是**单个 Cloudflare Worker**：静态资源 + API + 每分钟定时任务 + D1 数据库，一个域名、无跨域、一次部署。

---

## 功能

| 能力 | 说明 |
|---|---|
| 新建待办 | 标题 + 截止时间（`datetime-local`，带 30 分钟 / 1 小时 / 3 小时 / 明天 9 点快捷选项） |
| 六档提醒 | 截止前 7 天、3 天、1 天、3 小时、1 小时、到点，共 6 条独立通知；**已过去的档位不补发** |
| 每件事单独通知 | 通知带 `tag = todo:<id>:<kind>`，不同事项 / 不同档位互不覆盖 |
| 常驻卡片 | 顶部固定显示最近一件未完成的事 + 剩余时间倒计时（`3天2小时` / `45分钟` / `已逾期`） |
| 通知不消失 | `showNotification(..., { requireInteraction: true })` |
| 通知上直接完成 | 通知动作「完成」→ Service Worker 直接调 `PATCH /api/todos/:id` |
| 离线可打开 | Service Worker 预缓存应用壳 |
| 完成 / 删除 | 完成或删除后待发提醒自动清理；删除待办级联删提醒 |

---

## 技术架构

```
Cloudflare Worker（单域名）
├── 静态资源 ASSETS：dist/ 下的 PWA 前端（SPA 回退）
├── /api/*：待办 CRUD、订阅注册、VAPID 公钥
├── Cron（* * * * *）：扫描到期提醒 → 发 Web Push
└── D1（SQLite）：todos / reminders / subs
```

- 前端：Vite + React + TypeScript + Tailwind 3，PWA 用 `vite-plugin-pwa` 的 `injectManifest`（自己写 Service Worker）
- Worker：原生 `fetch` / `scheduled` handler，**不引框架**
- Web Push：自实现 RFC 8291（aes128gcm）+ RFC 8292（VAPID ES256），零依赖，用 Workers 原生 WebCrypto

## 目录结构

```
worker/
  src/index.ts      # Worker 入口：/api/* → API，其余 → ASSETS，scheduled → cron
  src/api.ts        # REST 接口 + X-Token 鉴权
  src/db.ts         # D1 访问层（纯 SQL）
  src/push.ts       # 单条订阅的推送发送
  src/webpush.ts    # RFC 8291 加密 + VAPID JWT
  src/cron.ts       # 每分钟调度：扫描 → 推送 → 标记
  src/env.ts        # 绑定与密钥类型
  migrations/0001_init.sql
shared/
  types.ts          # 前后端共用类型（接口契约唯一真相）
  reminders.ts      # 六档提醒纯函数（planReminders）
  format.ts         # 倒计时 / 截止时间格式化纯函数
src/
  main.tsx  App.tsx  sw.ts  index.css
  components/       # PinnedCard 常驻卡片 / TodoList / AddTodoPanel / SettingsPanel
  lib/              # api 客户端、推送订阅、IndexedDB、hooks
tests/              # Vitest：提醒规则、格式化、Web Push 加解密闭环
docs/DEPLOY.md      # 部署与手机安装指引（照着做即可）
```

## 本地开发

```bash
npm install

# 终端 A：Worker（API + Cron + 本地 D1），默认 http://127.0.0.1:8787
cp .dev.vars.example .dev.vars   # 填入本地用的 VAPID / API_TOKEN
npm run db:migrate:local          # 建本地 D1 表
npm run dev:worker

# 终端 B：前端（/api 会被代理到 8787）
npm run dev                       # http://127.0.0.1:5173
```

> 本地 `http://localhost` 属于安全上下文，可以测试订阅流程，但**推送只会在 Cron 运行时发出**。
> `wrangler dev` 不会自动按 Cron 触发，可手动触发：
> `curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled"`

## 校验

```bash
npm run typecheck     # 前端 + Service Worker + Worker 三份 tsconfig 全部检查
npm run build         # 类型检查 + vite build（产物 dist/）
npm test              # Vitest 单元测试
```

## 部署

见 [docs/DEPLOY.md](./docs/DEPLOY.md)。核心步骤：

```
wrangler login → wrangler d1 create zuoleme-db → 填 database_id
→ wrangler d1 migrations apply zuoleme-db --remote
→ 4 个 secret（VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT / API_TOKEN）
→ npm run build → wrangler deploy
```

> 更新代码时注意：**`worker/migrations/` 有新文件就必须先 `migrations apply --remote` 再 `deploy`**，
> 否则线上 cron 会因缺列报 `no such column` 而停摆（手机上不会有任何异常提示）。

## 已知限制（请先读，再决定能不能接受）

1. **补发窗口是 1 小时**。推送没成功时会在 1 小时内每分钟重试，超过 1 小时按「放弃」处理并打
   `[cron] 放弃 ...` 的 error 日志（绝不静默）。因此：**手机连续离线超过 1 小时，这期间到点的那几档会永久错过**
   （典型场景：整晚关机/断网，次日早上 `1h` 与 `due` 两档已被放弃）。
   取舍原因：`7d` 档的文案是「还有 7 天截止」，迟到 3 小时再推出去文案已经失真。
2. **重试期可能重复触达**。若推送服务其实已收下、但 Worker 侧看到的是网络错误，同一档位会在窗口内
   每分钟重试；通知 `tag` 相同只会替换不会堆叠，但可能出现重复振动。概率低。
3. **Cron 粒度 ±1 分钟**：提醒时间点最多晚约 60 秒（Cloudflare Cron 最小间隔）。
4. **`requireInteraction: true` 在 Firefox for Android 不被支持**（该属性主要 Chrome 系有效）。
   Android 系统通知本身会留在通知栏直到用户划掉，所以「不自动消失」在真机上通常仍成立，但代码层面无法强制。
5. **推送订阅被浏览器轮换（`pushsubscriptionchange`）不会自动重订阅**：旧订阅会因 410 被后端清理，
   用户需要手动「关闭通知 → 开启通知」重建。
6. **单用户、单 token**：没有账号体系，也没有速率限制。
7. **前端没有「编辑标题/截止时间」入口**：接口 `PATCH {title, deadline}` 已支持，UI 只做了新建/完成/删除。
8. **通知上的「完成」按钮**只有支持的平台才显示（Firefox Android 不显示 notification actions），
   其它平台点通知体即打开应用。

## 安全说明

- 所有密钥（VAPID 密钥对、API Token）一律用 `wrangler secret put`，**不进仓库**；`.dev.vars` 已被 `.gitignore` 忽略。
- 除 `/api/health` 外所有接口都要求 `X-Token` 头；前端把 token 存在本机 `localStorage`（并镜像到 IndexedDB 供 Service Worker 使用）。
- 这是单用户 MVP，没有账号体系：**谁能拿到你的 API Token，谁就能操作你的待办**，请不要把链接和 token 公开。
