import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  REMINDER_OFFSETS,
  earliestFireAt,
  planReminders,
  reminderBody,
  reminderTag,
} from '../shared/reminders';
import { formatDeadline, formatRemaining, toDateTimeLocalValue } from '../shared/format';

/** 固定基准时间，避免测试受系统时钟影响 */
const NOW = 1_700_000_000_000;

describe('planReminders：六档提醒生成规则', () => {
  it('截止在 30 天后 → 生成完整 6 档', () => {
    const deadline = NOW + 30 * DAY_MS;
    const plans = planReminders(deadline, NOW);

    expect(plans).toHaveLength(6);
    expect(plans.map((plan) => plan.kind)).toEqual(['7d', '3d', '1d', '3h', '1h', 'due']);
    expect(plans.map((plan) => plan.fireAt)).toEqual([
      deadline - 7 * DAY_MS,
      deadline - 3 * DAY_MS,
      deadline - 1 * DAY_MS,
      deadline - 3 * HOUR_MS,
      deadline - 1 * HOUR_MS,
      deadline,
    ]);
  });

  it('截止在 3 小时后 → 只生成 1h 和 due 两档（最容易写错的一条）', () => {
    const deadline = NOW + 3 * HOUR_MS;
    const plans = planReminders(deadline, NOW);

    expect(plans.map((plan) => plan.kind)).toEqual(['1h', 'due']);
    expect(plans[0].fireAt).toBe(deadline - HOUR_MS);
    expect(plans[1].fireAt).toBe(deadline);
  });

  it('截止在 30 分钟后 → 只生成 due 一档', () => {
    const plans = planReminders(NOW + 30 * MINUTE_MS, NOW);
    expect(plans).toEqual([{ kind: 'due', fireAt: NOW + 30 * MINUTE_MS }]);
  });

  it('截止时间已过 → 返回空数组（不回补任何档位）', () => {
    expect(planReminders(NOW - 1, NOW)).toEqual([]);
    expect(planReminders(NOW - 30 * DAY_MS, NOW)).toEqual([]);
  });

  it('截止时间恰好等于 now → 返回空数组（due 也不发）', () => {
    expect(planReminders(NOW, NOW)).toEqual([]);
  });

  it('边界：fireAt 恰好等于 now 的档位被丢弃（deadline = now + 1h 只剩 due）', () => {
    const plans = planReminders(NOW + HOUR_MS, NOW);
    expect(plans.map((plan) => plan.kind)).toEqual(['due']);
  });

  it('边界：fireAt 比 now 多 1 毫秒时该档位保留（deadline = now + 1h + 1ms）', () => {
    const plans = planReminders(NOW + HOUR_MS + 1, NOW);
    expect(plans.map((plan) => plan.kind)).toEqual(['1h', 'due']);
    expect(plans[0].fireAt).toBe(NOW + 1);
  });

  it('边界：deadline = now + 7d 时 7d 档被丢弃，剩 5 档', () => {
    const plans = planReminders(NOW + 7 * DAY_MS, NOW);
    expect(plans.map((plan) => plan.kind)).toEqual(['3d', '1d', '3h', '1h', 'due']);
  });

  it('生成结果按 fireAt 严格升序，且全部晚于 now', () => {
    const plans = planReminders(NOW + 30 * DAY_MS, NOW);
    for (let i = 0; i < plans.length; i += 1) {
      expect(plans[i].fireAt).toBeGreaterThan(NOW);
      if (i > 0) {
        expect(plans[i].fireAt).toBeGreaterThan(plans[i - 1].fireAt);
      }
    }
  });

  it('非法输入（NaN / Infinity）→ 返回空数组', () => {
    expect(planReminders(Number.NaN, NOW)).toEqual([]);
    expect(planReminders(NOW + DAY_MS, Number.NaN)).toEqual([]);
    expect(planReminders(Number.POSITIVE_INFINITY, NOW)).toEqual([]);
  });

  it('档位提前量与产品定义一致', () => {
    expect(REMINDER_OFFSETS.map((item) => [item.kind, item.offsetMs])).toEqual([
      ['7d', 7 * DAY_MS],
      ['3d', 3 * DAY_MS],
      ['1d', DAY_MS],
      ['3h', 3 * HOUR_MS],
      ['1h', HOUR_MS],
      ['due', 0],
    ]);
  });
});

