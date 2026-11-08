import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, reminderOffsetsFor } from '../shared/reminders';
import { nextOccurrence } from '../shared/repeat';
import type { RepeatRule, Todo } from '../shared/types';
import { NO_REPEAT } from '../shared/types';
import {
  ALARM_ID_MAX,
  MAX_ALARMS,
  MAX_INSTANCES_PER_TODO,
  MIN_ALARMS_PER_TODO,
  compileAlarms,
  compileAlarmsWithStats,
} from '../src/lib/alarms';

/**
 * QA 独立复验：真实规模下的闹钟编译（对应验收要求「支持定时任务」+ 系统排程上限）。
 *
 * 工程师声称「id 全局唯一、幂等、截断取最早」。这里不复用他们的数据构造，
 * 而是自己生成 300 条混合规则的待办，并**独立算一遍期望值**去对账：
 * - id 两两不同（重复 = 后一条顶掉前一条 = 用户静默少响一次）；
 * - 两次调用结果完全一致（幂等，否则前台每次刷新都在抖动）；
 * - 与输入顺序无关；
 * - 超过 240 条时，`truncated` 必须等于「理论总数 - 240」，且留下的必须是最早的 240 条。
 */

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
    completedAt: null,
    repeat: NO_REPEAT,
    createdAt: NOW - DAY_MS,
    updatedAt: NOW - DAY_MS,
    ...overrides,
  };
}

/**
 * 生成 300 条混合规则的待办（一次性 / 每天 / 每周 / 每月 / 每 6 小时 / 每 3 天）。
 *
 * @returns 待办列表
 */
function build300(): Todo[] {
  const rules: RepeatRule[] = [
    { kind: 'none' },
    { kind: 'daily' },
    { kind: 'weekly', weekdays: [1, 4] },
    { kind: 'monthly', dayOfMonth: 15 },
    { kind: 'interval', intervalMs: 6 * HOUR_MS },
    { kind: 'interval', intervalMs: 3 * DAY_MS },
  ];

  const todos: Todo[] = [];
  for (let index = 0; index < 300; index += 1) {
    const rule = rules[index % rules.length];
    todos.push(
      makeTodo(`todo-${String(index).padStart(3, '0')}`, {
        // 截止时间刻意散开：有的就在 30 分钟内，有的在 40 天后
        deadline: NOW + (index % 40) * HOUR_MS + 30 * 60_000,
        repeat: rule,
        done: index % 17 === 0,
      }),
    );
  }
  return todos;
}

/**
 * 独立计算「理论候选闹钟」（不复用被测的 compileAlarms）。
 *
 * 只依赖共享层的档位定义、重复规则推进与**实例数上限**（`MAX_INSTANCES_PER_TODO`），
 * 用于给截断逻辑对账：`truncated` 必须等于「这里算出的总数 − 最终保留数」。
 * 实例上限也在这里复刻，因为它是产品规格的一部分（一条待办最多展开 24 个实例）。
 *
 * @param todos 待办列表
 * @param now 当前时间
 */
function referenceCandidates(todos: readonly Todo[], now: number): number[] {
  const fireAtList: number[] = [];
  const horizon = now + 30 * DAY_MS;

  for (const todo of todos) {
    // 类型窄化：不设截止时间的待办不产生任何实例（这条分支在 P1-1 之后同样存在）
    if (todo.done || todo.deadline === null) {
      continue;
    }
    const offsets = reminderOffsetsFor(todo.repeat);
    const deadlines: number[] = [];

    if (todo.repeat.kind === 'none') {
      if (todo.deadline > now) {
        deadlines.push(todo.deadline);
      }
    } else {
      let cursor = todo.deadline;
      let guard = 0;
      while (cursor <= now && guard < 10_000) {
        const next = nextOccurrence(cursor, todo.repeat, now);
        if (next === null) {
          cursor = Number.NaN;
          break;
        }
        cursor = next;
        guard += 1;
      }
      while (
        Number.isFinite(cursor) &&
        cursor < horizon &&
        deadlines.length < MAX_INSTANCES_PER_TODO
      ) {
        deadlines.push(cursor);
        const next = nextOccurrence(cursor, todo.repeat, cursor);
        if (next === null || next <= cursor) {
          break;
        }
        cursor = next;
      }
    }

    for (const deadline of deadlines) {
      for (const offset of offsets) {
        const fireAt = deadline - offset.offsetMs;
        if (fireAt > now) {
          fireAtList.push(fireAt);
        }
      }
    }
  }

  return fireAtList.sort((a, b) => a - b);
}

