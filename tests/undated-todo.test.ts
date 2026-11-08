import { beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, reminderOffsetsFor } from '../shared/reminders';
import { planRemindersFor } from '../shared/reminders';
import type { RepeatRule, Todo } from '../shared/types';
import { NO_REPEAT } from '../shared/types';
import { compileAlarmsWithStats, countPendingAlarms, nextDeadlineFor } from '../src/lib/alarms';
import { STORAGE_KEY, api, readTodos, sortTodos } from '../src/lib/api';
import { groupTodos } from '../src/lib/group-todos';

/**
 * B1–B6：「不设截止时间」与「仅到点提醒」这两条新语义的回归测试。
 *
 * 需求原话：「可以允许不设置截止时间或者不进行提前提醒，但是默认会提前提醒」。
 *
 * 这里要钉住的核心不变量只有一条：
 * **`null` 不是 0。** 任何地方让 `null` 参与减法/比较，都会变成 1970 年，
 * 于是「无期限」的待办会被判成「已逾期 56 年」顶到列表最前面，
 * 并且试图给它排一堆过去的闹钟。所以每一条断言都在检查「先判 null、再算数」。
 */

/** 最小可用的 localStorage 垫片（Node 环境没有） */
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

const NOW = new Date(2026, 2, 3, 20, 0, 0, 0).getTime();

