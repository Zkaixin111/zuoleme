#!/usr/bin/env node
/**
 * 页面截图工具（免安装 APK 看界面）。
 *
 * 为什么需要它：每次改一点样式就 `assembleDebug` 再装一遍，成本太高。
 * 这个脚本用无头浏览器以手机视口（390×844，2 倍像素）打开 `dist/`，
 * 把每个页面/状态都截一张图，输出到 `screenshots/` 并生成一个 HTML 预览页。
 *
 * **关键点：必须把 Capacitor 原生桥打桩成「安卓环境」**。
 * 否则 `isNativePlatform()` 返回 false，页面会走 Web 分支（注册 Service Worker、
 * 原生调用全部变成空操作），截出来的行为跟真机是两个应用 —— 哪怕这一轮
 * 界面上已经没有直接显示原生状态的地方，也不该让预览环境悄悄换一套行为。
 * 打桩方式（按 @capacitor/core 6.2.3 的实现）：
 *   1. `window.androidBridge = {}` → `getPlatform()` 返回 'android' → `isNativePlatform()` 为 true；
 *   2. `window.Capacitor.PluginHeaders` 声明 ReminderAlarm 的方法表 + 提供
 *      `nativePromise` / `nativeCallback`，让 `registerPlugin` 走原生分支并能拿到假数据。
 *
 * **时钟也要拨**：`Date` 被替换成带偏移的版本，让页面永远以为是「今天 15:47」。
 * 这样不管什么时候跑，截图里都是「今天 / 明天 / 本周」齐全的样子，
 * 而不是半夜跑出来一堆「明天」。
 *
 * 用法：
 *   node scripts/screenshots.mjs            # 用已有的 dist/
 *   node scripts/screenshots.mjs --build    # 先构建再截图
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'screenshots');

/** 手机视口（Pixel 7 逻辑分辨率） */
const VIEWPORT = { width: 390, height: 844 };
/** 截图放大倍数 */
const SCALE = 2;
/** 页面假装的当前时刻（今天 15:47） */
const FAKE_HOUR = 15;
const FAKE_MINUTE = 47;

/** 默认的原生权限快照：三项全绿，顶部不出「通知未授权」横幅 */
const DEFAULT_PERMISSIONS = {
  notifications: true,
  exactAlarm: true,
  batteryOptimized: false,
  droppedAlarmCount: 0,
};

/* ------------------------------------------------------------------ */
/* 依赖与浏览器定位                                                     */
/* ------------------------------------------------------------------ */

/**
 * 定位 playwright-core。
 *
 * 项目本身不装 playwright（只为截图引入一个 200MB 的依赖不值），
 * 优先用本机全局安装的那一份，找不到再退回项目依赖。
 */
function resolvePlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = ['playwright-core', 'playwright'];

  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    candidates.push(
      join(globalRoot, '@playwright/cli/node_modules/playwright-core'),
      join(globalRoot, 'playwright-core'),
      join(globalRoot, 'playwright'),
    );
  } catch {
    // 没有全局 npm 也能继续，下面的候选里可能就有
  }

  for (const id of candidates) {
    try {
      return require(require.resolve(id));
    } catch {
      // 换下一个
    }
  }
  throw new Error(
    '找不到 playwright-core。请先安装：npm i -g @playwright/cli（或 npm i -D playwright-core）',
  );
}

/** 找一个可用的 Chromium 内核浏览器（本机只装了 Edge 也能跑） */
function resolveBrowser(explicit) {
  const candidates = [
    explicit,
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);

  for (const path of candidates) {
    if (existsSync(path)) {
      return path;
    }
  }
  throw new Error('找不到 Chrome / Edge，可用 CHROME_PATH 环境变量指定');
}

/* ------------------------------------------------------------------ */
/* 静态服务器                                                           */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * 起一个极简静态服务器托管 dist/。
 *
 * 不用 `vite preview`：少一次进程派生、少一处等待就绪的竞态，
 * 而且这里只需要「把文件吐出去」，没有任何构建期逻辑要复用。
 */
