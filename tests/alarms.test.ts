import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS } from '../shared/reminders';
import type { Todo } from '../shared/types';
import { ALARM_ID_MAX, alarmId, compileAlarms, countPendingAlarms, hashAlarmKey } from '../src/lib/alarms';

/**
 * 闹钟编译层测试。
 *
 * 这一层的存在意义是把「还有哪几档没过去」翻译成「系统里要排哪几条闹钟」，
 * 因此两条最关键的断言是：
 * 1. 档位数量与 planReminders 完全一致（不补发已过去的档位）；
 * 2. 同一条待办的不同档位拿到**不同 id** —— 否则 Android 通知会互相覆盖，
 *    用户「每件事、每一档都要单独一条通知」的要求就落空了。
 */

/** 测试固定基准时间：2026-01-01 00:00:00 UTC */
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

/**
 * 构造一条待办。
 *
 * @param overrides 需要覆盖的字段
 */
function makeTodo(overrides: Partial<Todo> = {}): Todo {
  return {
    id: 'todo-a',
    title: '交周报',
    deadline: NOW + 10 * DAY_MS,
    done: false,
    createdAt: NOW - DAY_MS,
    updatedAt: NOW - DAY_MS,
    ...overrides,
  };
}

describe('compileAlarms', () => {
  it('10 天后截止的待办生成 6 条闹钟（7d/3d/1d/3h/1h/due）', () => {
    const todo = makeTodo({ deadline: NOW + 10 * DAY_MS, title: '交周报' });

    const alarms = compileAlarms([todo], NOW);

    expect(alarms).toHaveLength(6);
    expect(alarms.map((alarm) => alarm.kind)).toEqual(['7d', '3d', '1d', '3h', '1h', 'due']);

    // 触发时刻必须等于「截止时间 - 提前量」
    expect(alarms.map((alarm) => alarm.fireAt)).toEqual([
      todo.deadline - 7 * DAY_MS,
      todo.deadline - 3 * DAY_MS,
      todo.deadline - 1 * DAY_MS,
      todo.deadline - 3 * HOUR_MS,
      todo.deadline - 1 * HOUR_MS,
      todo.deadline,
    ]);

    // 标题与正文沿用既有文案：标题 = 待办标题，正文 = reminderBody(kind)
    expect(alarms[0].title).toBe('交周报');
    expect(alarms[5].body).toBe('已到截止时间');
    expect(alarms[3].body).toBe('还有 3 小时截止');
  });

  it('3 小时后截止只生成 2 条（1h、due），已过去的档位不补发', () => {
    const todo = makeTodo({ deadline: NOW + 3 * HOUR_MS });

    const alarms = compileAlarms([todo], NOW);

    expect(alarms).toHaveLength(2);
    expect(alarms.map((alarm) => alarm.kind)).toEqual(['1h', 'due']);
    expect(alarms[0].fireAt).toBe(NOW + 2 * HOUR_MS);
    expect(alarms[1].fireAt).toBe(NOW + 3 * HOUR_MS);
  });

  it('已完成的待办不产生任何闹钟', () => {
    const todo = makeTodo({ done: true });

    expect(compileAlarms([todo], NOW)).toEqual([]);
    expect(countPendingAlarms(todo, NOW)).toBe(0);
  });

  it('同一待办的 6 条闹钟 id 两两不同，且不同待办之间不冲突', () => {
    const first = makeTodo({ id: 'todo-a', deadline: NOW + 10 * DAY_MS });
    const second = makeTodo({ id: 'todo-b', deadline: NOW + 20 * DAY_MS, title: '交月报' });

    const alarms = compileAlarms([first, second], NOW);
    expect(alarms).toHaveLength(12);

    const ids = alarms.map((alarm) => alarm.id);
    // 全局唯一：既覆盖「同一待办不同档位」，也覆盖「不同待办」
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThanOrEqual(ALARM_ID_MAX);
    }

    // 指定待办-档位 → id 是稳定映射（同一进程内重复编译结果一致）
    expect(alarmId('todo-a', '7d')).toBe(alarmId('todo-a', '7d'));
    expect(alarmId('todo-a', '7d')).not.toBe(alarmId('todo-a', '3d'));
    expect(alarmId('todo-a', '7d')).not.toBe(alarmId('todo-b', '7d'));
  });

  it('输出按触发时刻升序，并带上来源待办 id', () => {
    const soon = makeTodo({ id: 'todo-soon', deadline: NOW + 2 * DAY_MS, title: '近的' });
    const later = makeTodo({ id: 'todo-later', deadline: NOW + 30 * DAY_MS, title: '远的' });

    // 故意倒序传入，验证排序由 compileAlarms 负责
    const alarms = compileAlarms([later, soon], NOW);

    const fireAts = alarms.map((alarm) => alarm.fireAt);
    expect([...fireAts].sort((a, b) => a - b)).toEqual(fireAts);
    expect(alarms[0].todoId).toBe('todo-soon');
    expect(alarms[alarms.length - 1].todoId).toBe('todo-later');
  });

  it('deadline 已经过去的待办不产生闹钟', () => {
    const todo = makeTodo({ deadline: NOW - HOUR_MS });

    expect(compileAlarms([todo], NOW)).toEqual([]);
  });
});

describe('hashAlarmKey', () => {
  it('始终落在 1..ALARM_ID_MAX 的正整数区间', () => {
    const keys = ['', 'a', 'todo:1:7d', '做了么', 'x'.repeat(500)];
    for (const key of keys) {
      const value = hashAlarmKey(key);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(ALARM_ID_MAX);
    }
  });

  it('相同键稳定、不同键（大概率）不同', () => {
    expect(hashAlarmKey('zuoleme.alarm:x:due')).toBe(hashAlarmKey('zuoleme.alarm:x:due'));
    expect(hashAlarmKey('zuoleme.alarm:x:due')).not.toBe(hashAlarmKey('zuoleme.alarm:y:due'));
  });
});