/**
 * 构造一条待办。
 *
 * @param id 待办 id
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

beforeEach(() => {
  storage.clear();
});

describe('B2 提醒逻辑：deadline 为 null 时不产生任何提醒', () => {
  it('planRemindersFor(null, ...) 返回空数组（不管重复规则与开关怎么配）', () => {
    expect(planRemindersFor(null, NO_REPEAT, NOW)).toEqual([]);
    expect(planRemindersFor(null, { kind: 'daily' }, NOW)).toEqual([]);
    expect(planRemindersFor(null, { kind: 'weekly', weekdays: [1, 2] }, NOW, false)).toEqual([]);
    // 非有限值同样当作「没有时间」，不能算出 NaN 的 fireAt 排进系统
    expect(planRemindersFor(Number.NaN, NO_REPEAT, NOW)).toEqual([]);
  });

  it('compileAlarmsWithStats 对无期限待办返回 { alarms: [], truncated: 0 }（不计入活跃条数，也不污染 truncated）', () => {
    const undated = makeTodo('undated', { deadline: null });
    const dated = makeTodo('dated', { deadline: NOW + 8 * DAY_MS });

    expect(compileAlarmsWithStats([undated], NOW)).toEqual({ alarms: [], truncated: 0 });

    // 混在一起时：名额按「有时间的 1 条」算，别让无期限的待办把配额摊薄
    const mixed = compileAlarmsWithStats([undated, dated], NOW);
    expect(mixed.alarms.every((alarm) => alarm.todoId === 'dated')).toBe(true);
    expect(mixed.alarms).toHaveLength(6);
    expect(mixed.truncated).toBe(0);
  });
});

describe('B2 advanceReminder=false：只在到点那一刻提醒一次', () => {
  it('未来的截止时间 → 恰好 1 条，kind 是 due，fireAt 就是 deadline', () => {
    const deadline = NOW + 9 * DAY_MS;
    const plans = planRemindersFor(deadline, NO_REPEAT, NOW, false);

    expect(plans).toHaveLength(1);
    expect(plans[0]).toEqual({ kind: 'due', fireAt: deadline });

    const { alarms } = compileAlarmsWithStats(
      [makeTodo('only-due', { deadline, advanceReminder: false })],
      NOW,
    );
    expect(alarms).toHaveLength(1);
    expect(alarms[0].kind).toBe('due');
    expect(alarms[0].fireAt).toBe(deadline);
    expect(alarms[0].deadline).toBe(deadline);
  });

  it('已经过去的截止时间 → 0 条（不回补）', () => {
    const past = NOW - HOUR_MS;
    expect(planRemindersFor(past, NO_REPEAT, NOW, false)).toEqual([]);
    expect(
      compileAlarmsWithStats([makeTodo('past', { deadline: past, advanceReminder: false })], NOW).alarms,
    ).toEqual([]);
  });

  it('每天重复 + 关闭提前提醒 → 每个实例各 1 条 due（不是每个实例 3 条）', () => {
    const todo = makeTodo('daily-due', {
      deadline: NOW + 2 * HOUR_MS,
      repeat: { kind: 'daily' },
      advanceReminder: false,
    });
    const { alarms } = compileAlarmsWithStats([todo], NOW);

    // 30 天窗内的实例数远多于 24，被实例上限兜住
    expect(alarms.length).toBeGreaterThan(1);
    expect(new Set(alarms.map((alarm) => alarm.kind))).toEqual(new Set(['due']));
    // 每条闹钟的 fireAt 必须等于它自己那个实例的 deadline
    for (const alarm of alarms) {
      expect(alarm.fireAt).toBe(alarm.deadline);
      expect(alarm.fireAt).toBeGreaterThan(NOW);
    }
    // 实例互不重复
    expect(new Set(alarms.map((alarm) => alarm.deadline)).size).toBe(alarms.length);
  });

  it('countPendingAlarms / nextDeadlineFor 也认这个开关（界面上的「还有 N 档」不能骗人）', () => {
    const deadline = NOW + 10 * DAY_MS;
    const advance = makeTodo('a', { deadline });
    const dueOnly = makeTodo('b', { deadline, advanceReminder: false });

    expect(countPendingAlarms(advance, NOW)).toBe(6);
    expect(countPendingAlarms(dueOnly, NOW)).toBe(1);
    // 下一次到期时间与开关无关（关掉提前提醒不等于没有截止时间）
    expect(nextDeadlineFor(dueOnly, NOW)).toBe(deadline);
    expect(nextDeadlineFor(makeTodo('c', { deadline: null }), NOW)).toBeNull();
  });
});

describe('B2 reminderOffsetsFor：加可选参数，不改原有行为', () => {
  it('不传第二个参数时结果与"显式传 true"完全一致（QA 现有断言一条都不用动）', () => {
    const cases: RepeatRule[] = [
      NO_REPEAT,
      { kind: 'daily' },
      { kind: 'weekly', weekdays: [1, 4] },
      { kind: 'monthly', dayOfMonth: 15 },
      { kind: 'interval', intervalMs: 6 * HOUR_MS },
      { kind: 'interval', intervalMs: 3 * DAY_MS },
      { kind: 'interval', intervalMs: 15 * 60_000 },
    ];

    for (const repeat of cases) {
      expect(reminderOffsetsFor(repeat)).toEqual(reminderOffsetsFor(repeat, true));
    }
    // 六档的定义没有被改动（一次性任务仍然是完整六档）
    expect(reminderOffsetsFor(NO_REPEAT).map((offset) => offset.kind)).toEqual([
      '7d', '3d', '1d', '3h', '1h', 'due',
    ]);
    expect(reminderOffsetsFor({ kind: 'daily' }).map((offset) => offset.kind)).toEqual(['3h', '1h', 'due']);
  });

  it('advance=false 时任何重复规则都只剩 due 一档', () => {
    for (const repeat of [NO_REPEAT, { kind: 'daily' } as RepeatRule, { kind: 'interval', intervalMs: 15 * 60_000 } as RepeatRule]) {
      expect(reminderOffsetsFor(repeat, false).map((offset) => offset.kind)).toEqual(['due']);
    }
  });
});

describe('B1 数据模型：老数据补默认值，null 才允许无期限', () => {
  it('v2 老数据缺 advanceReminder → 读出来是 true（默认「会提前提醒」不能被静默关掉）', () => {
    // 一个「B1 之前」的 v2 存档：没有 advanceReminder，deadline 一定有值
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        todos: [
          {
            id: 'old-1',
            title: '旧待办',
            content: '',
            deadline: NOW + 5 * DAY_MS,
            done: false,
            repeat: { kind: 'daily' },
            createdAt: NOW - DAY_MS,
            updatedAt: NOW - DAY_MS,
          },
        ],
      }),
    );

    const todos = readTodos();
    expect(todos).toHaveLength(1);
    expect(todos[0].advanceReminder).toBe(true);
    expect(todos[0].deadline).toBe(NOW + 5 * DAY_MS);
    // 老数据仍然按六档（daily → 3 档）排提醒
    expect(countPendingAlarms(todos[0], NOW)).toBeGreaterThan(0);
  });

  it('储存键仍然是 zuoleme.todos.v2（不升版本：新字段是加法，老版本读到也只当作未知字段）', () => {
    expect(STORAGE_KEY).toBe('zuoleme.todos.v2');
  });

  it('缺 deadline 的记录被读成「无期限」，不再被当成脏数据丢弃', () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        todos: [
          { id: 'no-deadline', title: '没有时间', content: '', done: false, repeat: { kind: 'none' }, createdAt: 1, updatedAt: 1 },
        ],
      }),
    );

    const todos = readTodos();
    expect(todos).toHaveLength(1);
    expect(todos[0].deadline).toBeNull();
    expect(todos[0].advanceReminder).toBe(true);
  });

  it('createTodo 允许 null deadline，并强制把 repeat 归零、advanceReminder 回 true', async () => {
    const created = await api.createTodo({
      title: '想做的事',
      content: '',
      deadline: null,
      // 用户即使传了重复与关闭提前提醒，也不能留在数据里（没有时间锚点，它们无意义）
      repeat: { kind: 'daily' },
      advanceReminder: false,
    });

    expect(created.deadline).toBeNull();
    expect(created.repeat).toEqual({ kind: 'none' });
    expect(created.advanceReminder).toBe(true);
    expect(compileAlarmsWithStats([created], NOW).alarms).toEqual([]);
  });

  it('读盘路径（normalizeTodo）也强制归零：老数据里「无期限 + 每周」的非法组合进不来', () => {
    // 三种入口都要有这层强制，否则下面这种记录（v1 老数据 / 手工改 localStorage / 将来的同步）
    // 会钻进「deadline 为 null 但 repeat 是 weekly」的非法组合，重复规则再也无法推进。
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        todos: [
          {
            id: 'illegal',
            title: '非法组合',
            content: '',
            deadline: null,
            repeat: { kind: 'weekly', weekdays: [1, 2, 3] },
            advanceReminder: false,
            done: false,
            createdAt: NOW - DAY_MS,
            updatedAt: NOW - DAY_MS,
          },
        ],
      }),
    );

    const [todo] = readTodos();
    expect(todo.deadline).toBeNull();
    expect(todo.repeat).toEqual({ kind: 'none' });
    expect(todo.advanceReminder).toBe(true);
    // 而且真的不会排出任何闹钟（不会拿 null 算出 NaN 的 fireAt）
    expect(compileAlarmsWithStats([todo], NOW)).toEqual({ alarms: [], truncated: 0 });
  });

  it('createTodo 仍然拒绝「过去的时间」（有时间的待办规则没有被放松）', async () => {
    await expect(
      api.createTodo({ title: '过去的', content: '', deadline: Date.now() - 1 }),
    ).rejects.toThrow('截止时间必须晚于现在');
  });
});

describe('B5 updateTodo：把时间清空时，同一事务里把相关字段归位', () => {
  it('updateTodo({ deadline: null }) → deadline 为 null、repeat 变 none、advanceReminder 回 true，且不再产生闹钟', async () => {
    const created = await api.createTodo({
      title: '有时间的',
      content: '',
      deadline: Date.now() + 10 * DAY_MS,
      repeat: { kind: 'daily' },
      advanceReminder: false,
    });
    expect(created.repeat).toEqual({ kind: 'daily' });
    expect(created.advanceReminder).toBe(false);

    const updated = await api.updateTodo(created.id, { deadline: null });

    expect(updated.deadline).toBeNull();
    expect(updated.repeat).toEqual({ kind: 'none' });
    expect(updated.advanceReminder).toBe(true);
    expect(compileAlarmsWithStats([updated], Date.now()).alarms).toEqual([]);

    // 落盘的数据也必须是归位后的（不能只在返回值里归位）
    const persisted = readTodos().find((todo) => todo.id === created.id);
    expect(persisted?.deadline).toBeNull();
    expect(persisted?.repeat).toEqual({ kind: 'none' });
  });

  it('从无期限改回有时间：advanceReminder 默认回到 true，显式 false 才关', async () => {
    const created = await api.createTodo({ title: '无期限', content: '', deadline: null });

    const back = await api.updateTodo(created.id, { deadline: Date.now() + 3 * DAY_MS });
    expect(back.deadline).not.toBeNull();
    expect(back.advanceReminder).toBe(true);

    const quiet = await api.updateTodo(created.id, {
      deadline: Date.now() + 3 * DAY_MS,
      advanceReminder: false,
    });
    expect(quiet.advanceReminder).toBe(false);
    expect(planRemindersFor(quiet.deadline, quiet.repeat, Date.now(), quiet.advanceReminder)).toHaveLength(1);
  });

  it('完成一条无期限待办 = 真的标记完成（不会卡在"永远做不完"）', async () => {
    const created = await api.createTodo({ title: '无期限待办', content: '', deadline: null });
    const done = await api.updateTodo(created.id, { done: true });

    expect(done.done).toBe(true);
    expect(done.deadline).toBeNull();
    expect(compileAlarmsWithStats([done], Date.now()).alarms).toEqual([]);
  });
});

describe('B4 排序与分组：无期限的排在最后，且绝不算"已逾期"', () => {
  it('sortTodos：有时间的按时间升序 → 无时间的排在后面 → 已完成的永远最后', () => {
    const overdue = makeTodo('overdue', { deadline: NOW - HOUR_MS });
    const soon = makeTodo('soon', { deadline: NOW + HOUR_MS });
    const undatedA = makeTodo('undated-a', { deadline: null, createdAt: NOW - 5 * DAY_MS });
    const undatedB = makeTodo('undated-b', { deadline: null, createdAt: NOW - 2 * DAY_MS });
    const doneDated = makeTodo('done-dated', { deadline: NOW - 2 * HOUR_MS, done: true });
    const doneUndated = makeTodo('done-undated', { deadline: null, done: true });

    const sorted = sortTodos([doneUndated, undatedB, soon, overdue, doneDated, undatedA]);

    expect(sorted.map((todo) => todo.id)).toEqual([
      'overdue',
      'soon',
      // 两条无期限的按创建时间升序，且都排在"有时间"的后面
      'undated-a',
      'undated-b',
      // 已完成的最后
      'done-dated',
      'done-undated',
    ]);
  });

  it('groupTodos：无期限进"无期限"组，排在"以后"之后，绝不进"已逾期"', () => {
    const todos = [
      makeTodo('overdue', { deadline: NOW - HOUR_MS }),
      makeTodo('today', { deadline: NOW + 2 * HOUR_MS }),
      makeTodo('later', { deadline: NOW + 20 * DAY_MS }),
      makeTodo('undated', { deadline: null }),
    ];

    const groups = groupTodos(todos, NOW);
    expect(groups.map((group) => group.key)).toEqual(['overdue', 'today', 'later', 'undated']);
    expect(groups.map((group) => group.label)).toEqual(['已逾期', '今天', '以后', '无期限']);
    expect(groups.find((group) => group.key === 'overdue')?.todos.map((todo) => todo.id)).toEqual(['overdue']);
    expect(groups.find((group) => group.key === 'undated')?.todos.map((todo) => todo.id)).toEqual(['undated']);
  });

  it('groupTodos：只有无期限待办时也能正常出组（不会因为空前 5 组而出错）', () => {
    const groups = groupTodos([makeTodo('only', { deadline: null })], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('undated');
  });
});
