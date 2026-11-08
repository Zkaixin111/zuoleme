import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS, HOUR_MS } from '../shared/reminders';
import { nextOccurrence } from '../shared/repeat';
import type { RepeatRule } from '../shared/types';
import { api, readTodos } from '../src/lib/api';

/**
 * QA 独立复验：重复任务的推进语义（对应验收要求「支持定时任务」）。
 *
 * 这里刻意**不引用**工程师已有测试的任何 helper，也不复用他们的断言思路：
 * 每个用例都从「用户视角的现象」出发（我点完成了，卡片应该变成哪一天？），
 * 用固定的本地墙钟时间去钉死结果。
 *
 * 三个重点怀疑方向：
 * - A：**提前完成**（deadline 还没到就点完成）时，推进结果会不会原地不动；
 * - B：每月重复的日期漂移（31 号 → 2 月 → 3 月能不能回到 31 号）；
 * - C：每周重复在 weekdays 含今天时，会不会把「今天」当成下一次。
 */

/** 最小 localStorage 垫片（api.ts 只在函数体内访问 window.localStorage） */
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

/**
 * 构造本地墙钟时间戳（月份按 0 起算，与 Date 一致）。
 *
 * 用本地时间而不是 UTC：被测实现全部依赖 `getDate/setMonth` 这类本地日历 API，
 * 用 UTC 构造会让「保持本地墙钟时分」这条不变量测不出来。
 */
function at(year: number, month: number, day: number, hour: number, minute: number = 0): number {
  return new Date(year, month, day, hour, minute, 0, 0).getTime();
}

/**
 * 把时间戳拆成 [年, 月(1 起), 日, 时, 分]。
 *
 * @param timestamp 毫秒时间戳
 */
function parts(timestamp: number): [number, number, number, number, number] {
  const date = new Date(timestamp);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()];
}

