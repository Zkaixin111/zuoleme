import { beforeEach, describe, expect, it } from 'vitest';
import {
  DAY_MS,
  HOUR_MS,
  reminderOffsetsFor,
  planReminders,
  planRemindersFor,
} from '../shared/reminders';
import { nextOccurrence } from '../shared/repeat';
import type { Todo } from '../shared/types';
import { NO_REPEAT } from '../shared/types';
import {
  MAX_ALARMS,
  MAX_INSTANCES_PER_TODO,
  compileAlarmsWithStats,
} from '../src/lib/alarms';
import { STORAGE_KEY, api, readTodos, sortTodos } from '../src/lib/api';
import { groupTodos } from '../src/lib/group-todos';

/**
 * QA-3（严过关）独立终轮验收：专门攻击「新需求 × 老数据 × 老功能」的交界缝。
 *
 * 这份文件刻意不复用 GitHub 上已有的 undated-todo / alarm-scale 用例，
 * 而是换数据集、换入口（本地存储注入、updateTodo、混合批次），
 * 目标是让「测试全绿但其实有缝」的实现在这里现形。
 */

/** 最小 localStorage 垫片（Node 环境没有） */
class MemoryStorage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    const value = this.map.get(key);
    return value === undefined ? null : value;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

const storage = new MemoryStorage();
(globalThis as unknown as { window: { localStorage: MemoryStorage } }).window = { localStorage: storage };

/** 纯函数用注入时间；`api.createTodo` 内部用真实 `Date.now()`，需要相对真实时间构造 */
const NOW = new Date(2026, 2, 3, 20, 0, 0, 0).getTime();
const REAL_NOW = Date.now();

/**
 * 构造一条待办。
 *
 * @param id id
 * @param overrides 覆盖字段
 */
function makeTodo(id: string, overrides: Partial<Todo> = {}): Todo {
  return {
    id,
    title: `待办 ${id}`,
    content: '',
    advanceReminder: true,
    deadline: NOW + 10 * DAY_MS,
    done: false,
    repeat: NO_REPEAT,
    createdAt: NOW - DAY_MS,
    updatedAt: NOW - DAY_MS,
    ...overrides,
  };
}

/**
 * 独立计算一条待办的「理论候选闹钟」fireAt 列表（不复用被测实现）。
 *
 * 刻意按规格复刻：实例数上限 `MAX_INSTANCES_PER_TODO`、30 天窗口、
 * 「只保留严格晚于 now 的档位」。用来给 `truncated` 对账。
 *
 * @param todo 待办（deadline 必须有值）
 * @param now 当前时间
 */
function referenceFireAts(todo: Todo & { deadline: number }, now: number): number[] {
  const horizon = now + 30 * DAY_MS;
  const offsets = reminderOffsetsFor(todo.repeat, todo.advanceReminder);
  const result: number[] = [];

  const pushInstance = (deadline: number): void => {
    for (const offset of offsets) {
      const fireAt = deadline - offset.offsetMs;
      if (fireAt > now) {
        result.push(fireAt);
      }
    }
  };

  if (todo.repeat.kind === 'none') {
    if (todo.deadline > now) {
      pushInstance(todo.deadline);
    }
    return result;
  }

  const instances: number[] = [];
  let cursor = todo.deadline;
  let guard = 0;
  while (cursor <= now && guard < 5000) {
    const next = nextOccurrence(cursor, todo.repeat, now);
    if (next === null) {
      return result;
    }
    cursor = next;
    guard += 1;
  }
  while (cursor < horizon && instances.length < MAX_INSTANCES_PER_TODO) {
    instances.push(cursor);
    const next = nextOccurrence(cursor, todo.repeat, cursor);
    if (next === null || next <= cursor) {
      break;
    }
    cursor = next;
  }
  for (const instance of instances) {
    pushInstance(instance);
  }
  return result;
}

beforeEach(() => {
  storage.clear();
});