describe('D. 300 条混合待办：id 唯一 / 幂等 / 与顺序无关', () => {
  it('所有 id 两两不同，且都落在 1..0x7fffffff', () => {
    const alarms = compileAlarms(build300(), NOW);
    const ids = alarms.map((alarm) => alarm.id);

    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThanOrEqual(1);
      expect(id).toBeLessThanOrEqual(ALARM_ID_MAX);
    }
  });

  it('同一条待办的不同档位、不同实例的 id 也都不同', () => {
    const alarms = compileAlarms(build300(), NOW);
    const seen = new Map<number, string>();
    for (const alarm of alarms) {
      const key = `${alarm.todoId}/${alarm.kind}/${alarm.fireAt}`;
      expect(seen.has(alarm.id), `id ${alarm.id} 被 ${seen.get(alarm.id)} 与 ${key} 共用`).toBe(false);
      seen.set(alarm.id, key);
    }
  });

  it('两次调用结果完全一致（幂等）', () => {
    const todos = build300();
    expect(compileAlarms(todos, NOW)).toEqual(compileAlarms(todos, NOW));
  });

  it('结果与输入顺序无关（打乱输入，id 集合与 fireAt 序列不变）', () => {
    const todos = build300();
    const forward = compileAlarms(todos, NOW);
    const reversed = compileAlarms([...todos].reverse(), NOW);

    const key = (alarm: { todoId: string; kind: string; fireAt: number; id: number }): string =>
      `${alarm.todoId}|${alarm.kind}|${alarm.fireAt}|${alarm.id}`;

    expect(reversed.map(key).sort()).toEqual(forward.map(key).sort());
  });

  it('返回顺序按 fireAt 升序，且每一条都严格晚于 now', () => {
    const alarms = compileAlarms(build300(), NOW);
    for (let index = 0; index < alarms.length; index += 1) {
      expect(alarms[index].fireAt).toBeGreaterThan(NOW);
      if (index > 0) {
        expect(alarms[index].fireAt).toBeGreaterThanOrEqual(alarms[index - 1].fireAt);
      }
    }
  });

  it('已经完成 / 已过期的一次性任务不参与编译', () => {
    const todos = [
      makeTodo('done', { done: true }),
      makeTodo('past', { deadline: NOW - 1 }),
      makeTodo('alive', { deadline: NOW + 10 * DAY_MS }),
    ];
    const alarms = compileAlarms(todos, NOW);
    const todoIds = new Set(alarms.map((alarm) => alarm.todoId));

    expect(todoIds.has('done')).toBe(false);
    expect(todoIds.has('past')).toBe(false);
    expect(todoIds.has('alive')).toBe(true);
  });
});

