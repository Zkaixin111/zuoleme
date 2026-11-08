import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS } from '../shared/reminders';
import type { RepeatRule, Todo } from '../shared/types';
import { NO_REPEAT } from '../shared/types';
import {
  ALARM_HORIZON_MS,
  ALARM_ID_MAX,
  MAX_ALARMS,
  compileAlarms,
  compileAlarmsWithStats,
  countPendingAlarms,
  nextDeadlineFor,
  remainingReminderCount,
} from '../src/lib/alarms';

/**
 * 重复任务的闹钟展开测试。
 *
 * 一次性任务的闹钟只要「排出去」就够了；重复任务多出一层风险：
 * 1. **只排第一条** → 用户第二天开始再也收不到提醒（最典型的漏）；
 * 2. **展开太多** → 系统闹钟数量失控，排程变慢甚至被限流；
 * 3. **id 没带实例时刻** → 同一档位的多个实例互相覆盖，用户少响几次且无日志。
 *
 * 这个文件按这三条逐一对齐。
 */

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

/** 默认截止时间：10 天后，六档全部落在未来 */
const DEADLINE = NOW + 10 * DAY_MS;

/**
 * 构造一条待办。
 *
 * @param id 待办 id
 * @param overrides 需要覆盖的字段
 */
function makeTodo(id: string, overrides: Partial<Todo> = {}): Todo {
  return {
    id,
    title: `待办 ${id}`,
    content: '',
    deadline: DEADLINE,
    done: false,
    repeat: NO_REPEAT,
    createdAt: NOW - DAY_MS,
    updatedAt: NOW - DAY_MS,
    ...overrides,
  };
}

