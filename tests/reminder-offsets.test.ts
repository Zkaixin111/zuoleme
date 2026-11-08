import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  REMINDER_KINDS,
  planReminders,
  planRemindersFor,
  reminderOffsetsFor,
} from '../shared/reminders';
import type { ReminderKind, RepeatRule } from '../shared/types';

/**
 * 档位收缩（`reminderOffsetsFor`）测试。
 *
 * 为什么必须有这个函数：一条「每天 9:00」的任务如果保留 7 天档，
 * 上一周期的 7 天档与下一周期的 due 档会互相穿插，
 * 用户会在同一天收到好几条指向不同实例的提醒 —— 提醒彻底失去意义。
 * 规则很简单：**提前量必须严格短于周期**。
 */

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

/**
 * 取某个规则留下的档位名列表。
 *
 * @param rule 重复规则
 */
function kindsFor(rule: RepeatRule): ReminderKind[] {
  return reminderOffsetsFor(rule).map((offset) => offset.kind);
}

describe('reminderOffsetsFor：五种规则的档位收缩', () => {
  it('不重复 → 六档全留', () => {
    expect(kindsFor({ kind: 'none' })).toEqual(['7d', '3d', '1d', '3h', '1h', 'due']);
  });

  it('每天（周期 1 天）→ 剔除 7d/3d/1d，留下 3h/1h/due', () => {
    expect(kindsFor({ kind: 'daily' })).toEqual(['3h', '1h', 'due']);
  });

  it('每周（周期 7 天）→ 只剔除 7d，留下 3d/1d/3h/1h/due', () => {
    expect(kindsFor({ kind: 'weekly', weekdays: [1] })).toEqual(['3d', '1d', '3h', '1h', 'due']);
  });

  it('每月（按 30 天估）→ 六档全留', () => {
    expect(kindsFor({ kind: 'monthly', dayOfMonth: 15 })).toEqual([
      '7d',
      '3d',
      '1d',
      '3h',
      '1h',
      'due',
    ]);
  });

  it('每 6 小时 → 3h/1h/due', () => {
    expect(kindsFor({ kind: 'interval', intervalMs: 6 * HOUR_MS })).toEqual(['3h', '1h', 'due']);
  });

  it('每 30 天 → 六档全留（周期刚好覆盖最长的 7d 档）', () => {
    expect(kindsFor({ kind: 'interval', intervalMs: 30 * DAY_MS })).toEqual([
      '7d',
      '3d',
      '1d',
      '3h',
      '1h',
      'due',
    ]);
  });

  it('每 15 分钟 → 只剩「到点」（其余提前量都长于周期）', () => {
    expect(kindsFor({ kind: 'interval', intervalMs: 15 * MINUTE_MS })).toEqual(['due']);
  });

  it('非法间隔（0）→ 只剩「到点」，不至于把档位算成负数', () => {
    expect(kindsFor({ kind: 'interval', intervalMs: 0 })).toEqual(['due']);
  });

  it('收缩后的档位顺序与全局顺序一致（fireAt 天然升序）', () => {
    for (const rule of [
      { kind: 'daily' },
      { kind: 'weekly', weekdays: [1, 3] },
      { kind: 'interval', intervalMs: 6 * HOUR_MS },
    ] as RepeatRule[]) {
      const kinds = kindsFor(rule);
      const indexes = kinds.map((kind) => REMINDER_KINDS.indexOf(kind));
      expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    }
  });
});

describe('planRemindersFor：重复任务的提醒计划', () => {
  it('不重复时与 planReminders 完全一致（旧语义没被改坏）', () => {
    const deadline = NOW + 10 * DAY_MS;
    expect(planRemindersFor(deadline, { kind: 'none' }, NOW)).toEqual(planReminders(deadline, NOW));
  });

  it('每天任务：3 小时后到期只排 1h 与 due（3h 档正好等于下界被丢弃）', () => {
    const deadline = NOW + 3 * HOUR_MS;
    const plans = planRemindersFor(deadline, { kind: 'daily' }, NOW);

    expect(plans.map((plan) => plan.kind)).toEqual(['1h', 'due']);
    expect(plans[0].fireAt).toBe(deadline - HOUR_MS);
    expect(plans[1].fireAt).toBe(deadline);
  });

  it('每周任务：3 天后到期，5 档里只留下未过去的（1d/3h/1h/due）', () => {
    const deadline = NOW + 3 * DAY_MS;
    const plans = planRemindersFor(deadline, { kind: 'weekly', weekdays: [1] }, NOW);

    expect(plans.map((plan) => plan.kind)).toEqual(['1d', '3h', '1h', 'due']);
  });

  it('deadline 或 now 非有限值 → 空计划', () => {
    expect(planRemindersFor(Number.NaN, { kind: 'daily' }, NOW)).toEqual([]);
    expect(planRemindersFor(NOW + DAY_MS, { kind: 'daily' }, Number.NaN)).toEqual([]);
  });

  it('输出按 fireAt 升序', () => {
    const plans = planRemindersFor(NOW + 20 * DAY_MS, { kind: 'none' }, NOW);
    const fireAts = plans.map((plan) => plan.fireAt);

    expect([...fireAts].sort((a, b) => a - b)).toEqual(fireAts);
  });
});