describe('earliestFireAt / reminderBody / reminderTag', () => {
  it('earliestFireAt 取最早一条，空计划返回 null', () => {
    const deadline = NOW + 2 * DAY_MS;
    const plans = planReminders(deadline, NOW);
    expect(earliestFireAt(plans)).toBe(deadline - DAY_MS);
    expect(earliestFireAt([])).toBeNull();
  });

  it('reminderBody 生成中文文案', () => {
    expect(reminderBody('7d')).toBe('还有 7 天截止');
    expect(reminderBody('3h')).toBe('还有 3 小时截止');
    expect(reminderBody('due')).toBe('已到截止时间');
  });

  it('reminderTag 让不同事项、不同档位互不覆盖', () => {
    expect(reminderTag('todo-1', '1h')).toBe('todo:todo-1:1h');
    expect(reminderTag('todo-1', '1h')).not.toBe(reminderTag('todo-1', 'due'));
    expect(reminderTag('todo-1', '1h')).not.toBe(reminderTag('todo-2', '1h'));
  });
});

describe('formatRemaining：倒计时格式化', () => {
  it('3 天 2 小时', () => {
    expect(formatRemaining(3 * DAY_MS + 2 * HOUR_MS)).toBe('3天2小时');
  });

  it('45 分钟', () => {
    expect(formatRemaining(45 * MINUTE_MS)).toBe('45分钟');
  });

  it('已逾期（负数与 0）', () => {
    expect(formatRemaining(-1)).toBe('已逾期');
    expect(formatRemaining(0)).toBe('已逾期');
  });

  it('不足 1 分钟 → 不到1分钟', () => {
    expect(formatRemaining(30 * 1000)).toBe('不到1分钟');
  });

  it('整小时不带分钟：2小时', () => {
    expect(formatRemaining(2 * HOUR_MS)).toBe('2小时');
  });

  it('小时 + 分钟：2小时30分钟', () => {
    expect(formatRemaining(2 * HOUR_MS + 30 * MINUTE_MS)).toBe('2小时30分钟');
  });

  it('整天空小时：3天', () => {
    expect(formatRemaining(3 * DAY_MS)).toBe('3天');
  });

  it('超过一天但不足两天：1天1小时', () => {
    expect(formatRemaining(25 * HOUR_MS)).toBe('1天1小时');
  });
});

describe('formatDeadline / toDateTimeLocalValue', () => {
  it('今天 / 明天 使用相对表达', () => {
    const base = new Date(2024, 4, 20, 9, 0, 0).getTime();
    const today = new Date(2024, 4, 20, 18, 5, 0).getTime();
    const tomorrow = new Date(2024, 4, 21, 8, 30, 0).getTime();

    expect(formatDeadline(today, base)).toBe('今天 18:05');
    expect(formatDeadline(tomorrow, base)).toBe('明天 08:30');
  });

  it('更远的日期使用「M月D日 HH:mm」', () => {
    const base = new Date(2024, 4, 20, 9, 0, 0).getTime();
    const later = new Date(2024, 5, 3, 7, 8, 0).getTime();
    expect(formatDeadline(later, base)).toBe('6月3日 07:08');
  });

  it('toDateTimeLocalValue 输出 datetime-local 需要的格式', () => {
    const ts = new Date(2024, 0, 2, 3, 4, 0).getTime();
    expect(toDateTimeLocalValue(ts)).toBe('2024-01-02T03:04');
  });
});
