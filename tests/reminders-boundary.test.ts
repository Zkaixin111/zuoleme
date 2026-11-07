import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, REMINDER_OFFSETS, earliestFireAt, planReminders } from '../shared/reminders';

/**
 * planReminders 的边界补测。
 *
 * 关注点：`fireAt === now` 的档位必须被丢弃。
 * 这条规则决定了「新建待办后会不会立刻收到一条已经过期的提醒」，
 * 也决定了「截止时间刚好落在某个档位上时，该档位是否重复投递」。
 *
 * 与 tests/reminders.test.ts 的分工：
 * - reminders.test.ts 覆盖典型场景（30 天 / 3 小时 / 30 分钟后）；
 * - 本文件把「恰好等于 / 多 1 毫秒」这条边界对**每一档**都做一次穷举验证。
 */

const NOW = 1_700_000_000_000;

/** 除 due 之外的档位数（用于推导「丢弃一档后还剩几档」） */
const NON_DUE_COUNT = REMINDER_OFFSETS.length - 1;

describe('planReminders 边界：fireAt 严格大于 now', () => {
  for (const { kind, offsetMs } of REMINDER_OFFSETS) {
    it(`截止时间恰好等于 now + ${kind} 的提前量 → ${kind} 档被丢弃`, () => {
      // 让该档的 fireAt 精确等于 now
      const deadline = NOW + offsetMs;
      const plans = planReminders(deadline, NOW);

      expect(plans.map((plan) => plan.kind)).not.toContain(kind);
      // 该档之后（更靠近截止）的档位都必须保留
      const laterKinds = REMINDER_OFFSETS.filter((item) => item.offsetMs < offsetMs).map((item) => item.kind);
      for (const laterKind of laterKinds) {
        expect(plans.map((plan) => plan.kind)).toContain(laterKind);
      }
      // 每一档都严格晚于 now —— 这是「不回补」的机器可验证表述
      for (const plan of plans) {
        expect(plan.fireAt).toBeGreaterThan(NOW);
      }
    });

    it(`截止时间等于 now + ${kind} 的提前量 + 1 毫秒 → ${kind} 档保留`, () => {
      const deadline = NOW + offsetMs + 1;
      const plans = planReminders(deadline, NOW);

      expect(plans.map((plan) => plan.kind)).toContain(kind);
      const target = plans.find((plan) => plan.kind === kind);
      expect(target?.fireAt).toBe(NOW + 1);
    });
  }
});

describe('planReminders 边界：7 天档的两侧（决定首条提醒是否立刻发出）', () => {
  it('截止时间 = now + 7 天 + 1 毫秒 → 完整 6 档，首条提醒 1 毫秒后到达', () => {
    const deadline = NOW + 7 * DAY_MS + 1;
    const plans = planReminders(deadline, NOW);

    expect(plans).toHaveLength(REMINDER_OFFSETS.length);
    expect(plans.map((plan) => plan.kind)).toEqual(REMINDER_OFFSETS.map((item) => item.kind));
    // 7d 档的 fireAt 只比 now 晚 1 毫秒：说明边界是开区间 (now, ∞)
    expect(plans[0]).toEqual({ kind: '7d', fireAt: NOW + 1 });
    expect(earliestFireAt(plans)).toBe(NOW + 1);
  });

  it('截止时间 = now + 7 天整 → 只有 5 档，7d 档被丢弃', () => {
    const deadline = NOW + 7 * DAY_MS;
    const plans = planReminders(deadline, NOW);

    expect(plans).toHaveLength(NON_DUE_COUNT);
    expect(plans.map((plan) => plan.kind)).toEqual(['3d', '1d', '3h', '1h', 'due']);
    // 首条提醒是 3d 档（4 天后），不会立刻触发
    expect(earliestFireAt(plans)).toBe(deadline - 3 * DAY_MS);
  });

  it('截止时间 = now + 1 毫秒 → 只有 due 一档', () => {
    const plans = planReminders(NOW + 1, NOW);
    expect(plans).toEqual([{ kind: 'due', fireAt: NOW + 1 }]);
  });

  it('截止时间 = now + 6 天 23 小时 59 分 → 5 档（7d 已过去，不补发）', () => {
    const plans = planReminders(NOW + 7 * DAY_MS - HOUR_MS, NOW);
    expect(plans.map((plan) => plan.kind)).toEqual(['3d', '1d', '3h', '1h', 'due']);
  });
});

describe('planReminders 是纯函数', () => {
  it('同一入参多次调用结果完全一致，且不共享可变引用', () => {
    const deadline = NOW + 10 * DAY_MS;
    const first = planReminders(deadline, NOW);
    const second = planReminders(deadline, NOW);

    expect(second).toEqual(first);
    // 修改一次调用的返回值不得影响下一次调用（无模块级缓存）
    first[0].fireAt = 0;
    expect(planReminders(deadline, NOW)[0].fireAt).toBe(deadline - 7 * DAY_MS);
  });

  it('now 前进 1 毫秒会真实丢弃档位（证明比较用的是入参而不是系统时钟）', () => {
    // 截止 = NOW + 1 小时，则 1h 档的 fireAt 恰好是 NOW
    const deadline = NOW + HOUR_MS;
    const before = planReminders(deadline, NOW - 1);
    const after = planReminders(deadline, NOW);

    expect(before.map((plan) => plan.kind)).toEqual(['1h', 'due']);
    expect(after.map((plan) => plan.kind)).toEqual(['due']);
  });
});
