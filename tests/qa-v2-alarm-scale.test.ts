import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, reminderOffsetsFor } from '../shared/reminders';
import { nextOccurrence } from '../shared/repeat';
import type { RepeatRule, Todo } from '../shared/types';
import { NO_REPEAT } from '../shared/types';
import { ALARM_ID_MAX, MAX_ALARMS, compileAlarms, compileAlarmsWithStats } from '../src/lib/alarms';

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
    deadline: NOW + 10 * DAY_MS,
    done: false,
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
 * 只依赖共享层的档位定义与重复规则推进，用于给截断逻辑对账。
 *
 * @param todos 待办列表
 * @param now 当前时间
 */
function referenceCandidates(todos: readonly Todo[], now: number): number[] {
  const fireAtList: number[] = [];
  const horizon = now + 30 * DAY_MS;

  for (const todo of todos) {
    if (todo.done) {
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
      while (Number.isFinite(cursor) && cursor < horizon && deadlines.length < 10_000) {
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

describe('D3. 已知风险（已上报 P1）：单条高频重复任务会吃掉几乎全部名额', () => {
  it('一条「每 15 分钟」任务占掉 235/240 个名额，其它待办只剩下「7 天档」', () => {
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

    expect(result.alarms).toHaveLength(MAX_ALARMS);
    // 一条 15 分钟间隔的任务展开 240 个实例（每实例只有 due 一档），吃掉 235 个名额
    expect(counts.get('dense')).toBe(235);
    // 其余 5 条待办每件只剩 1 条：恰好是「7 天档」（deadline - 7d，落在 24~28 小时后）
    for (const todo of normal) {
      expect(counts.get(todo.id), `${todo.id} 的提醒被全部挤掉`).toBe(1);
      const kept = result.alarms.filter((alarm) => alarm.todoId === todo.id);
      expect(kept[0].kind).toBe('7d');
      expect(kept[0].fireAt).toBe(todo.deadline - 7 * DAY_MS);
    }
    // 丢掉的是「3 天 / 1 天 / 3 小时 / 1 小时 / 到点」这 5 档 —— 也就是最该响的那几档
    expect(result.truncated).toBe(30);
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