// ---------------------------------------------------------------------------
// A. 无期限待办的完整生命周期
// ---------------------------------------------------------------------------
describe('A. 无期限待办：不产提醒、不占地盘、不被误判逾期', () => {
  it('A-1 混合批次：1 条有期限密集任务 + 29 条无期限 —— 有期限的仍拿到它的全部 70 条（无期限按批次数摊薄名额就会掉到 8）', () => {
    const dense = makeTodo('dense', {
      deadline: NOW + 30 * 60_000,
      repeat: { kind: 'interval', intervalMs: 6 * HOUR_MS },
    });
    const undated: Todo[] = [];
    for (let index = 0; index < 29; index += 1) {
      undated.push(makeTodo(`undated-${index}`, { deadline: null }));
    }

    const result = compileAlarmsWithStats([dense, ...undated], NOW);
    const expected = referenceFireAts(dense as Todo & { deadline: number }, NOW);

    expect(expected.length).toBe(70);
    expect(result.alarms).toHaveLength(expected.length);
    expect(result.truncated).toBe(0);
    // 全部闹钟都来自 dense，无期限的一个都不许混进来
    expect(new Set(result.alarms.map((alarm) => alarm.todoId))).toEqual(new Set(['dense']));
  });

  it('A-2 同批 6 条有期限 + 1 条无期限：每条有期限的仍拿满完整 6 档（共 36 条）', () => {
    const dated: Todo[] = [];
    for (let index = 0; index < 6; index += 1) {
      dated.push(makeTodo(`d-${index}`, { deadline: NOW + 8 * DAY_MS + index * HOUR_MS }));
    }
    const undated = makeTodo('u-1', { deadline: null });

    const result = compileAlarmsWithStats([...dated, undated], NOW);

    expect(result.alarms).toHaveLength(36);
    for (const todo of dated) {
      const kinds = result.alarms
        .filter((alarm) => alarm.todoId === todo.id)
        .map((alarm) => alarm.kind);
      expect(kinds).toEqual(['7d', '3d', '1d', '3h', '1h', 'due']);
    }
    expect(result.alarms.some((alarm) => alarm.todoId === 'u-1')).toBe(false);
  });

  it('A-3 sortTodos：无期限的排在「有期限未完成」之后、「已完成」之前，且不产生 NaN', () => {
    const dated = makeTodo('dated', { deadline: NOW + 2 * DAY_MS, createdAt: NOW - 5 });
    const undatedNew = makeTodo('undated-new', { deadline: null, createdAt: NOW - 1 });
    const undatedOld = makeTodo('undated-old', { deadline: null, createdAt: NOW - 100 });
    const doneDated = makeTodo('done', { deadline: NOW + DAY_MS, done: true });
    const doneUndated = makeTodo('done-undated', { deadline: null, done: true });

    const sorted = sortTodos([doneDated, undatedNew, dated, doneUndated, undatedOld]).map((todo) => todo.id);

    // 未完成：有期限在前；无期限按 createdAt 升序；已完成永远最后
    expect(sorted.slice(0, 3)).toEqual(['dated', 'undated-old', 'undated-new']);
    expect(new Set(sorted.slice(3))).toEqual(new Set(['done', 'done-undated']));
    // 排序键里绝不能出现 NaN（null 参与减法会变 0，曾经把无期限顶到最前）
    for (const todo of sortTodos([undatedNew, dated])) {
      expect(Number.isNaN(todo.createdAt)).toBe(false);
    }
  });

  it('A-4 groupTodos：无期限进「无期限」组；今天 23:59 / 明天 00:01 / 昨天 23:59 各归各的组', () => {
    const todayStart = new Date(NOW).setHours(0, 0, 0, 0);
    const groups = groupTodos(
      [
        makeTodo('today-2359', { deadline: todayStart + 23 * HOUR_MS + 59 * 60_000 }),
        makeTodo('tomorrow-0001', { deadline: todayStart + DAY_MS + 60_000 }),
        makeTodo('yesterday-2359', { deadline: todayStart - 60_000 }),
        makeTodo('undated', { deadline: null }),
      ],
      NOW,
    );

    const groupOf = (id: string): string | undefined =>
      groups.find((group) => group.todos.some((todo) => todo.id === id))?.key;

    expect(groupOf('today-2359')).toBe('today');
    expect(groupOf('tomorrow-0001')).toBe('tomorrow');
    expect(groupOf('yesterday-2359')).toBe('overdue');
    expect(groupOf('undated')).toBe('undated');
    // 顺序：已逾期在最前，无期限在最后
    expect(groups[0].key).toBe('overdue');
    expect(groups[groups.length - 1].key).toBe('undated');
  });
});