beforeEach(() => {
  storage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('A. 重复任务「提前完成」必须真的往前走', () => {
  it('每天：截止=明天 09:00、now=今天 20:00 → 下一次是后天 09:00（不能原地不动）', () => {
    const now = at(2026, 2, 3, 20, 0);
    const deadline = at(2026, 2, 4, 9, 0);

    const next = nextOccurrence(deadline, { kind: 'daily' }, now);

    expect(next).not.toBeNull();
    expect(parts(next as number)).toEqual([2026, 3, 5, 9, 0]);
    // 关键断言：结果必须严格晚于「当前这一次的 deadline」
    expect(next as number).toBeGreaterThan(deadline);
  });

  it('每天：端到端（api.updateTodo）提前完成 → deadline 变成后天 09:00，done 保持 false', async () => {
    const now = at(2026, 2, 3, 20, 0);
    vi.useFakeTimers({ now });
    vi.setSystemTime(now);

    const created = await api.createTodo({ title: '每天喝水', deadline: at(2026, 2, 4, 9, 0), repeat: { kind: 'daily' } });
    const updated = await api.updateTodo(created.id, { done: true });

    expect(updated.done).toBe(false);
    expect(parts(updated.deadline)).toEqual([2026, 3, 5, 9, 0]);
    // 磁盘上的数据也必须同步（否则界面显示已推进、重启后又退回旧时间）
    expect(readTodos()[0].deadline).toBe(updated.deadline);
    expect(readTodos()[0].done).toBe(false);
  });

  it('每周：截止在下周一（还有 5 天）就点完成 → 推进整整 7 天，不是原地', () => {
    const now = at(2026, 2, 3, 20, 0); // 周二
    const deadline = at(2026, 2, 9, 9, 0); // 下周一

    const next = nextOccurrence(deadline, { kind: 'weekly', weekdays: [1] }, now);

    expect(next).toBe(at(2026, 2, 16, 9, 0));
    expect((next as number) - deadline).toBe(7 * DAY_MS);
  });

  it('每月：截止在下个月 15 号就点完成 → 推进一个月，日期不漂成 14/16 号', () => {
    const now = at(2026, 2, 1, 9, 0);
    const deadline = at(2026, 2, 15, 9, 0);

    const next = nextOccurrence(deadline, { kind: 'monthly', dayOfMonth: 15 }, now);

    // deadline 是 3 月 15 日，「完成这一次」后应推进到 4 月 15 日
    expect(parts(next as number)).toEqual([2026, 4, 15, 9, 0]);
  });

  it('每隔 6 小时：截止在 3 天后就点完成 → 只推进一个间隔（6 小时），不跳到「下一个未来时刻」', () => {
    const now = at(2026, 2, 3, 20, 0);
    const deadline = now + 3 * DAY_MS;

    const next = nextOccurrence(deadline, { kind: 'interval', intervalMs: 6 * HOUR_MS }, now);

    expect(next).toBe(deadline + 6 * HOUR_MS);
  });

  it('四种重复规则各连点 5 次「完成」：deadline 每次都必须严格前进（不会卡住）', () => {
    const now = at(2026, 2, 3, 20, 0);
    const rules: RepeatRule[] = [
      { kind: 'daily' },
      { kind: 'weekly', weekdays: [1, 4] },
      { kind: 'monthly', dayOfMonth: 31 },
      { kind: 'interval', intervalMs: 12 * HOUR_MS },
    ];

    for (const rule of rules) {
      let deadline = now + DAY_MS;
      for (let step = 0; step < 5; step += 1) {
        const next = nextOccurrence(deadline, rule, now);
        expect(next, `规则 ${rule.kind} 第 ${step + 1} 次推进返回 null`).not.toBeNull();
        expect(next as number, `规则 ${rule.kind} 第 ${step + 1} 次推进没有前进`).toBeGreaterThan(deadline);
        deadline = next as number;
      }
    }
  });

  it('不变量：无论 now 落在 deadline 之前还是之后，返回值都严格大于 now 且不等于起点', () => {
    const rules: RepeatRule[] = [
      { kind: 'daily' },
      { kind: 'weekly', weekdays: [0, 1, 2, 3, 4, 5, 6] },
      { kind: 'monthly', dayOfMonth: 1 },
      { kind: 'interval', intervalMs: 15 * 60_000 },
    ];
    const base = at(2026, 2, 3, 9, 0);

    for (const rule of rules) {
      for (const shift of [-9 * DAY_MS, -1, 0, 1, 9 * DAY_MS, 400 * DAY_MS]) {
        const from = base + DAY_MS;
        const now = base + shift;
        const next = nextOccurrence(from, rule, now);
        expect(next).not.toBeNull();
        expect(next as number).toBeGreaterThan(now);
        expect(next as number).not.toBe(from);
      }
    }
  });
});

describe('B. 每月重复：日期漂移（经典坑）', () => {
  it('1/31 → 2/28 → 3/31（平年：2 月落到月末，3 月要回到规则里的 31 号）', () => {
    const rule: RepeatRule = { kind: 'monthly', dayOfMonth: 31 };
    const first = at(2026, 0, 31, 9, 0);

    const second = nextOccurrence(first, rule, first) as number;
    const third = nextOccurrence(second, rule, second) as number;

    expect(parts(second)).toEqual([2026, 2, 28, 9, 0]);
    expect(parts(third)).toEqual([2026, 3, 31, 9, 0]);
  });

  it('闰年 1/31 → 2/29 → 3/31', () => {
    const rule: RepeatRule = { kind: 'monthly', dayOfMonth: 31 };
    const first = at(2024, 0, 31, 9, 0);

    const second = nextOccurrence(first, rule, first) as number;
    const third = nextOccurrence(second, rule, second) as number;

    expect(parts(second)).toEqual([2024, 2, 29, 9, 0]);
    expect(parts(third)).toEqual([2024, 3, 31, 9, 0]);
  });

  it('8/31 → 9/30 → 10/31（30 天月后必须回到 31 号）', () => {
    const rule: RepeatRule = { kind: 'monthly', dayOfMonth: 31 };
    const first = at(2026, 7, 31, 9, 0);

    const second = nextOccurrence(first, rule, first) as number;
    const third = nextOccurrence(second, rule, second) as number;

    expect(parts(second)).toEqual([2026, 9, 30, 9, 0]);
    expect(parts(third)).toEqual([2026, 10, 31, 9, 0]);
  });

  it('每月 15 号连续推进 12 次：始终 15 号、月份逐月递增且跨年正确', () => {
    const rule: RepeatRule = { kind: 'monthly', dayOfMonth: 15 };
    let cursor = at(2026, 10, 15, 9, 0);

    for (let step = 1; step <= 12; step += 1) {
      const next = nextOccurrence(cursor, rule, cursor) as number;
      expect(new Date(next).getDate()).toBe(15);
      expect(new Date(next).getHours()).toBe(9);
      const expectedMonthIndex = (10 + step) % 12;
      expect(new Date(next).getMonth()).toBe(expectedMonthIndex);
      expect(new Date(next).getFullYear()).toBe(step >= 2 ? 2027 : 2026);
      cursor = next;
    }
    expect(parts(cursor)).toEqual([2027, 11, 15, 9, 0]);
  });

  it('每月 31 号连续推进 12 次：日期只允许 {28,29,30,31}，且每年 1/3/5/7/8/10/12 月要回到 31', () => {
    const rule: RepeatRule = { kind: 'monthly', dayOfMonth: 31 };
    let cursor = at(2026, 0, 31, 9, 0);

    for (let step = 0; step < 12; step += 1) {
      const date = new Date(cursor);
      expect([28, 29, 30, 31]).toContain(date.getDate());
      const monthIndex = date.getMonth();
      const longMonths = [0, 2, 4, 6, 7, 9, 11];
      if (longMonths.includes(monthIndex)) {
        expect(date.getDate()).toBe(31);
      } else if (monthIndex === 1) {
        expect([28, 29]).toContain(date.getDate());
      } else {
        expect(date.getDate()).toBe(30);
      }
      cursor = nextOccurrence(cursor, rule, cursor) as number;
    }
  });
});

describe('C. 每周重复：必须跳过「今天」', () => {
  it('weekdays 含今天、from 就是今天 09:00（还没到）→ 下一次是整整 7 天后', () => {
    const rule: RepeatRule = { kind: 'weekly', weekdays: [2] }; // 周二
    const from = at(2026, 2, 3, 9, 0); // 周二 09:00
    const now = at(2026, 2, 3, 8, 0); // 还没到

    const next = nextOccurrence(from, rule, now);

    expect(next).toBe(at(2026, 2, 10, 9, 0));
    expect((next as number) - from).toBe(7 * DAY_MS);
  });

  it('weekdays 含今天、from 已过去 → 同样是 7 天后（不能返回 from）', () => {
    const rule: RepeatRule = { kind: 'weekly', weekdays: [2] };
    const from = at(2026, 2, 3, 9, 0);
    const now = at(2026, 2, 4, 12, 0);

    const next = nextOccurrence(from, rule, now);

    expect(next).toBe(at(2026, 2, 10, 9, 0));
  });

  it('多选（周一 + 周四）按时间顺序轮转：周一 → 周四 → 下周一 → 下周四', () => {
    const rule: RepeatRule = { kind: 'weekly', weekdays: [1, 4] };
    let cursor = at(2026, 2, 2, 9, 0); // 周一
    const expected = [
      at(2026, 2, 5, 9, 0), // 周四
      at(2026, 2, 9, 9, 0), // 下周一
      at(2026, 2, 12, 9, 0), // 下周四
      at(2026, 2, 16, 9, 0), // 下下周一
    ];

    for (const want of expected) {
      const next = nextOccurrence(cursor, rule, cursor) as number;
      expect(next).toBe(want);
      cursor = next;
    }
  });

  it('多选且截止在周三、now 在周二 → 推进到本周四（只前进 1 天，不是跳一周）', () => {
    const rule: RepeatRule = { kind: 'weekly', weekdays: [1, 4] };
    const from = at(2026, 2, 4, 9, 0); // 周三
    const now = at(2026, 2, 3, 20, 0); // 周二

    const next = nextOccurrence(from, rule, now);

    expect(next).toBe(at(2026, 2, 5, 9, 0));
  });
});
