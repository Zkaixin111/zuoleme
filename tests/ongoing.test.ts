import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NO_REPEAT, type Todo } from '../shared/types';
import { pickOngoingItem } from '../src/lib/ongoing';

/**
 * 前台服务常驻通知（需求 4）。
 *
 * 两层：
 * 1. **选择规则**（`pickOngoingItem`）：这是唯一有判断逻辑的地方，也是最容易出错的 ——
 *    规则写松了常驻卡会挂一条昨天就做完的事，写紧了干脆什么都不显示；
 * 2. **原生契约**：前台服务、渠道、权限、manifest 里的 type 与用途说明，
 *    任何一处写错都能编译通过、装得上，只是常驻卡不出现（或一闪而过）。
 */

const ROOT = new URL('../', import.meta.url);
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const NOW = new Date(2026, 10, 8, 20, 0, 0, 0).getTime();

/**
 * 读取仓库内的源码文件。
 *
 * @param relative 相对仓库根目录的路径
 */
function readSource(relative: string): string {
  return readFileSync(new URL(relative, ROOT), 'utf8');
}

const SERVICE = readSource('android/app/src/main/java/com/zkaixin/zuoleme/OngoingService.kt');
const MANIFEST = readSource('android/app/src/main/AndroidManifest.xml');
const PLUGIN = readSource('android/app/src/main/java/com/zkaixin/zuoleme/ReminderAlarmPlugin.kt');
const STORE = readSource('android/app/src/main/java/com/zkaixin/zuoleme/ReminderStore.kt');
const BRIDGE = readSource('src/lib/reminder-bridge.ts');
const APP = readSource('src/App.tsx');

/**
 * 构造待办。
 *
 * @param id 待办 id
 * @param deadline 截止时间（null = 不设时间）
 * @param options 覆盖 done / repeat / createdAt / title
 */
function makeTodo(
  id: string,
  deadline: number | null,
  options: Partial<Todo> = {},
): Todo {
  return {
    id,
    title: `待办 ${id}`,
    content: '',
    deadline,
    advanceReminder: true,
    done: false,
    completedAt: null,
    repeat: NO_REPEAT,
    createdAt: NOW - DAY_MS,
    updatedAt: NOW - DAY_MS,
    ...options,
  };
}