// ---------------------------------------------------------------------------
// B. 仅到点提醒
// ---------------------------------------------------------------------------
describe('B. advanceReminder=false：只在到点那一刻提醒一次', () => {
  it('B-1 未来 deadline → 恰好 1 条 due，fireAt === deadline', () => {
    const deadline = NOW + 3 * DAY_MS;
    const alarms = compileAlarmsWithStats(
      [makeTodo('x', { deadline, advanceReminder: false })],
      NOW,
    ).alarms;
    expect(alarms).toHaveLength(1);
    expect(alarms[0].kind).toBe('due');
    expect(alarms[0].fireAt).toBe(deadline);
    expect(planRemindersFor(deadline, NO_REPEAT, NOW, false)).toEqual([{ kind: 'due', fireAt: deadline }]);
  });

  it('B-2 已过 deadline → 0 条', () => {
    const past = NOW - HOUR_MS;
    expect(
      compileAlarmsWithStats([makeTodo('x', { deadline: past, advanceReminder: false })], NOW).alarms,
    ).toHaveLength(0);
    expect(planRemindersFor(past, NO_REPEAT, NOW, false)).toEqual([]);
  });

  it('B-3 每天重复 + 关闭提前提醒 → 每个实例恰好 1 条（不是 3 条）', () => {
    const deadline = NOW + 10 * 60_000;
    const alarms = compileAlarmsWithStats(
      [makeTodo('daily', { deadline, advanceReminder: false, repeat: { kind: 'daily' } })],
      NOW,
    ).alarms;

    expect(reminderOffsetsFor({ kind: 'daily' }, false)).toHaveLength(1);
    expect(alarms.length).toBe(MAX_INSTANCES_PER_TODO);
    expect(alarms.every((alarm) => alarm.kind === 'due')).toBe(true);
    // 每个实例 1 条 → 24 个不同的 fireAt
    expect(new Set(alarms.map((alarm) => alarm.fireAt)).size).toBe(MAX_INSTANCES_PER_TODO);
  });

  it('B-4 每月重复 + 关闭提前提醒 → 每个实例 1 条（不是 6 条）', () => {
    const deadline = NOW + 5 * 60_000;
    const alarms = compileAlarmsWithStats(
      [makeTodo('monthly', { deadline, advanceReminder: false, repeat: { kind: 'monthly', dayOfMonth: 3 } })],
      NOW,
    ).alarms;

    expect(reminderOffsetsFor({ kind: 'monthly', dayOfMonth: 3 }, false)).toHaveLength(1);
    expect(alarms.length).toBeGreaterThanOrEqual(1);
    expect(alarms.every((alarm) => alarm.kind === 'due')).toBe(true);
    // 30 天窗口内 monthly 最多 1~2 个实例，但每实例只有 1 条
    expect(alarms.length).toBe(new Set(alarms.map((alarm) => alarm.deadline)).size);
  });
});

// ---------------------------------------------------------------------------
// C. 非法组合的强制归零（三条入口都要堵住）
// ---------------------------------------------------------------------------
describe('C. 「deadline=null + repeat=weekly + advanceReminder=false」三条入口全部强制归零', () => {
  const illegalRepeat = { kind: 'weekly' as const, weekdays: [1] };

  it('C-1 createTodo 入口', async () => {
    const created = await api.createTodo({
      title: '非法组合',
      deadline: null,
      repeat: illegalRepeat,
      advanceReminder: false,
    });
    expect(created.deadline).toBeNull();
    expect(created.repeat).toEqual({ kind: 'none' });
    expect(created.advanceReminder).toBe(true);
  });

  it('C-2 updateTodo({ deadline: null }) 入口（原记录是有期限 + 每周 + 关闭提前提醒）', async () => {
    const created = await api.createTodo({
      title: '有期限每周',
      deadline: REAL_NOW + 5 * DAY_MS,
      repeat: illegalRepeat,
      advanceReminder: false,
    });
    // 先确认基线：这条记录确实是「每周 + 关闭提前提醒」
    expect(created.repeat).toEqual(illegalRepeat);
    expect(created.advanceReminder).toBe(false);

    const updated = await api.updateTodo(created.id, { deadline: null });
    expect(updated.deadline).toBeNull();
    expect(updated.repeat).toEqual({ kind: 'none' });
    expect(updated.advanceReminder).toBe(true);

    // 落盘后重新读，仍然是被归零的形态
    const reloaded = readTodos().find((todo) => todo.id === created.id);
    expect(reloaded?.repeat).toEqual({ kind: 'none' });
    expect(reloaded?.advanceReminder).toBe(true);
  });

  it('C-3 直接往 localStorage 塞非法结构，readTodos() 必须把它规整成合法形态', () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        todos: [
          {
            id: 'injected',
            title: '手工改存储',
            content: '',
            deadline: null,
            advanceReminder: false,
            done: false,
            repeat: { kind: 'weekly', weekdays: [1] },
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      }),
    );

    const todos = readTodos();
    expect(todos).toHaveLength(1);
    expect(todos[0].deadline).toBeNull();
    expect(todos[0].repeat).toEqual({ kind: 'none' });
    expect(todos[0].advanceReminder).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D. 老数据兼容
// ---------------------------------------------------------------------------
describe('D. v2 老数据兼容：缺字段补默认值，不当脏数据丢', () => {
  it('D-1 缺 advanceReminder → true；deadline 正常数字原样保留', () => {
    const deadline = NOW + 6 * DAY_MS;
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        todos: [
          { id: 'legacy', title: '老数据', content: '', deadline, done: false, repeat: { kind: 'none' }, createdAt: NOW, updatedAt: NOW },
        ],
      }),
    );
    const todos = readTodos();
    expect(todos).toHaveLength(1);
    expect(todos[0].advanceReminder).toBe(true);
    expect(todos[0].deadline).toBe(deadline);
  });

  it('D-2 混一条 deadline:null → 识别为无期限（不是脏数据被丢）', () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        todos: [
          { id: 'dated', title: '有期限', content: '', deadline: NOW + DAY_MS, done: false, repeat: { kind: 'none' }, createdAt: NOW, updatedAt: NOW },
          { id: 'undated', title: '无期限', content: '', deadline: null, done: false, repeat: { kind: 'none' }, createdAt: NOW, updatedAt: NOW },
        ],
      }),
    );
    const todos = readTodos();
    expect(todos.map((todo) => todo.id).sort()).toEqual(['dated', 'undated']);
    expect(todos.find((todo) => todo.id === 'undated')?.deadline).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// E. 编辑路径（数据层不变量）
