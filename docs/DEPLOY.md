# 部署与手机安装（照做即可）

本文件是给「第一次用 Cloudflare」的人写的，命令按顺序复制执行即可。

---

## 0. 前置条件

- Node.js ≥ 18（本项目在 Node 22 下验证）
- 一个 Cloudflare 账号（免费套餐足够：Workers 免费额度 + D1 免费额度 + Cron 每分钟任务）
- 手机上安装 **Firefox for Android**（重要，见第 5 节原因）

---

## 1. 生成 VAPID 密钥

VAPID 密钥是 Web Push 的签名密钥，只生成一次，长期使用。

### 方案 A：Node 一行命令（推荐，无需装任何包）

```bash
node -e "const {subtle}=require('node:crypto').webcrypto;(async()=>{const k=await subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const jwk=await subtle.exportKey('jwk',k.privateKey);const pub=Buffer.from(await subtle.exportKey('raw',k.publicKey)).toString('base64url');console.log('VAPID_PUBLIC_KEY='+pub);console.log('VAPID_PRIVATE_KEY='+jwk.d)})()"
```

输出形如：

```
VAPID_PUBLIC_KEY=BAbc...（65 字节公钥，base64url）
VAPID_PRIVATE_KEY=xyz...（32 字节私钥，base64url）
```

### 方案 B：web-push 官方工具

```bash
npx web-push generate-vapid-keys
```

会输出 `Public Key:` / `Private Key:` 两行 base64url 值。

### 方案 C：openssl

```bash
openssl ecparam -name prime256v1 -genkey -noout -out vapid-private.pem

# 公钥（跳过 DER 前缀，取最后 65 字节的未压缩点）
openssl ec -in vapid-private.pem -pubout -outform DER 2>/dev/null | tail -c 65 | base64 | tr -d '=' | tr '/+' '_-'

# 私钥（DER 最后 32 字节即 d）
openssl ec -in vapid-private.pem -outform DER 2>/dev/null | tail -c 32 | base64 | tr -d '=' | tr '/+' '_-'
```

> 三种方案等价。**公钥必须是 65 字节 base64url（以 `BA` 开头的未压缩 P-256 点）**，否则 Worker 会报
> `VAPID_PUBLIC_KEY 不合法`。

`VAPID_SUBJECT` 填一个联系方式：`mailto:你的邮箱` 或 `https://你的域名`。

---

## 2. 创建 D1 数据库

```bash
npx wrangler login          # 浏览器里点授权
npx wrangler d1 create zuoleme-db
```

命令会打印：

```
✅ Successfully created DB 'zuoleme-db'
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

把这个 `database_id` 填进 `wrangler.jsonc`：

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "zuoleme-db",
    "database_id": "这里替换成你的 database_id",
    "migrations_dir": "worker/migrations"
  }
]
```

---

## 3. 建表与写入密钥

```bash
npx wrangler d1 migrations apply zuoleme-db --remote

npx wrangler secret put VAPID_PUBLIC_KEY    # 粘贴第 1 步的公钥
npx wrangler secret put VAPID_PRIVATE_KEY   # 粘贴第 1 步的私钥
npx wrangler secret put VAPID_SUBJECT       # 例如 mailto:me@example.com
npx wrangler secret put API_TOKEN           # 自己定一个足够长的随机串，手机端要填
```

生成一个 API_TOKEN 可用：

```bash
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
```

> 4 个 secret 缺任何一个，接口都会明确报错（例如「服务端未配置 API_TOKEN」）。

---

## 4. 构建与部署

```bash
npm install
npm run build        # 产物在 dist/
npx wrangler deploy  # 输出 https://zuoleme.<你的子域>.workers.dev
```

部署完成后验证：

```bash
curl https://zuoleme.<你的子域>.workers.dev/api/health
# {"ok":true}

curl -H "X-Token: 你的API_TOKEN" https://zuoleme.<你的子域>.workers.dev/api/todos
# {"todos":[]}
```

---

## 5. 手机上怎么装（Android + Firefox）

> **为什么不用 Chrome**：你的手机没有 Google 服务框架（GMS），Chrome 的推送走 FCM，收不到。
> Firefox for Android 使用 Mozilla 自己的推送服务，是国内无 GMS 机型上最稳的选择。