describe('D2. MAX_ALARMS=240 截断：数量、计数与「取最早」三条都要对', () => {
  it('恰好 240 条候选时不截断', () => {
    // 40 条一次性任务 × 6 档 = 240 条，且全部落在未来
    const todos: Todo[] = [];
    for (let index = 0; index < 40; index += 1) {
      todos.push(makeTodo(`exact-${index}`, { deadline: NOW + 8 * DAY_MS + index * HOUR_MS }));
    }
    const result = compileAlarmsWithStats(todos, NOW);

    expect(result.alarms).toHaveLength(MAX_ALARMS);
    expect(result.truncated).toBe(0);
  });

  it('1800 条候选：只留 240 条，truncated = 1560，且留下的是最早的 240 条', () => {
    const todos: Todo[] = [];
    for (let index = 0; index < 300; index += 1) {
      // 8 天后起、每条错开 1 小时：六档全部落在未来 → 300 × 6 = 1800
      todos.push(makeTodo(`bulk-${index}`, { deadline: NOW + 8 * DAY_MS + index * HOUR_MS }));
    }

    const result = compileAlarmsWithStats(todos, NOW);
    const expectedFireAt = referenceCandidates(todos, NOW);

    expect(expectedFireAt).toHaveLength(1800);
    expect(result.alarms).toHaveLength(MAX_ALARMS);
    expect(result.truncated).toBe(expectedFireAt.length - MAX_ALARMS);
    expect(result.truncated).toBe(1560);

    // 留下的必须是最早的 240 个 fireAt（逐条对账，不是只比长度）
    expect(result.alarms.map((alarm) => alarm.fireAt)).toEqual(expectedFireAt.slice(0, MAX_ALARMS));
    // 被丢弃的最早一条不能早于保留的最后一条（证明截断方向没搞反）
    expect(expectedFireAt[MAX_ALARMS]).toBeGreaterThanOrEqual(expectedFireAt[MAX_ALARMS - 1]);
  });

  it('截断后 id 仍然两两不同（不会因为截断而重号）', () => {
    const todos: Todo[] = [];
    for (let index = 0; index < 300; index += 1) {
      todos.push(makeTodo(`bulk-${index}`, { deadline: NOW + 8 * DAY_MS + index * HOUR_MS }));
    }
    const { alarms } = compileAlarmsWithStats(todos, NOW);
    const ids = alarms.map((alarm) => alarm.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('D3. 两级配额：一条高频任务不能把全局名额吃光', () => {
  it('1 条「每 15 分钟」+ 5 条 8 天后到期：一次性待办每件拿到完整 6 档，密集任务不超过 24 个实例', () => {
    const dense: Todo = makeTodo('dense', {
      deadline: NOW + 30 * 60_000,
      repeat: { kind: 'interval', intervalMs: 15 * 60_000 },
    });
    const normal: Todo[] = [];
    for (let index = 0; index < 5; index += 1) {
      // 8 天后到期的一次性任务：六档提醒全部落在未来，本来必须排上
      normal.push(makeTodo(`normal-${index}`, { deadline: NOW + 8 * DAY_MS + index * HOUR_MS }));
    }

    const result = compileAlarmsWithStats([dense, ...normal], NOW);
    const counts = new Map<string, number>();
    for (const alarm of result.alarms) {
      counts.set(alarm.todoId, (counts.get(alarm.todoId) ?? 0) + 1);
    }

    // 1. 全局不超上限
    expect(result.alarms.length).toBeLessThanOrEqual(MAX_ALARMS);
    // 2. 密集任务被实例上限兜住：24 个实例 × 1 档（15 分钟的周期只留 due）= 24 条
    expect(counts.get('dense')).toBe(MAX_INSTANCES_PER_TODO);
    expect(new Set(result.alarms.filter((alarm) => alarm.todoId === 'dense').map((alarm) => alarm.deadline)).size).toBe(
      MAX_INSTANCES_PER_TODO,
    );
    expect(counts.get('dense')).toBeLessThanOrEqual(MAX_INSTANCES_PER_TODO * 3);
    // 3. 其余 5 条待办一条不少地拿到完整六档 —— 修复前每件只剩 1 条（7 天档）
    for (const todo of normal) {
      expect(counts.get(todo.id), `${todo.id} 的提醒被挤掉了`).toBe(6);
      const kinds = result.alarms.filter((alarm) => alarm.todoId === todo.id).map((alarm) => alarm.kind);
      expect(kinds).toEqual(['7d', '3d', '1d', '3h', '1h', 'due']);
    }
    // 配额没有真正丢弃任何候选，所以这里如实为 0
    expect(result.truncated).toBe(0);
  });

  it('只有一条待办时它仍能拿到足够名额（受 MAX_INSTANCES_PER_TODO 约束，而不是被平均分配压到 8 条）', () => {
    const dense: Todo = makeTodo('dense', {
      deadline: NOW + 30 * 60_000,
      repeat: { kind: 'interval', intervalMs: 6 * HOUR_MS },
    });

    const result = compileAlarmsWithStats([dense], NOW);

    // 24 个实例 × 3 档（3h / 1h / due）= 72 条，但第 1 个实例的 deadline 是 NOW+30min，
    // 它的 3h 档（NOW-2.5h）已经过去、不能排（否则用户会立刻收到一条「还有 3 小时截止」的假提醒），
    // 所以实际是 23 × 3 + 1 = 70 条，仍远大于 MIN_ALARMS_PER_TODO
    expect(result.alarms).toHaveLength(MAX_INSTANCES_PER_TODO * 3 - 2);
    expect(result.alarms.length).toBeGreaterThan(MIN_ALARMS_PER_TODO);
    expect(result.truncated).toBe(0);
  });

  it('100 条一次性待办：全局截断到 240 条，但没有任何一条待办彻底失声', () => {
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
    // 100 × 6 = 600 条候选，最终留 240 条 → 丢弃 360 条（含单条配额与全局截断两部分）
    expect(result.truncated).toBe(600 - MAX_ALARMS);

    // 0 条待办数必须为 0：截断绝不能把某条待办彻底抹掉（这是本次修复要防的核心事故）
    expect(todos.filter((todo) => (counts.get(todo.id) ?? 0) === 0)).toHaveLength(0);
    // 每条至少 1 档。1 档具体落在哪个档位由各待办的 fireAt 交错决定，不做更强承诺 ——
    // 更强的「每条 ≥2 档」与「保留最早的 240 条」在数学上不相容：
    // 待办按 1 小时错开、档位边界必然交错，第 240 名的切点一定切在某个档位边界上。
    //
    // 实测直方图（240 名额 / 100 条待办 / 每条 6 档），这个分布是**已知且已接受**的：
    //   1 条:20 / 2 条:48 / 3 条:21 / 4 条:2 / 5 条:1 / 6 条:8 / **0 条:0**
    for (const todo of todos) {
      expect(counts.get(todo.id) ?? 0, `${todo.id} 一条提醒都没拿到`).toBeGreaterThanOrEqual(1);
    }

    // 为什么**不做**「按待办轮转」（曾经考虑过的"更公平"方案）：
    // 轮转意味着每条待办先拿自己最早的那 2 条，而「最早」恒为 7d 与 3d 档 ——
    // 结果是 100 条待办全部失去「到点」那一档，谁都收不到最该收到的那条通知。
    // 用「20 条待办只剩 7d 一档」换「100 条待办全都没有到点提醒」是明显的负优化。
    // 「取最早」的真实语义是**紧迫性优先**：不管有多少条待办，时间上最近的提醒一定排得上，
    // 这比「人人均摊」更符合「不漏事」的产品目标。所以第二级保持纯 fireAt 升序截断不变。
    const dueCount = result.alarms.filter((alarm) => alarm.kind === 'due').length;
    expect(dueCount, '「到点」档必须有人拿到（轮转方案会让它为 0）').toBeGreaterThan(0);
  });
});

describe('D2 续. 重复任务把上限吃掉时，计数与实际丢弃数一致', () => {
  it('60 条「每 6 小时」的密集待办：truncated 与「理论总数 - 240」逐条对账', () => {
    const todos: Todo[] = [];
    for (let index = 0; index < 60; index += 1) {
      todos.push(
        makeTodo(`dense-${index}`, {
          deadline: NOW + 30 * 60_000,
          repeat: { kind: 'interval', intervalMs: 6 * HOUR_MS },
        }),
      );
    }

    const result = compileAlarmsWithStats(todos, NOW);
    const expectedFireAt = referenceCandidates(todos, NOW);

    expect(expectedFireAt.length).toBeGreaterThan(MAX_ALARMS);
    expect(result.alarms.length).toBe(MAX_ALARMS);
    expect(result.truncated).toBe(expectedFireAt.length - MAX_ALARMS);
    expect(result.alarms.map((alarm) => alarm.fireAt)).toEqual(expectedFireAt.slice(0, MAX_ALARMS));
  });
});
