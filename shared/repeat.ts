import type { RepeatRule } from './types';

/**
 * 重复规则的纯逻辑：从「这一次」推到「下一次」。
 *
 * 三条硬约束（每一条都有对应的坑）：
 * 1. **保持本地墙钟时分秒**：全部用 `Date` 的 `setDate/setMonth` 推进，
 *    绝不用 `+86400000` —— 夏令时切换那天会漂 1 小时，「每天 9:00」变成「每天 8:00」；
 * 2. **绝不返回起点**：所有分支都至少前进一个周期，否则「完成」后 deadline 不变，
 *    任务会立刻再次到期；
 * 3. **不抛异常**：规则损坏（空 weekdays、负 interval、NaN）一律返回 null，
 *    由调用方退化成「一次性任务」，别把用户的任务卡死。
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** 间隔重复的下限：15 分钟（比这更密没有意义，也会打爆系统闹钟数量） */
export const MIN_INTERVAL_MS = 15 * MINUTE_MS;

/** 间隔重复的上限：30 天 */
export const MAX_INTERVAL_MS = 30 * DAY_MS;

/**
 * 推进步数上限（安全阀）。
 *
 * daily 最多 5000 天 ≈ 13 年，足够覆盖「一年没打开应用」的极端情况；
 * 超了就返回 null 而不是死循环。
 */
const MAX_STEPS = 5000;

/**
 * 判断值是否是有限数字。
 *
 * @param value 待判定值
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 规整 weekly 的星期集合：去重、剔除非法值、保持 0..6 升序。
 *
 * @param weekdays 原始星期数组
 */
