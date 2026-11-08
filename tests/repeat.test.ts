import { describe, expect, it } from 'vitest';
import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  cycleLengthMs,
  isValidRepeatRule,
  nextOccurrence,
  normalizeRepeatRule,
  normalizeWeekdays,
  repeatLabel,
} from '../shared/repeat';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../shared/reminders';
import type { RepeatRule } from '../shared/types';

/**
 * 重复规则纯逻辑测试（`shared/repeat.ts`）。
 *
 * `nextOccurrence` 是本产品最容易被「看起来对」骗过去的一段代码：
 * 用 `+86400000` 也能跑通大部分用例，只在夏令时那天漂一小时；
 * 用 `setMonth(+1)` 也能跑通大部分用例，只在 31 号溢出成「下下个月」。
 * 因此这里刻意用**本地日历**构造断言，并覆盖跨年、月底、闰年、空星期、跨多周期的间隔。
 */

/** 把一个本地时刻打包成 Date */
function at(year: number, monthIndex: number, day: number, hour = 9): Date {
  return new Date(year, monthIndex, day, hour, 0, 0, 0);
}

const DAILY: RepeatRule = { kind: 'daily' };
const NONE: RepeatRule = { kind: 'none' };

describe('nextOccurrence：none 与非法输入', () => {
  it('不重复永远返回 null', () => {
    expect(nextOccurrence(at(2026, 0, 1).getTime(), NONE, at(2026, 0, 1).getTime())).toBeNull();
  });

  it('起点或下界非有限值 → null（不抛异常）', () => {
    expect(nextOccurrence(Number.NaN, DAILY, 0)).toBeNull();
    expect(nextOccurrence(0, DAILY, Number.NaN)).toBeNull();
    expect(nextOccurrence(0, DAILY, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('未知规则 → null', () => {
    expect(nextOccurrence(0, { kind: 'yearly' } as unknown as RepeatRule, 0)).toBeNull();
  });
});

describe('nextOccurrence：daily', () => {
  it('下界等于起点时推进到明天同一时刻', () => {
    const from = at(2026, 0, 1).getTime();
    const next = nextOccurrence(from, DAILY, from);

    expect(next).not.toBeNull();
    const date = new Date(next as number);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(0);
    expect(date.getDate()).toBe(2);
    expect(date.getHours()).toBe(9);
  });

  it('下界在很远之后时，一路推进到第一个严格晚于下界的时刻（不返回中间的）', () => {
    const from = at(2026, 0, 1).getTime();
    const after = at(2026, 0, 10, 12).getTime();
    const date = new Date(nextOccurrence(from, DAILY, after) as number);

    expect(date.getDate()).toBe(11);
    expect(date.getHours()).toBe(9);
  });

  it('跨年：12-31 → 次年 01-01', () => {
    const from = at(2026, 11, 31).getTime();
    const date = new Date(nextOccurrence(from, DAILY, from) as number);

    expect(date.getFullYear()).toBe(2027);
    expect(date.getMonth()).toBe(0);
    expect(date.getDate()).toBe(1);
  });

  it('跨夏令时仍保持本地墙钟时分（绝不能用 +86400000）', () => {
    // 2026-03-05 → 2026-03-15，中间跨过北美夏令时切换（3-08）
    const from = at(2026, 2, 5).getTime();
    const after = at(2026, 2, 14).getTime();
    const date = new Date(nextOccurrence(from, DAILY, after) as number);

    expect(date.getDate()).toBe(15);
    expect(date.getHours()).toBe(9);
    expect(date.getMinutes()).toBe(0);
  });
});

describe('nextOccurrence：weekly', () => {
  it('多选星期：从周一跳到本周三', () => {
    // 2026-01-05 是周一
    const from = at(2026, 0, 5).getTime();
    expect(new Date(from).getDay()).toBe(1);

    const rule: RepeatRule = { kind: 'weekly', weekdays: [1, 3] };
    const date = new Date(nextOccurrence(from, rule, from) as number);

    expect(date.getDay()).toBe(3);
    expect(date.getDate()).toBe(7);
    expect(date.getHours()).toBe(9);
  });

  it('空星期集合 → null（退化成不重复，而不是死循环）', () => {
    const from = at(2026, 0, 5).getTime();
    expect(nextOccurrence(from, { kind: 'weekly', weekdays: [] }, from)).toBeNull();
  });

  it('只选今天这一天的星期 → 推进整整一周，绝不返回起点', () => {
    const from = at(2026, 0, 5).getTime();
    const next = nextOccurrence(from, { kind: 'weekly', weekdays: [1] }, from) as number;

    expect(next).toBeGreaterThan(from);
    expect(next - from).toBe(7 * DAY_MS);
  });

  it('星期里含非法值时不崩，只按合法值推进', () => {
    const from = at(2026, 0, 5).getTime();
    const rule: RepeatRule = { kind: 'weekly', weekdays: [9, -1, 2] };
    const date = new Date(nextOccurrence(from, rule, from) as number);

    expect(date.getDay()).toBe(2);
  });

  it('下界早已越过一片星期时，跳到下界之后的第一个匹配日', () => {
    const from = at(2026, 0, 5).getTime();
    const after = at(2026, 0, 20).getTime();
    const rule: RepeatRule = { kind: 'weekly', weekdays: [1] };
    const date = new Date(nextOccurrence(from, rule, after) as number);

    expect(date.getDay()).toBe(1);
    expect(date.getTime()).toBeGreaterThan(after);
  });
});

describe('nextOccurrence：monthly', () => {
  it('1 月 31 日 + 每月 31 日 → 2 月 28 日（平年取当月最后一天）', () => {
    const from = at(2026, 0, 31).getTime();
    const date = new Date(
      nextOccurrence(from, { kind: 'monthly', dayOfMonth: 31 }, from) as number
    );

    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(1);
    expect(date.getDate()).toBe(28);
    expect(date.getHours()).toBe(9);
  });

  it('1 月 31 日 + 每月 31 日 → 2 月 29 日（闰年）', () => {
    const from = at(2024, 0, 31).getTime();
    const date = new Date(
      nextOccurrence(from, { kind: 'monthly', dayOfMonth: 31 }, from) as number
    );

    expect(date.getMonth()).toBe(1);
    expect(date.getDate()).toBe(29);
  });

  it('从 31 号出发指定每月 15 日 → 下个月 15 日（不会溢出成下下个月）', () => {
    const from = at(2026, 0, 31).getTime();
    const date = new Date(
      nextOccurrence(from, { kind: 'monthly', dayOfMonth: 15 }, from) as number
    );

    expect(date.getMonth()).toBe(1);
    expect(date.getDate()).toBe(15);
  });

  it('跨年：12 月 → 次年 1 月', () => {
    const from = at(2026, 11, 15).getTime();
    const date = new Date(
      nextOccurrence(from, { kind: 'monthly', dayOfMonth: 15 }, from) as number
    );

    expect(date.getFullYear()).toBe(2027);
    expect(date.getMonth()).toBe(0);
    expect(date.getDate()).toBe(15);
  });

  it('截止日超过当月天数后仍能继续推进（2-28 → 3-31，不是 3-28）', () => {
    const from = at(2026, 0, 31).getTime();
    const rule: RepeatRule = { kind: 'monthly', dayOfMonth: 31 };
    const after = at(2026, 2, 5).getTime();
    const date = new Date(nextOccurrence(from, rule, after) as number);

    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(31);
  });

  it('非法日期（0 / 32）→ null', () => {
    const from = at(2026, 0, 15).getTime();
    expect(nextOccurrence(from, { kind: 'monthly', dayOfMonth: 0 }, from)).toBeNull();
    expect(nextOccurrence(from, { kind: 'monthly', dayOfMonth: 32 }, from)).toBeNull();
  });
});

describe('nextOccurrence：interval', () => {
  it('跨过多个周期时直接跳到第一个晚于下界的时刻（不逐周期累加）', () => {
    const from = at(2026, 0, 1).getTime();
    const after = from + 5.5 * HOUR_MS;
    const next = nextOccurrence(from, { kind: 'interval', intervalMs: HOUR_MS }, after) as number;

    expect(next).toBe(from + 6 * HOUR_MS);
  });

  it('下界等于起点时返回恰好一个周期之后', () => {
    const from = at(2026, 0, 1).getTime();
    expect(nextOccurrence(from, { kind: 'interval', intervalMs: 6 * HOUR_MS }, from)).toBe(
      from + 6 * HOUR_MS
    );
  });

  it('下界早于起点时也只前进一个周期（绝不返回起点）', () => {
    const from = at(2026, 0, 1).getTime();
    const next = nextOccurrence(from, { kind: 'interval', intervalMs: 15 * MINUTE_MS }, from - 1) as number;

    expect(next).toBe(from + 15 * MINUTE_MS);
  });

  it('非正间隔 / NaN → null', () => {
    const from = at(2026, 0, 1).getTime();
    expect(nextOccurrence(from, { kind: 'interval', intervalMs: 0 }, from)).toBeNull();
    expect(nextOccurrence(from, { kind: 'interval', intervalMs: -1000 }, from)).toBeNull();
    expect(nextOccurrence(from, { kind: 'interval', intervalMs: Number.NaN }, from)).toBeNull();
  });
});

describe('normalizeWeekdays', () => {
  it('去重、剔非法、升序', () => {
    expect(normalizeWeekdays([3, 1, 3, 9, -2, 0, '1'])).toEqual([0, 1, 3]);
  });

  it('非数组 → 空数组', () => {
    expect(normalizeWeekdays(undefined)).toEqual([]);
    expect(normalizeWeekdays('1,2')).toEqual([]);
  });
});

describe('isValidRepeatRule / normalizeRepeatRule', () => {
  it('结构合法判定', () => {
    expect(isValidRepeatRule({ kind: 'none' })).toBe(true);
    expect(isValidRepeatRule({ kind: 'daily' })).toBe(true);
    expect(isValidRepeatRule({ kind: 'weekly', weekdays: [] })).toBe(true);
    expect(isValidRepeatRule({ kind: 'monthly', dayOfMonth: 31 })).toBe(true);
    expect(isValidRepeatRule({ kind: 'monthly', dayOfMonth: 32 })).toBe(false);
    expect(isValidRepeatRule({ kind: 'interval', intervalMs: 0 })).toBe(false);
    expect(isValidRepeatRule(null)).toBe(false);
    expect(isValidRepeatRule({ kind: 'nope' })).toBe(false);
  });

  it('空星期集合会被规整成「不重复」（避免存下一条永远不回响的规则）', () => {
    expect(normalizeRepeatRule({ kind: 'weekly', weekdays: [] })).toEqual({ kind: 'none' });
  });

  it('非法值一律退回不重复', () => {
    expect(normalizeRepeatRule(undefined)).toEqual({ kind: 'none' });
    expect(normalizeRepeatRule({ kind: 'weekly' })).toEqual({ kind: 'none' });
    expect(normalizeRepeatRule('daily')).toEqual({ kind: 'none' });
  });

  it('合法值保留语义、规整字段', () => {
    expect(normalizeRepeatRule({ kind: 'weekly', weekdays: [5, 1, 1] })).toEqual({
      kind: 'weekly',
      weekdays: [1, 5],
    });
    expect(normalizeRepeatRule({ kind: 'monthly', dayOfMonth: 15 })).toEqual({
      kind: 'monthly',
      dayOfMonth: 15,
    });
    expect(normalizeRepeatRule({ kind: 'interval', intervalMs: 7200_000 })).toEqual({
      kind: 'interval',
      intervalMs: 7200_000,
    });
  });

  it('日期不是整数（15.9）被判为非法，退回不重复（不做四舍五入猜测）', () => {
    expect(normalizeRepeatRule({ kind: 'monthly', dayOfMonth: 15.9 })).toEqual({ kind: 'none' });
  });
});

describe('cycleLengthMs', () => {
  it('各分支的周期长度（monthly 按 30 天估）', () => {
    expect(cycleLengthMs(NONE)).toBe(Number.POSITIVE_INFINITY);
    expect(cycleLengthMs(DAILY)).toBe(DAY_MS);
    expect(cycleLengthMs({ kind: 'weekly', weekdays: [1] })).toBe(7 * DAY_MS);
    expect(cycleLengthMs({ kind: 'monthly', dayOfMonth: 1 })).toBe(30 * DAY_MS);
    expect(cycleLengthMs({ kind: 'interval', intervalMs: 6 * HOUR_MS })).toBe(6 * HOUR_MS);
  });

  it('非正间隔的周期按 0 处理（档位收缩只会留下「到点」）', () => {
    expect(cycleLengthMs({ kind: 'interval', intervalMs: 0 })).toBe(0);
  });
});

describe('repeatLabel', () => {
  it('中文短语', () => {
    expect(repeatLabel(NONE)).toBe('不重复');
    expect(repeatLabel(DAILY)).toBe('每天');
    expect(repeatLabel({ kind: 'weekly', weekdays: [1, 3] })).toBe('每周一、三');
    expect(repeatLabel({ kind: 'weekly', weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe('每天');
    expect(repeatLabel({ kind: 'weekly', weekdays: [] })).toBe('不重复');
    expect(repeatLabel({ kind: 'monthly', dayOfMonth: 15 })).toBe('每月 15 日');
    expect(repeatLabel({ kind: 'interval', intervalMs: 2 * HOUR_MS })).toBe('每 2 小时');
    expect(repeatLabel({ kind: 'interval', intervalMs: 3 * DAY_MS })).toBe('每 3 天');
    expect(repeatLabel({ kind: 'interval', intervalMs: 90 * MINUTE_MS })).toBe('每 90 分钟');
  });
});

describe('常量边界', () => {
  it('间隔上下限符合产品规格（15 分钟 ~ 30 天）', () => {
    expect(MIN_INTERVAL_MS).toBe(15 * MINUTE_MS);
    expect(MAX_INTERVAL_MS).toBe(30 * DAY_MS);
  });
});