async function startServer() {
  const server = createServer(async (req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const relative = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
    let file = join(DIST, relative.replace(/\.\./g, ''));
    if (!existsSync(file) || relative.endsWith('/')) {
      file = join(DIST, 'index.html');
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  });

  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address();
  return { server, origin: `http://127.0.0.1:${port}` };
}

/* ------------------------------------------------------------------ */
/* 注入脚本：原生桥打桩 + 时钟偏移 + 种子数据                            */
/* ------------------------------------------------------------------ */

/**
 * 生成注入到每个页面的初始化脚本。
 *
 * 这段代码在页面里执行（不是 Node 里），所以只能用页面 API。
 *
 * @param offsetMs 时钟偏移（毫秒），让页面以为是「今天 15:47」
 * @param todos 种子待办（deadline / completedAt 用「相对今天的偏移描述」，见 buildTodos）
 * @param permissions `getPermissionState` 的假返回值（决定顶部「通知未授权」横幅出不出现）
 */
function buildInitScript(offsetMs, todos, permissions) {
  return `(() => {
  // ---- 1. 时钟：让页面以为是 ${FAKE_HOUR}:${String(FAKE_MINUTE).padStart(2, '0')} ----
  const RealDate = Date;
  const OFFSET = ${offsetMs};
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(RealDate.now() + OFFSET);
      } else {
        super(...args);
      }
    }
    static now() {
      return RealDate.now() + OFFSET;
    }
  }
  globalThis.Date = FakeDate;

  // ---- 2. Capacitor 原生桥打桩 ----
  const methods = [
    ['scheduleAll', 'promise'],
    ['cancelAll', 'promise'],
    ['getPermissionState', 'promise'],
    ['requestNotificationPermission', 'promise'],
    ['openExactAlarmSettings', 'promise'],
    ['openBatterySettings', 'promise'],
    ['openNotificationSettings', 'promise'],
    ['getPendingOpen', 'promise'],
    ['setViewDepth', 'promise'],
    ['updateOngoing', 'promise'],
    ['addListener', 'callback'],
    ['removeListener', 'callback'],
  ];

  const respond = (method, options) => {
    switch (method) {
      case 'scheduleAll':
        return { scheduled: Array.isArray(options && options.alarms) ? options.alarms.length : 0 };
      case 'getPermissionState':
        return ${JSON.stringify(permissions)};
      case 'requestNotificationPermission':
        return { notifications: ${permissions.notifications === true} };
      case 'getPendingOpen':
        return { todoId: null };
      default:
        return {};
    }
  };

  globalThis.androidBridge = {};
  globalThis.Capacitor = {
    PluginHeaders: [{ name: 'ReminderAlarm', methods: methods.map(([name, rtype]) => ({ name, rtype })) }],
    nativePromise(_plugin, method, options) {
      return Promise.resolve(respond(method, options));
    },
    nativeCallback(_plugin, method, options) {
      // addListener：返回一个假的 callbackId 即可，截图不需要真的收到原生事件
      return Promise.resolve('preview-callback-' + method);
    },
  };

  // ---- 3. 种子数据 ----
  const now = Date.now();
  const d = new RealDate(now);
  const dayStart = new RealDate(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  /** 「第 dayOffset 天的 h:m」 */
  const at = (dayOffset, h, m) => dayStart + dayOffset * 86400000 + h * 3600000 + m * 60000;

  const recipes = ${JSON.stringify(todos)};
  const list = recipes.map((r, index) => ({
    id: 'seed-' + String(index + 1).padStart(2, '0'),
    title: r.title,
    content: r.content,
    deadline: r.deadline === null ? null : Array.isArray(r.deadline) ? at(r.deadline[0], r.deadline[1], r.deadline[2]) : now + r.deadline,
    advanceReminder: r.advance !== false,
    done: r.done === true,
    completedAt: r.done === true ? (Array.isArray(r.completedAt) ? at(r.completedAt[0], r.completedAt[1], r.completedAt[2]) : now + (r.completedAt || 0)) : null,
    repeat: r.repeat || { kind: 'none' },
    createdAt: now - (recipes.length - index) * 3600000,
    updatedAt: now - (recipes.length - index) * 3600000,
  }));

  window.localStorage.setItem('zuoleme.todos.v2', JSON.stringify({ version: 2, todos: list }));
})();`;
}

/* ------------------------------------------------------------------ */
/* 种子数据                                                             */
/* ------------------------------------------------------------------ */

/**
 * 一份「日常」清单，覆盖全部六种分组与全部重复规则。
 *
 * deadline 用 `[天偏移, 时, 分]` 表示（相对「今天 0 点」），null 表示不设时间；
 * 数字表示「距现在多少毫秒」。这样不管哪天跑，画面都是同一副样子。
 */
const DAILY = [
  {
    title: '吃维生素',
    content: '早饭后两粒，随水吞服。',
    deadline: [0, 18, 0],
    repeat: { kind: 'daily' },
  },
  {
    title: '取快递',
    content: '丰巢柜 3 号，取件码 8821，超时会收费。',
    deadline: [0, 18, 40],
    advance: false,
  },
  {
    title: '把上个月的报销单提交',
    content: '发票 4 张，合计 1260 元；车票记得贴在第 2 页。',
    deadline: [1, 10, 0],
  },
  {
    title: '给家里打电话',
    content: '问问妈体检结果，顺便说下下周回家的时间。',
    deadline: [3, 20, 0],
    repeat: { kind: 'weekly', weekdays: [0, 3] },
  },
  {
    title: '续签租房合同',
    content: '和房东约时间，准备好押金凭证和身份证复印件。',
    deadline: [12, 15, 0],
  },
  {
    title: '读完《设计中的设计》',
    content: '',
    deadline: null,
  },
  {
    title: '整理电脑里的旧照片',
    content: '按年份归档，删掉重复的。',
    deadline: null,
  },
];

/** 历史记录：四条已完成，覆盖「有原定时间 / 无原定时间 / 很久以前」 */
const COMPLETED = [
  { title: '把上周的周报发出去', content: '', deadline: [0, 10, 0], done: true, completedAt: [0, 13, 47] },
  { title: '去银行换预留手机号', content: '', deadline: [-2, 9, 0], done: true, completedAt: [-1, 13, 47] },
  { title: '交这个月的物业费', content: '', deadline: null, done: true, completedAt: [-6, 13, 47] },
  { title: '预约牙科洗牙', content: '', deadline: [-30, 9, 0], done: true, completedAt: [-30, 13, 47] },
];

/** 一条已逾期的（只在「逾期态」场景里出现，否则会抢占常驻卡） */
const OVERDUE = {
  title: '交这个月的水电费',
  content: '电费 218 元，水费 46 元，支付宝里搜户号。',
  deadline: [0, 12, 20],
};

/* ------------------------------------------------------------------ */
/* 场景                                                                */
/* ------------------------------------------------------------------ */

/**
 * 每个场景 = 一份种子 + 一串操作 + 一张截图。
 *
 * `steps` 里的 `click` 都是按**界面上看得见的文字**点的 ——
 * 这样即使以后 class 名变了，脚本也不会莫名其妙失效。
 */
const SCENARIOS = [
  {
    file: '01-home.png',
    caption: '首页 · 常态',
    note: '常驻卡显示「最近一件事」（这里是每天重复的「吃维生素」），下方是新建按钮；列表按逾期/今天/明天/本周/以后/无期限分组。',
    todos: DAILY,
  },
  {
    file: '02-home-overdue.png',
    caption: '首页 · 有逾期',
    note: '逾期那条会排到最前面并抢占常驻卡：第二行整行转红、小圆点提示，不再是绿色正常态。',
    todos: [OVERDUE, ...DAILY],
  },
  {
    file: '03-home-empty.png',
    caption: '首页 · 空状态',
    note: '一条待办都没有时的样子：常驻卡退化成引导卡，「历史任务 · 0」仍然在底部。',
    todos: [],
  },
  {
    file: '04-home-full.png',
    caption: '首页 · 整页',
    note: '把视口拉到内容高度一次拍全：常驻卡 → 新建 → 六个分组，底部固定栏仍在最下方。',
    todos: [OVERDUE, ...DAILY, ...COMPLETED],
    fitContent: true,
  },
  {
    file: '05-home-selection.png',
    caption: '首页 · 批量选择模式',
    note: '长按任意一行进入：顶部换成「已选 N 项 / 全选 / 取消」，底部换成红色删除条，新建按钮暂时收起。',
    todos: DAILY,
    steps: [
      { longPress: '取快递' },
      { click: '把上个月的报销单提交' },
    ],
  },
  {
    file: '06-editor-new.png',
    caption: '新建待办',
    note: '标题、内容之外，三个折叠区块只剩一条分隔线；新建时「截止时间」默认展开，免得用户以为没设时间。',
    todos: DAILY,
    steps: [{ click: '新建待办' }],
  },
  {
    file: '07-editor-edit-collapsed.png',
    caption: '编辑已有 · 三块默认折叠',
    note: '编辑时「截止时间 / 重复 / 提前提醒」全部收起，右侧显示当前值；底部红框「删除这件事」、绿框「标记完成」都要二次确认。',
    todos: DAILY,
    steps: [{ click: '取快递' }],
  },
  {
    file: '08-editor-edit-expanded.png',
    caption: '编辑已有 · 三块全展开',
    note: '展开后的全部控件：截止时间含 5 个快捷按钮；重复分段控件在「每周」时露出 7 个周几，已选的「日 / 三」是实心圆。',
    todos: DAILY,
    steps: [
      { click: '给家里打电话' },
      { click: '截止时间' },
      { click: '重复' },
      { click: '提前提醒' },
    ],
    fitContent: true,
  },
  {
    file: '09-editor-undated.png',
    caption: '编辑 · 选了「不设时间」',
    note: '「重复」与「提前提醒」立刻变灰、摘要转成「不可用」（没有时间锚点就没有这两件事），并说明不设时间不会有任何提醒。',
    todos: DAILY,
    steps: [
      { click: '取快递' },
      { click: '截止时间' },
      { click: '不设时间' },
    ],
    fitContent: true,
  },
  {
    file: '10-history.png',
    caption: '历史任务',
    note: '已完成按完成时间倒序，标题带删除线；整行点击不做任何事，只有右侧「恢复」可点 —— 避免和首页「点行=编辑」撞手势。',
    todos: [...DAILY, ...COMPLETED],
    steps: [{ click: '历史任务' }],
  },
  {
    file: '11-history-selection.png',
    caption: '历史任务 · 批量选择',
    note: '历史页与首页共用同一套选择组件，长按进入后可全选、批量删除。',
    todos: [...DAILY, ...COMPLETED],
    steps: [
      { click: '历史任务' },
      { longPress: '去银行换预留手机号' },
    ],
  },
  {
    file: '12-notice-blocked.png',
    caption: '通知未授权（唯一的自助入口）',
    note: '「运行检查」面板删掉后，授权出问题时用户能看到的只剩这条红色横幅：说明后果 + 两个按钮。这是必须保留的部分，不是「不相干的东西」。',
    todos: [OVERDUE, ...DAILY],
    permissions: { notifications: false, exactAlarm: false, batteryOptimized: true, droppedAlarmCount: 0 },
  },
  {
    file: '13-confirm-normal.png',
    caption: '确认框 · 普通操作（绿框）',
    note: '中文按钮、44px 描边框、按语气分色。原来用系统 window.confirm，真机上显示英文 CANCEL / OK 且无边框无颜色。点遮罩、按 Esc、点取消都等于「不做」。',
    todos: DAILY,
    steps: [
      { click: '给家里打电话' },
      { click: '完成这一次' },
    ],
  },
  {
    file: '14-confirm-danger.png',
    caption: '确认框 · 不可撤销（红框）',
    note: '删除走红框，且标题里直接带出要删的那条标题 —— 批量选择时删错东西的代价太大，必须让用户看清删的是哪一件。',
    todos: DAILY,
    steps: [
      { click: '取快递' },
      { click: '删除这件事' },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* 执行                                                                */
/* ------------------------------------------------------------------ */

/** 点界面上含某段文字的元素（优先按钮，避免点到说明文字） */
async function clickText(page, text) {
  const button = page.locator('button', { hasText: text }).first();
  if ((await button.count()) > 0) {
    await button.click();
  } else {
    await page.locator(`text=${text}`).first().click();
  }
  await page.waitForTimeout(180);
}

/** 长按某一行 700ms（阈值 500ms），走真实的 pointer 事件序列 */
async function longPressText(page, text) {
  const target = page.locator(`text=${text}`).first();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) {
    throw new Error(`长按目标不可见：${text}`);
  }
  const x = box.x + Math.min(box.width / 2, 60);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForTimeout(220);
}

/**
 * 跑一个场景。
 *
 * 每个场景用**全新的 context**：localStorage 天然隔离，
 * 也就不会出现「上一个场景删掉的待办影响下一个场景」这类脏串联。
 */
async function runScenario(browser, origin, offsetMs, scenario) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
  });
  await context.addInitScript({
    content: buildInitScript(offsetMs, scenario.todos, scenario.permissions ?? DEFAULT_PERMISSIONS),
  });

  const page = await context.newPage();
  await page.goto(origin, { waitUntil: 'load' });
  await page.waitForSelector('text=今天', { timeout: 10_000 });
  await page.waitForTimeout(320);

  for (const step of scenario.steps ?? []) {
    if (step.click) {
      await clickText(page, step.click);
    } else if (step.longPress) {
      await longPressText(page, step.longPress);
    }
  }

  if (scenario.fitContent) {
    await fitViewportToContent(page);
  }

  await page.screenshot({
    path: join(OUT_DIR, scenario.file),
    animations: 'disabled',
  });

  await context.close();
  process.stdout.write(`  ✓ ${scenario.file}  ${scenario.caption}\n`);
}