describe('pickOngoingItem：挑「未完成 + 有截止时间」里最早的一条（不分一次性和重复）', () => {
  it('混合数据里取最早的那一条 —— 重复任务参与竞争并可以胜出', () => {
    const todos = [
      makeTodo('done', NOW + HOUR_MS, { done: true, completedAt: NOW - 1000 }),
      makeTodo('undated', null),
      makeTodo('daily', NOW + 2 * HOUR_MS, { repeat: { kind: 'daily' } }),
      makeTodo('weekly', NOW + 3 * HOUR_MS, { repeat: { kind: 'weekly', weekdays: [1] } }),
      makeTodo('one-off', NOW + 5 * HOUR_MS),
    ];

    // 已完成、无期限被排除；剩下三条按 deadline 升序 → 每天重复的那条最靠前
    expect(pickOngoingItem(todos)).toEqual({
      todoId: 'daily',
      title: '待办 daily',
      deadline: NOW + 2 * HOUR_MS,
    });
  });

  it('多条待办 → 取 deadline 最早的那条（最紧迫）', () => {
    const todos = [
      makeTodo('later', NOW + 3 * DAY_MS),
      makeTodo('soonest', NOW + 30 * 60_000),
      makeTodo('middle', NOW + DAY_MS),
    ];

    expect(pickOngoingItem(todos)?.todoId).toBe('soonest');
  });

  it('重复任务时间更早时就会胜出（产品口径变更：不再把重复任务排在后面）', () => {
    const todos = [
      makeTodo('daily', NOW + 10 * 60_000, { repeat: { kind: 'daily' } }),
      makeTodo('one-off', NOW + 5 * DAY_MS),
    ];

    expect(pickOngoingItem(todos)?.todoId).toBe('daily');
  });

  it('每次重复任务都能上台：只有重复任务时也能选中它（常驻卡不会因此空着）', () => {
    const todos = [
      makeTodo('weekly', NOW + 2 * DAY_MS, { repeat: { kind: 'weekly', weekdays: [1, 4] } }),
      makeTodo('monthly', NOW + 9 * DAY_MS, { repeat: { kind: 'monthly', dayOfMonth: 1 } }),
    ];

    expect(pickOngoingItem(todos)?.todoId).toBe('weekly');
  });

  it('一次性任务只要更早就仍然会顶掉重复任务（两者的优先级完全由时间决定）', () => {
    const todos = [
      makeTodo('daily', NOW + 3 * HOUR_MS, { repeat: { kind: 'daily' } }),
      makeTodo('one-off', NOW + HOUR_MS),
    ];

    expect(pickOngoingItem(todos)?.todoId).toBe('one-off');
  });

  it('一条符合条件的都没有 → null（原生侧收起常驻通知）', () => {
    expect(pickOngoingItem([])).toBeNull();
    // 只有「已完成」和「无期限」时没有候选（重复任务现在算候选，所以这里不放它）
    expect(
      pickOngoingItem([
        makeTodo('done', NOW + HOUR_MS, { done: true, completedAt: NOW }),
        makeTodo('undated', null),
      ]),
    ).toBeNull();
  });

  it('已完成的即使时间最近也不选', () => {
    const todos = [
      makeTodo('done-soon', NOW + 60_000, { done: true, completedAt: NOW }),
      makeTodo('pending-later', NOW + DAY_MS),
    ];

    expect(pickOngoingItem(todos)?.todoId).toBe('pending-later');
  });

  it('逾期的待办仍然算「下一件」（它更需要被看见）', () => {
    const todos = [makeTodo('overdue', NOW - 2 * HOUR_MS), makeTodo('future', NOW + DAY_MS)];

    expect(pickOngoingItem(todos)?.todoId).toBe('overdue');
  });

  it('逾期很久的重复任务同样会被选中（已知后果，不是 bug）', () => {
    // 一条一直没被「完成」的重复任务，deadline 停在过去，于是常驻卡会持续显示
    // 「已逾期 N 天」。这与首页列表里那一行的口径一致（同样按存储的 deadline 归到「已逾期」）。
    // 若产品将来要改成「按下一次」计算，改 pickOngoingItem（用 nextDeadlineFor）并改这条用例。
    const todos = [
      makeTodo('stale-daily', NOW - 3 * DAY_MS, { repeat: { kind: 'daily' } }),
      makeTodo('future', NOW + DAY_MS),
    ];

    expect(pickOngoingItem(todos)?.todoId).toBe('stale-daily');
    expect(pickOngoingItem(todos)?.deadline).toBe(NOW - 3 * DAY_MS);
  });

  it('deadline 相同时按 createdAt 定序，再相同按 id —— 结果稳定，不会每次算出来都不一样', () => {
    const sameDeadline = NOW + HOUR_MS;
    const first = pickOngoingItem([
      makeTodo('b', sameDeadline, { createdAt: NOW - 1000 }),
      makeTodo('a', sameDeadline, { createdAt: NOW - 2000 }),
    ]);
    const second = pickOngoingItem([
      makeTodo('a', sameDeadline, { createdAt: NOW - 2000 }),
      makeTodo('b', sameDeadline, { createdAt: NOW - 1000 }),
    ]);

    expect(first?.todoId).toBe('a');
    expect(second?.todoId).toBe('a');
  });

  it('返回的对象只带原生需要的三个字段（不把 content 之类的东西送过桥）', () => {
    const item = pickOngoingItem([makeTodo('one', NOW + HOUR_MS, { content: '很长的正文' })]);

    expect(item).not.toBeNull();
    expect(Object.keys(item as object).sort()).toEqual(['deadline', 'title', 'todoId']);
    expect(JSON.stringify(item)).not.toContain('很长的正文');
  });

  it('不修改传入的数组（todos 是 React state 里的那份）', () => {
    const todos = [makeTodo('b', NOW + 2 * HOUR_MS), makeTodo('a', NOW + HOUR_MS)];
    const snapshot = todos.map((todo) => todo.id);

    pickOngoingItem(todos);

    expect(todos.map((todo) => todo.id)).toEqual(snapshot);
  });
});