export function normalizeWeekdays(weekdays: unknown): number[] {
  if (!Array.isArray(weekdays)) {
    return [];
  }
  const set = new Set<number>();
  for (const item of weekdays) {
    if (typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 6) {
      set.add(item);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * 从 `from` 出发，按规则推进到**第一个严格大于 `afterMs`** 的时刻。
 *
 * @param from 当前这一次的截止时间（锚点）
 * @param rule 重复规则
 * @param afterMs 下界（通常是 Date.now()）
 * @returns 下一次的时间戳；`none` 或规则损坏返回 null
 */
export function nextOccurrence(from: number, rule: RepeatRule, afterMs: number): number | null {
  if (!isFiniteNumber(from) || !isFiniteNumber(afterMs) || !rule || typeof rule !== 'object') {
    return null;
  }

  switch (rule.kind) {
    case 'none':
      return null;

    case 'daily': {
      const cursor = new Date(from);
      for (let step = 0; step < MAX_STEPS; step += 1) {
        // setDate 会按本地日历推进，跨月/跨年/夏令时都由平台处理
        cursor.setDate(cursor.getDate() + 1);
        const candidate = cursor.getTime();
        if (!Number.isFinite(candidate)) {
          return null;
        }
        if (candidate > afterMs) {
          return candidate;
        }
      }
      return null;
    }

    case 'weekly': {
      const weekdays = normalizeWeekdays(rule.weekdays);
      if (weekdays.length === 0) {
        // 空数组 = 没有一天要重复，退化成「不重复」
        return null;
      }
      const cursor = new Date(from);
      for (let step = 0; step < MAX_STEPS; step += 1) {
        // 先 +1 天：即使 weekdays 包含今天，也不会返回 from 本身
        cursor.setDate(cursor.getDate() + 1);
        const candidate = cursor.getTime();
        if (!Number.isFinite(candidate)) {
          return null;
        }
        if (candidate > afterMs && weekdays.includes(cursor.getDay())) {
          return candidate;
        }
      }
      return null;
    }

    case 'monthly': {
      const dayOfMonth = Math.trunc(rule.dayOfMonth);
      if (!Number.isFinite(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
        return null;
      }
      const cursor = new Date(from);
      for (let step = 0; step < MAX_STEPS; step += 1) {
        // 先把日设成 1，再 +1 个月：直接 setMonth 在 31 号会溢出成「下下个月」
        cursor.setDate(1);
        cursor.setMonth(cursor.getMonth() + 1);
        // 目标月的最后一天：下个月的第 0 天
        const lastDayOfMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
        cursor.setDate(Math.min(dayOfMonth, lastDayOfMonth));
        const candidate = cursor.getTime();
        if (!Number.isFinite(candidate)) {
          return null;
        }
        if (candidate > afterMs) {
          return candidate;
        }
      }
      return null;
    }

    case 'interval': {
      const intervalMs = Math.trunc(rule.intervalMs);
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        return null;
      }
      // 最小正整数 k 使 from + k*interval > afterMs
      let steps = Math.floor((afterMs - from) / intervalMs) + 1;
      if (!Number.isFinite(steps) || steps < 1) {
        steps = 1;
      }
      const candidate = from + steps * intervalMs;
      return Number.isFinite(candidate) ? candidate : null;
    }

    default:
      return null;
  }
}

/**
 * 校验任意值是否是合法的重复规则（存储层用）。
 *
 * 与 `nextOccurrence` 的区别：这里只做「结构合法性」判断，不涉及时间推进。
 *
 * @param value 待判定值
 */
export function isValidRepeatRule(value: unknown): value is RepeatRule {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const rule = value as Partial<RepeatRule> & { kind?: unknown };
  switch (rule.kind) {
    case 'none':
    case 'daily':
      return true;
    case 'weekly':
      return Array.isArray((rule as { weekdays?: unknown }).weekdays);
    case 'monthly': {
      const day = (rule as { dayOfMonth?: unknown }).dayOfMonth;
      return typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 31;
    }
    case 'interval': {
      const interval = (rule as { intervalMs?: unknown }).intervalMs;
      return typeof interval === 'number' && Number.isFinite(interval) && interval > 0;
    }
    default:
      return false;
  }
}

/**
 * 把任意值规整成合法规则：非法一律退回「不重复」。
 *
 * @param value 原始值（来自存储或用户输入）
 */
export function normalizeRepeatRule(value: unknown): RepeatRule {
  if (!isValidRepeatRule(value)) {
    return { kind: 'none' };
  }
  switch (value.kind) {
    case 'none':
    case 'daily':
      return { kind: value.kind };
    case 'weekly': {
      const weekdays = normalizeWeekdays(value.weekdays);
      return weekdays.length === 0 ? { kind: 'none' } : { kind: 'weekly', weekdays };
    }
    case 'monthly':
      return { kind: 'monthly', dayOfMonth: Math.trunc(value.dayOfMonth) };
    case 'interval':
      return { kind: 'interval', intervalMs: Math.trunc(value.intervalMs) };
    default:
      return { kind: 'none' };
  }
}

/** 星期的中文单字（0 = 周日） */
const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'] as const;

/**
 * 把间隔毫秒说成人话（只用于重复规则摘要）。
 *
 * @param intervalMs 间隔毫秒
 */
function intervalLabel(intervalMs: number): string {
  if (intervalMs % DAY_MS === 0) {
    return `${intervalMs / DAY_MS} 天`;
  }
  if (intervalMs % 3_600_000 === 0) {
    return `${intervalMs / 3_600_000} 小时`;
  }
  return `${Math.round(intervalMs / MINUTE_MS)} 分钟`;
}

/**
 * 重复规则的中文短语（列表第二行、详情页「重复」行用）。
 *
 * @param rule 重复规则
 */
export function repeatLabel(rule: RepeatRule): string {
  switch (rule.kind) {
    case 'none':
      return '不重复';
    case 'daily':
      return '每天';
    case 'weekly': {
      const weekdays = normalizeWeekdays(rule.weekdays);
      if (weekdays.length === 0) {
        return '不重复';
      }
      if (weekdays.length === 7) {
        return '每天';
      }
      return `每周${weekdays.map((day) => WEEKDAY_LABELS[day]).join('、')}`;
    }
    case 'monthly':
      return `每月 ${rule.dayOfMonth} 日`;
    case 'interval':
      return `每 ${intervalLabel(rule.intervalMs)}`;
    default:
      return '不重复';
  }
}

/**
 * 周期长度（毫秒），用于「档位不能长过周期」的推导。
 *
 * `none` 视为无穷大；`monthly` 按 30 天估（月份长度不固定，估算是刻意的）。
 *
 * @param rule 重复规则
 */
export function cycleLengthMs(rule: RepeatRule): number {
  switch (rule.kind) {
    case 'none':
      return Number.POSITIVE_INFINITY;
    case 'daily':
      return DAY_MS;
    case 'weekly':
      return 7 * DAY_MS;
    case 'monthly':
      return 30 * DAY_MS;
    case 'interval':
      return rule.intervalMs > 0 ? rule.intervalMs : 0;
    default:
      return Number.POSITIVE_INFINITY;
  }
}