// ---------------------------------------------------------------------------
describe('E. 编辑路径：有期限 → 无期限 → 再有期限', () => {
  it('E-1 来回切换后 advanceReminder 回到 true、repeat 仍是 none', async () => {
    const created = await api.createTodo({ title: "来回切换", deadline: REAL_NOW + 4 * DAY_MS });

    await api.updateTodo(created.id, { deadline: null });
    const back = await api.updateTodo(created.id, { deadline: REAL_NOW + 9 * DAY_MS });

    expect(back.deadline).toBe(REAL_NOW + 9 * DAY_MS);
    expect(back.advanceReminder).toBe(true);
    expect(back.repeat).toEqual({ kind: 'none' });
  });

  it('E-2 关闭提前提醒并保存 → 重新读取仍然是 false（开关状态能回填）', async () => {
    const created = await api.createTodo({ title: "关掉提前提醒", deadline: REAL_NOW + 4 * DAY_MS });
    await api.updateTodo(created.id, { advanceReminder: false });

    const reloaded = readTodos().find((todo) => todo.id === created.id);
    expect(reloaded?.advanceReminder).toBe(false);
    // 关掉提前提醒后，当前实例只剩 due 一档
    const alarms = compileAlarmsWithStats([reloaded as Todo], NOW).alarms;
    expect(alarms.every((alarm) => alarm.kind === 'due')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P1-1. 两级配额
// ---------------------------------------------------------------------------
describe('P1-1. 两级配额：单条不能吃光全局名额，100 条也不能有人彻底失声', () => {
  it('P1-1-a 复现原事故：1 条「每 15 分钟」+ 5 条 8 天后到期 → 5 条各拿满 6 档，密集任务 ≤ 24 实例', () => {
    const dense = makeTodo('dense', {
      deadline: NOW + 30 * 60_000,
      repeat: { kind: 'interval', intervalMs: 15 * 60_000 },
    });
    const normal: Todo[] = [];
    for (let index = 0; index < 5; index += 1) {
      normal.push(makeTodo(`n-${index}`, { deadline: NOW + 8 * DAY_MS + index * HOUR_MS }));
    }

    const result = compileAlarmsWithStats([dense, ...normal], NOW);
    const counts = new Map<string, number>();
    for (const alarm of result.alarms) {
      counts.set(alarm.todoId, (counts.get(alarm.todoId) ?? 0) + 1);
    }

    expect(result.alarms.length).toBeLessThanOrEqual(MAX_ALARMS);
    expect(counts.get('dense')).toBeLessThanOrEqual(MAX_INSTANCES_PER_TODO);
    for (const todo of normal) {
      expect(counts.get(todo.id), `${todo.id} 被密集任务挤掉`).toBe(6);
    }
    expect(result.truncated).toBe(0);
  });

  it('P1-1-b 50 条「每 6 小时」：第一级配额真的在丢条，truncated 必须 = 理论总数 − 240（含两级丢弃）', () => {
    const todos: Todo[] = [];
    for (let index = 0; index < 50; index += 1) {
      todos.push(
        makeTodo(`dense-${index}`, {
          deadline: NOW + 30 * 60_000,
          repeat: { kind: 'interval', intervalMs: 6 * HOUR_MS },
        }),
      );
    }

    // 独立算「理论候选总数」
    let totalCandidates = 0;
    for (const todo of todos) {
      totalCandidates += referenceFireAts(todo as Todo & { deadline: number }, NOW).length;
    }
    expect(totalCandidates).toBe(50 * 70);

    const result = compileAlarmsWithStats(todos, NOW);
    const counts = new Map<string, number>();
    for (const alarm of result.alarms) {
      counts.set(alarm.todoId, (counts.get(alarm.todoId) ?? 0) + 1);
    }

    expect(result.alarms).toHaveLength(MAX_ALARMS);
    // 关键：level-1（单条配额 8）丢掉的那些也必须计进 truncated
    expect(result.truncated).toBe(totalCandidates - MAX_ALARMS);
    // 没有任何一条待办彻底失声
    expect(todos.filter((todo) => (counts.get(todo.id) ?? 0) === 0)).toHaveLength(0);
  });

  it('P1-1-c 100 条一次性待办：保留 240、truncated=360、0 条待办数必须为 0、每条 ≥1', () => {
    const todos: Todo[] = [];
    for (let index = 0; index < 100; index += 1) {
      todos.push(makeTodo(`bulk-${index}`, { deadline: NOW + 8 * DAY_MS + index * HOUR_MS }));
    }

    const result = compileAlarmsWithStats(todos, NOW);
    const counts = new Map<string, number>();
    for (const alarm of result.alarms) {
      counts.set(alarm.todoId, (counts.get(alarm.todoId) ?? 0) + 1);
    }

    expect(result.alarms).toHaveLength(MAX_ALARMS);
    expect(result.truncated).toBe(600 - MAX_ALARMS);
    expect(todos.filter((todo) => (counts.get(todo.id) ?? 0) === 0)).toHaveLength(0);
    for (const todo of todos) {
      expect(counts.get(todo.id) ?? 0, `${todo.id} 一条都没拿到`).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 回归：老语义不能被新功能改坏
// ---------------------------------------------------------------------------
describe('回归. 一次性任务六档语义 & planReminders 签名行为一行未改', () => {
  it('R-1 10 天后到期 → 7d/3d/1d/3h/1h/due，fireAt 精确等于 deadline − 档位', () => {
    const deadline = NOW + 10 * DAY_MS;
    const alarms = compileAlarmsWithStats([makeTodo('one', { deadline })], NOW).alarms;

    const expected = [
      { kind: '7d', offset: 7 * DAY_MS },
      { kind: '3d', offset: 3 * DAY_MS },
      { kind: '1d', offset: DAY_MS },
      { kind: '3h', offset: 3 * HOUR_MS },
      { kind: '1h', offset: HOUR_MS },
      { kind: 'due', offset: 0 },
    ];
    expect(alarms.map((alarm) => alarm.kind)).toEqual(expected.map((item) => item.kind));
    for (let index = 0; index < expected.length; index += 1) {
      expect(alarms[index].fireAt).toBe(deadline - expected[index].offset);
    }
  });

  it('R-2 planReminders(deadline, now) 行为未变：10 天后 → 6 条升序', () => {
    const deadline = NOW + 10 * DAY_MS;
    const plans = planReminders(deadline, NOW);
    expect(plans).toHaveLength(6);
    expect(plans.map((item) => item.kind)).toEqual(['7d', '3d', '1d', '3h', '1h', 'due']);
    for (let index = 1; index < plans.length; index += 1) {
      expect(plans[index].fireAt).toBeGreaterThanOrEqual(plans[index - 1].fireAt);
    }
  });

  it('R-3 已完成任务产生 0 条闹钟（含无期限已完成）', () => {
    expect(compileAlarmsWithStats([makeTodo('done', { done: true })], NOW).alarms).toHaveLength(0);
    expect(
      compileAlarmsWithStats([makeTodo('done-undated', { done: true, deadline: null })], NOW).alarms,
    ).toHaveLength(0);
  });
});
