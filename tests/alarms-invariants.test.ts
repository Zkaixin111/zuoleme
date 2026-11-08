import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS } from '../shared/reminders';
import type { Todo } from '../shared/types';
import { NO_REPEAT } from '../shared/types';
import { compileAlarms, countPendingAlarms } from '../src/lib/alarms';

/**
 * `compileAlarms` 的输入过滤不变量。
 *
 * 产品规则只允许三种「不排钟」的输入，任何一种漏过滤都会让用户收到
 * 不该响的提醒（已完成的事还在催）或者立刻收到一条过期提醒（补发）：
 * 1. **已完成**（done = true）→ 0 条；
 * 2. **已删除**（从列表里消失）→ 它的闹钟全部消失，且不残留；
 * 3. **已过期**（deadline 已经过去）→ 0 条。
 *
 * 这三条都是「输出为空」的强断言，所以单独放在一个文件里。
 */

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

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

describe('compileAlarms：已完成 / 已删除 / 已过期 一律不排钟', () => {
  it('全部已完成 → 空数组', () => {
    const todos = [makeTodo('a', { done: true }), makeTodo('b', { done: true })];

    expect(compileAlarms(todos, NOW)).toEqual([]);
  });

  it('未完成与已完成混合 → 只有未完成的产生闹钟', () => {
    const todos = [
      makeTodo('done-1', { done: true }),
      makeTodo('live-1'),
      makeTodo('done-2', { done: true }),
      makeTodo('live-2'),
    ];

    const alarms = compileAlarms(todos, NOW);

    expect(alarms).toHaveLength(12);
    expect(new Set(alarms.map((alarm) => alarm.todoId))).toEqual(new Set(['live-1', 'live-2']));
  });

  it('已删除（从列表移除）→ 该待办的闹钟全部消失，其余待办 id 不变', () => {
    const keep = makeTodo('keep');
    const removed = makeTodo('removed');

    const before = compileAlarms([keep, removed], NOW);
    const after = compileAlarms([keep], NOW);

    expect(before.some((alarm) => alarm.todoId === 'removed')).toBe(true);
    expect(after.some((alarm) => alarm.todoId === 'removed')).toBe(false);

    // 删除任何一条待办都不应该让另一条待办的 id 漂移（否则重建时可能错位）
    const beforeKeepIds = before
      .filter((alarm) => alarm.todoId === 'keep')
      .map((alarm) => `${alarm.kind}:${alarm.id}`);
    const afterKeepIds = after.map((alarm) => `${alarm.kind}:${alarm.id}`);
    expect(afterKeepIds).toEqual(beforeKeepIds);
  });

  it('刚好删除到空列表 → 空数组（用户清空所有待办时不该残留任何闹钟）', () => {
    expect(compileAlarms([makeTodo('only')], NOW)).toHaveLength(6);
    expect(compileAlarms([], NOW)).toEqual([]);
  });

  it('截止时间已过（deadline <= now）→ 空数组，不补发', () => {
    expect(compileAlarms([makeTodo('past', { deadline: NOW - 1 })], NOW)).toEqual([]);
    expect(compileAlarms([makeTodo('now', { deadline: NOW })], NOW)).toEqual([]);
    expect(compileAlarms([makeTodo('long-ago', { deadline: NOW - 400 * DAY_MS })], NOW)).toEqual([]);
  });

  it('已完成 + 已过期叠加 → 仍然空', () => {
    const todos = [makeTodo('both', { done: true, deadline: NOW - HOUR_MS })];
    expect(compileAlarms(todos, NOW)).toEqual([]);
  });

  it('now 非有限值（NaN / Infinity）→ 空数组，不产生「随机未来时刻」的闹钟', () => {
    const todos = [makeTodo('a')];

    expect(compileAlarms(todos, Number.NaN)).toEqual([]);
    expect(compileAlarms(todos, Number.POSITIVE_INFINITY)).toEqual([]);
    expect(compileAlarms(todos, Number.NEGATIVE_INFINITY)).toEqual([]);
  });
});

describe('compileAlarms：其余输出不变量', () => {
  it('每一条闹钟的 fireAt 都严格晚于 now（真正的「只订未来」）', () => {
    const todos = [
      makeTodo('far', { deadline: NOW + 30 * DAY_MS }),
      makeTodo('near', { deadline: NOW + 2 * HOUR_MS }),
      makeTodo('expired', { deadline: NOW - DAY_MS }),
    ];

    const alarms = compileAlarms(todos, NOW);

    expect(alarms.length).toBeGreaterThan(0);
    for (const alarm of alarms) {
      expect(alarm.fireAt).toBeGreaterThan(NOW);
    }
  });

  it('同一待办的六档 fireAt 严格递增（按时间顺序依次触发）', () => {
    const alarms = compileAlarms([makeTodo('a', { deadline: NOW + 30 * DAY_MS })], NOW);
    const fireAts = alarms.map((alarm) => alarm.fireAt);

    expect(fireAts).toHaveLength(6);
    for (let index = 1; index < fireAts.length; index += 1) {
      expect(fireAts[index]).toBeGreaterThan(fireAts[index - 1]);
    }
  });

  it('每条闹钟都带非空标题与该实例的 deadline（正文由原生现算，结构里没有 body）', () => {
    const deadline = NOW + 30 * DAY_MS;
    const alarms = compileAlarms([makeTodo('a', { title: '交周报', deadline })], NOW);

    for (const alarm of alarms) {
      expect(alarm.title).toBe('交周报');
      expect(alarm.deadline).toBe(deadline);
      // 结构里绝不能有 body 字段（正文改成触发时刻现算）
      expect(Object.prototype.hasOwnProperty.call(alarm, 'body')).toBe(false);
    }
  });

  it('countPendingAlarms 与实际排出的条数一致（界面数字不会骗人）', () => {
    const cases: Todo[] = [
      makeTodo('far', { deadline: NOW + 30 * DAY_MS }),
      makeTodo('mid', { deadline: NOW + 2 * DAY_MS }),
      makeTodo('near', { deadline: NOW + 2 * HOUR_MS }),
      makeTodo('done', { done: true }),
      makeTodo('past', { deadline: NOW - DAY_MS }),
    ];

    for (const todo of cases) {
      expect(countPendingAlarms(todo, NOW)).toBe(compileAlarms([todo], NOW).length);
    }
  });
});