/**
 * 把视口高度拉到内容高度，让长页面一张图拍全。
 *
 * 只改高度不改宽度：`390px` 下的换行、折行不会变，只是把「下面还有内容」的部分露出来。
 * 量两轮是因为 `html/body { height: 100% }`：第一轮量到的是「内容 vs 当前视口」的较大值，
 * 拉高之后再量一次才收敛到真实内容高度。
 *
 * @param page 页面
 */
async function fitViewportToContent(page) {
  let current = VIEWPORT.height;
  for (let round = 0; round < 2; round += 1) {
    const height = await page.evaluate(() =>
      Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    );
    const next = Math.min(Math.max(VIEWPORT.height, Math.ceil(height)), 2600);
    if (next === current) {
      break;
    }
    await page.setViewportSize({ width: VIEWPORT.width, height: next });
    current = next;
    await page.waitForTimeout(200);
  }
}

/** 生成一个人眼友好的预览页（手机外框 + 分组说明） */
async function writeGallery() {
  const cards = SCENARIOS.map(
    (scenario) => `      <figure class="shot">
        <div class="phone"><img src="${scenario.file}" alt="${scenario.caption}" loading="lazy" /></div>
        <figcaption>
          <h2>${scenario.caption}</h2>
          <p>${scenario.note}</p>
          <code>${scenario.file}</code>
        </figcaption>
      </figure>`,
  ).join('\n');

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>做了么 · 全部页面截图</title>
<style>
  :root {
    --paper: #F7F6F2;
    --surface: #FFFFFF;
    --line: #E7E4DC;
    --line-strong: #D8D3C7;
    --ink: #1B1A17;
    --soft: #6F6A60;
    --faint: #A09A8E;
    --accent: #2F5D50;
    --accent-soft: #EAF0ED;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 40px 24px 72px;
    background: var(--paper);
    color: var(--ink);
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  header { max-width: 1180px; margin: 0 auto 36px; }
  h1 { margin: 0 0 8px; font-size: 26px; font-weight: 600; letter-spacing: -0.01em; }
  .lede { margin: 0; max-width: 62ch; font-size: 14px; line-height: 1.75; color: var(--soft); }
  .lede code { background: var(--accent-soft); color: var(--accent); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  main {
    max-width: 1180px;
    margin: 0 auto;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 32px 28px;
  }
  .shot { margin: 0; display: flex; flex-direction: column; gap: 14px; }
  .phone {
    border-radius: 28px;
    border: 1px solid var(--line-strong);
    background: var(--paper);
    padding: 8px;
    box-shadow: 0 1px 2px rgba(27, 26, 23, 0.04);
    overflow: hidden;
  }
  .phone img { display: block; width: 100%; border-radius: 21px; }
  figcaption h2 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
  figcaption p { margin: 0 0 8px; font-size: 12.5px; line-height: 1.7; color: var(--soft); }
  figcaption code { font-size: 11px; color: var(--faint); }
</style>
</head>
<body>
  <header>
    <h1>做了么 · 全部页面截图</h1>
    <p class="lede">
      无头浏览器以 390×844（2 倍像素）打开 <code>dist/</code> 截的图，原生桥接层被打桩成安卓环境，
      所以行为与真机一致。改完样式跑一次
      <code>node scripts/screenshots.mjs --build</code> 就能重新生成这一组，不用再装 APK。
    </p>
  </header>
  <main>
${cards}
  </main>
</body>
</html>
`;
  await writeFile(join(OUT_DIR, 'index.html'), html, 'utf8');
}

async function main() {
  const shouldBuild = process.argv.includes('--build') || !existsSync(DIST);
  if (shouldBuild) {
    process.stdout.write('构建中：npm run build\n');
    execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
  }

  await mkdir(OUT_DIR, { recursive: true });

  const { chromium } = resolvePlaywright();
  const executablePath = resolveBrowser();
  process.stdout.write(`浏览器：${executablePath}\n`);

  const browser = await chromium.launch({ executablePath, headless: true });
  const { server, origin } = await startServer();

  // 让页面以为是「今天 15:47」：这样不管几点跑，分组都是齐的
  const real = new Date();
  const target = new Date(real);
  target.setHours(FAKE_HOUR, FAKE_MINUTE, 0, 0);
  const offsetMs = target.getTime() - real.getTime();

  try {
    for (const scenario of SCENARIOS) {
      await runScenario(browser, origin, offsetMs, scenario);
    }
  } finally {
    await browser.close();
    server.close();
  }

  await writeGallery();
  process.stdout.write(`\n完成：${SCENARIOS.length} 张图 + 预览页 → screenshots/index.html\n`);
}

main().catch((error) => {
  process.stderr.write(`\n截图失败：${error instanceof Error ? error.message : String(error)}\n`);
  if (error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
});