describe('原生：OngoingService 的三个硬约束', () => {
  it('START_STICKY（被系统回收后自动重建）', () => {
    expect(SERVICE).toContain('return START_STICKY');
  });

  it('有独立的通知渠道 ongoing，IMPORTANCE_LOW + 静音 + 不显示角标', () => {
    expect(SERVICE).toContain('const val CHANNEL_ID = "ongoing"');
    expect(SERVICE).toContain('NotificationManager.IMPORTANCE_LOW');
    expect(SERVICE).toContain('setShowBadge(false)');
    expect(SERVICE).toContain('setSound(null, null)');
    expect(SERVICE).toContain('enableVibration(false)');
  });

  it('通知本身：常驻 + 只提示一次 + 静音', () => {
    expect(SERVICE).toContain('.setOngoing(true)');
    expect(SERVICE).toContain('.setOnlyAlertOnce(true)');
    expect(SERVICE).toContain('.setSilent(true)');
  });

  it('重建时从磁盘读回内容（START_STICKY 重启拿到的是空 Intent）', () => {
    expect(SERVICE).toContain('ReminderStore.loadOngoing(this)');
    expect(STORE).toContain('KEY_ONGOING_ITEM = "ongoing_item"');
  });

  it('onDestroy 里不调 stopForeground（否则 START_STICKY 重启时通知会闪一下）', () => {
    const destroyStart = SERVICE.indexOf('override fun onDestroy()');
    expect(destroyStart).toBeGreaterThan(-1);
    const destroyEnd = SERVICE.indexOf('private fun startForegroundCompat');
    expect(destroyEnd).toBeGreaterThan(destroyStart);

    expect(SERVICE.slice(destroyStart, destroyEnd)).not.toContain('stopForeground');
  });

  it('点通知能定位到那一条待办（复用 pending_open_todo）', () => {
    expect(SERVICE).toContain('putExtra(ReminderStore.EXTRA_TODO_ID, item.todoId)');
  });

  it('Android 14 起用 ServiceCompat + specialUse type 提交前台通知', () => {
    expect(SERVICE).toContain('ServiceCompat.startForeground');
    expect(SERVICE).toContain('FOREGROUND_SERVICE_TYPE_SPECIAL_USE');
  });
});

describe('manifest：前台服务权限、type 与用途说明', () => {
  it('声明 FOREGROUND_SERVICE 与 FOREGROUND_SERVICE_SPECIAL_USE', () => {
    expect(MANIFEST).toContain('android.permission.FOREGROUND_SERVICE"');
    expect(MANIFEST).toContain('android.permission.FOREGROUND_SERVICE_SPECIAL_USE');
  });

  it('service 不出现在外部应用面前，且标明 specialUse', () => {
    expect(MANIFEST).toContain('android:name=".OngoingService"');
    expect(MANIFEST).toContain('android:exported="false"');
    expect(MANIFEST).toContain('android:foregroundServiceType="specialUse"');
  });

  it('写明 FGS 用途（Play 审核与系统都要求）', () => {
    expect(MANIFEST).toContain('android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE');
    expect(MANIFEST).toContain('在通知栏常驻显示最近一件即将到期的待办');
  });
});

describe('JS → 原生：updateOngoing 的调用链', () => {
  it('插件有 updateOngoing 方法与 item 参数', () => {
    expect(PLUGIN).toMatch(/@PluginMethod\s+fun updateOngoing\(call: PluginCall\)/);
    expect(PLUGIN).toContain('call.getObject("item")');
  });

  it('item 为空时停止服务，非空时启动', () => {
    expect(PLUGIN).toContain('OngoingService.stop(context)');
    expect(PLUGIN).toContain('OngoingService.start(context)');
  });

  it('启动失败不能崩（Android 12+ 后台启动限制），且要留下日志', () => {
    expect(PLUGIN).toContain('Log.w(TAG, "更新常驻通知失败，下次回到前台会重试", error)');
    expect(PLUGIN).toMatch(/catch \(error: Exception\) \{\s*\/\/[^\n]*\n\s*Log\.w\(TAG, "更新常驻通知失败/);
  });

  it('桥接层 updateOngoing 只在原生环境调，且失败静默', () => {
    expect(BRIDGE).toContain('export async function updateOngoing(item: OngoingItem | null): Promise<void>');
    const block = BRIDGE.slice(BRIDGE.indexOf('export async function updateOngoing'));
    expect(block.slice(0, 400)).toContain('if (!isNativePlatform())');
    expect(block).toContain('ReminderAlarm.updateOngoing({ item })');
  });

  it('App 每次落数据后都刷新常驻通知', () => {
    expect(APP).toContain('void updateOngoing(pickOngoingItem(sorted));');
  });

  it('注释里写清了「为什么由 JS 算这条规则」', () => {
    // 口径改过之后，「不知道哪条是重复任务」这句不再成立（重复任务现在也参与），
    // 新的理由是「不知道哪条已完成 / 没设时间」
    expect(APP).toContain('原生只有闹钟列表，不知道哪条已完成 / 没设时间');
  });
});