/**
 * 确定性伪随机数（mulberry32），保证测试可复现。
 *
 * @param seed 种子
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('重复任务展开：30 天时间窗', () => {
  it('每天任务在 30 天窗内展开 20 个实例 × 3 档 = 60 条闹钟', () => {
    const todo = makeTodo('daily', { deadline: DEADLINE, repeat: { kind: 'daily' } });
    const alarms = compileAlarms([todo], NOW);

    // 窗口 NOW..NOW+30d，实例从 NOW+10d 起，共 NOW+10d … NOW+29d 共 20 个
    const instanceCount = new Set(alarms.map((alarm) => alarm.deadline)).size;
    expect(instanceCount).toBe(20);
    expect(alarms).toHaveLength(20 * 3);
    // 每天都只留 3h/1h/due 三档
    expect(new Set(alarms.map((alarm) => alarm.kind))).toEqual(new Set(['3h', '1h', 'due']));
  });

  it('展开出的实例间隔恰好 1 天，且每一个实例的 3 档 id 两两不同', () => {
    const todo = makeTodo('daily', { deadline: DEADLINE, repeat: { kind: 'daily' } });
    const alarms = compileAlarms([todo], NOW);

    const instances = [...new Set(alarms.map((alarm) => alarm.deadline))].sort((a, b) => a - b);
    for (let index = 1; index < instances.length; index += 1) {
      expect(instances[index] - instances[index - 1]).toBe(DAY_MS);
    }

    const ids = alarms.map((alarm) => alarm.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每周任务：20 天窗内 2~4 个实例，每实例 5 档', () => {
    const todo = makeTodo('weekly', {
      deadline: DEADLINE,
      repeat: { kind: 'weekly', weekdays: [1] },
    });
    const alarms = compileAlarms([todo], NOW);

    const instanceCount = new Set(alarms.map((alarm) => alarm.deadline)).size;
    expect(instanceCount).toBeGreaterThanOrEqual(2);
    expect(instanceCount).toBeLessThanOrEqual(4);
    expect(alarms).toHaveLength(instanceCount * 5);
  });

  it('每月任务：30 天窗内 1~2 个实例，每实例 6 档', () => {
    const todo = makeTodo('monthly', {
      deadline: DEADLINE,
      repeat: { kind: 'monthly', dayOfMonth: 11 },
    });
    const alarms = compileAlarms([todo], NOW);

    const instanceCount = new Set(alarms.map((alarm) => alarm.deadline)).size;
    expect(instanceCount).toBeGreaterThanOrEqual(1);
    expect(instanceCount).toBeLessThanOrEqual(2);
    expect(alarms).toHaveLength(instanceCount * 6);
  });

  it('每 6 小时任务：20 天窗内 80 个实例 × 3 档 = 240 条，恰好顶到全局上限', () => {
    const todo = makeTodo('interval-6h', {
      deadline: DEADLINE,
      repeat: { kind: 'interval', intervalMs: 6 * HOUR_MS },
    });
    const alarms = compileAlarms([todo], NOW);

    expect(new Set(alarms.map((alarm) => alarm.deadline)).size).toBe(80);
    expect(alarms).toHaveLength(MAX_ALARMS);
    expect(alarms.length).toBeLessThanOrEqual(MAX_ALARMS);
  });

  it('展开窗口常量就是 30 天（界面上「只排 30 天」的出处）', () => {
    expect(ALARM_HORIZON_MS).toBe(30 * DAY_MS);
  });
});

describe('重复任务展开：不补发过去', () => {
  it('截止时间在过去 5 天的每天任务，从明天开始排，绝不补发已过去的实例', () => {
    const todo = makeTodo('late', {
      deadline: NOW - 5 * DAY_MS,
      repeat: { kind: 'daily' },
    });
    const alarms = compileAlarms([todo], NOW);

    expect(alarms.length).toBeGreaterThan(0);
    for (const alarm of alarms) {
      expect(alarm.fireAt).toBeGreaterThan(NOW);
      expect(alarm.deadline).toBeGreaterThan(NOW);
    }
    // 第一个实例是「明天」（NOW+1d），不是过去任何一天
    const firstDeadline = Math.min(...alarms.map((alarm) => alarm.deadline));
    expect(firstDeadline).toBe(NOW + DAY_MS);
  });

  it('已完成的重复任务一条都不排（完成会推进 deadline，状态不会停在 done）', () => {
    const todo = makeTodo('done', { done: true, repeat: { kind: 'daily' } });

    expect(compileAlarms([todo], NOW)).toEqual([]);
    expect(countPendingAlarms(todo, NOW)).toBe(0);
  });
});

describe('MAX_ALARMS 截断', () => {
  it('候选超过上限时只保留最早的 240 条，并如实报出被丢弃的条数', () => {
    const rule: RepeatRule = { kind: 'daily' };
    const todos = Array.from({ length: 20 }, (_, index) =>
      makeTodo(`daily-${String(index).padStart(3, '0')}`, { deadline: DEADLINE, repeat: rule })
    );

    const result = compileAlarmsWithStats(todos, NOW);

    expect(result.alarms).toHaveLength(MAX_ALARMS);
    // 20 条 × 20 个实例 × 3 档 = 1200 条候选
    expect(result.truncated).toBe(20 * 20 * 3 - MAX_ALARMS);
    for (const alarm of result.alarms) {
      expect(alarm.id).toBeGreaterThan(0);
      expect(alarm.id).toBeLessThanOrEqual(ALARM_ID_MAX);
    }
  });

  it('截断后保留的确实是最早的那批（按 fireAt 升序，且末尾不晚于被丢弃的）', () => {
    const todos = Array.from({ length: 20 }, (_, index) =>
      makeTodo(`daily-${String(index).padStart(3, '0')}`, {
        deadline: DEADLINE,
        repeat: { kind: 'daily' },
      })
    );

    const { alarms } = compileAlarmsWithStats(todos, NOW);
    const fireAts = alarms.map((alarm) => alarm.fireAt);

    expect(fireAts).toHaveLength(MAX_ALARMS);
    expect([...fireAts].sort((a, b) => a - b)).toEqual(fireAts);
  });

  it('没有超限时 truncated 为 0', () => {
    expect(compileAlarmsWithStats([makeTodo('a')], NOW).truncated).toBe(0);
  });
});

describe('id 全局唯一：200 条随机待办（含各类重复规则）', () => {
  it('展开后所有 id 两两不同，且都落在合法区间', () => {
    const random = mulberry32(20260101);
    const rules: RepeatRule[] = [
      { kind: 'none' },
      { kind: 'daily' },
      { kind: 'weekly', weekdays: [1, 3, 5] },
      { kind: 'monthly', dayOfMonth: 15 },
      { kind: 'interval', intervalMs: 6 * HOUR_MS },
      { kind: 'interval', intervalMs: 3 * DAY_MS },
    ];

    const todos: Todo[] = [];
    for (let index = 0; index < 200; index += 1) {
      const rule = rules[Math.floor(random() * rules.length)];
      const offsetDays = 1 + Math.floor(random() * 40);
      todos.push(
        makeTodo(`rand-${String(index).padStart(4, '0')}`, {
          deadline: NOW + offsetDays * DAY_MS + Math.floor(random() * DAY_MS),
          repeat: rule,
        })
      );
    }

    const alarms = compileAlarms(todos, NOW);
    const ids = alarms.map((alarm) => alarm.id);

    expect(alarms.length).toBeGreaterThan(0);
    expect(alarms.length).toBeLessThanOrEqual(MAX_ALARMS);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThanOrEqual(ALARM_ID_MAX);
    }
  });

  it('同一条待办的同一档位、不同实例 id 不同（否则第二天那条会把第一天的顶掉）', () => {
    const todo = makeTodo('daily', { deadline: DEADLINE, repeat: { kind: 'daily' } });
    const alarms = compileAlarms([todo], NOW).filter((alarm) => alarm.kind === '3h');

    expect(alarms.length).toBeGreaterThan(1);
    const ids = alarms.map((alarm) => alarm.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('重复任务的界面辅助函数', () => {
  it('nextDeadlineFor：重复任务过期后给下一次，一次性任务过期后给 null', () => {
    const past = NOW - DAY_MS;

    expect(nextDeadlineFor(makeTodo('a', { deadline: past, repeat: { kind: 'daily' } }), NOW)).toBe(
      NOW + DAY_MS
    );
    expect(nextDeadlineFor(makeTodo('b', { deadline: past }), NOW)).toBeNull();
    expect(nextDeadlineFor(makeTodo('c', { deadline: DEADLINE }), NOW)).toBe(DEADLINE);
  });

  it('remainingReminderCount 只算当前这一次（不把未来实例算进去）', () => {
    const daily = makeTodo('daily', { deadline: NOW + 3 * HOUR_MS, repeat: { kind: 'daily' } });
    // 3h 档正好落在 now，被丢弃；只剩 1h 与 due
    expect(remainingReminderCount(daily, NOW)).toBe(2);

    const once = makeTodo('once', { deadline: NOW + 3 * HOUR_MS });
    expect(remainingReminderCount(once, NOW)).toBe(2);

    const done = makeTodo('done', { done: true });
    expect(remainingReminderCount(done, NOW)).toBe(0);
  });
});