1. 打开 **Firefox**，访问 `https://zuoleme.<你的子域>.workers.dev`
2. 右上角菜单（⋮）→「**添加到主屏幕**」（部分版本叫「安装」）
3. **从桌面上那个图标打开**（不要从浏览器地址栏打开——独立窗口模式下推送才稳定）
4. 点页面里的「设置」→ 填 **API Token** → 点「保存」
5. 点「**开启通知**」→ 系统弹窗点「**允许**」
6. 此时 `设置` 区应显示「已开启：截止前的六档提醒会推送到这台手机」

iOS 说明：iOS 需要 16.4+ 且必须先把网页「添加到主屏幕」再开启通知，本 MVP 只针对 Android 验证。

---

## 6. 自测清单（真机）

| 操作 | 期望结果 |
|---|---|
| 新建「3 分钟后截止」 | 只在 3 分钟后收到 **1 条**通知（前面的档位都不补发） |
| 新建「2 小时后截止」 | 收到 **2 条**：1 小时前 1 条 + 到点 1 条 |
| 新建「30 分钟后截止」 | 只在到点收到 1 条 |
| 新建「10 天后截止」 | 应收到 6 条（7 天、3 天、1 天、3 小时、1 小时、到点） |
| 同时有 2 件事到期 | 弹出 **2 条独立通知**（不合并） |
| 通知出现后等 30 秒 | 通知**不自动消失**（停留在通知栏） |
| 点通知 | 打开/聚焦应用，顶部常驻卡片显示该事项 |
| 点通知上的「完成」 | 该事项标记完成，提醒清空 |
| 修改某事的截止时间 | 旧提醒重建：应用里的「下次提醒」立即变化 |
| 勾选完成 / 删除 | 该事项不再收到提醒 |
| 断网打开应用 | 应用壳仍可打开 |

Cron 是每分钟跑一次，所以提醒误差最多约 1 分钟，属正常。

---

## 7. 排错

按顺序排查：

1. **是不是 HTTPS 访问？** 非 `https://`（除了 localhost）浏览器不会下发推送。
2. **是不是从主屏幕图标启动的？** Firefox 里从普通标签页打开时推送权限/订阅容易失效。
3. **通知权限**：Firefox → 设置 → 网站权限 → 通知，确认本站是「允许」。
4. **订阅是否写进 D1**：
   ```bash
   npx wrangler d1 execute zuoleme-db --remote --command "SELECT id, substr(endpoint,1,48) AS ep, created_at FROM subs"
   ```
   没有记录 → 手机端「开启通知」其实没成功，重开一次。
5. **Cron 是否在跑、是否有到期提醒**：
   ```bash
   npx wrangler d1 execute zuoleme-db --remote --command "SELECT kind, datetime(fire_at/1000,'unixepoch','localtime') AS fire_at, sent FROM reminders ORDER BY fire_at DESC LIMIT 20"
   npx wrangler tail --format pretty
   ```
   `wrangler tail` 里能看到 `[cron] ... scanned=... pushed=...` 与 `[push] 发送失败 status=...` 日志。
6. **`[push] 发送失败 status=401/403`**：VAPID 密钥不匹配（公钥与私钥不是一对）或 `VAPID_SUBJECT` 不是 mailto/https。
7. **`[push] 发送失败 status=410`**：订阅已失效，Worker 会自动删除该订阅；手机上重新点「关闭通知 → 开启通知」重建订阅。
8. **`scanned=0` 但确实有到期提醒**：检查待办是否已被标记完成（完成的待办不再推送），以及 `fire_at` 是否为毫秒时间戳。

手动触发一次定时任务（`wrangler dev` 本地调试用）：

```bash
curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled"
```

> 本地 `wrangler dev` 不会自动按 Cron 触发；线上部署后由 Cloudflare 每分钟自动调用。
> 触发后看终端里的 `[cron] ... scanned=... pushed=...` 日志，以及
> `npx wrangler d1 execute zuoleme-db --local --command "SELECT kind, sent FROM reminders"` 的 `sent` 变化。

---

## 8. 更新部署

```bash
git pull
npm install
npm run build
npx wrangler deploy
```

前端资源带 hash，Service Worker 会自动更新（`skipWaiting` + `clientsClaim`）。

## 9. 备份 / 清空数据

```bash
# 备份
npx wrangler d1 export zuoleme-db --remote --output backup.sql

# 清空所有待办（谨慎）
npx wrangler d1 execute zuoleme-db --remote --command "DELETE FROM reminders; DELETE FROM todos;"
```
