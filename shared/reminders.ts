import type { ReminderKind, ReminderPlanItem } from './types';

/**
 * 六档提醒的纯逻辑（前后端 / Worker 共用，无任何 IO）。
 *
 * 产品规则：
 * - 每条待办在「截止前 7 天、3 天、1 天、3 小时、1 小时」以及「到点」各提醒一次；
 * - 只生成 fire_at 严格大于当前时间的档位；已经过去的档位直接丢弃，**不回补**；
 * - 因此「3 小时后截止」只会生成 1h 与 due 两档。
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export interface ReminderOffset {
  readonly kind: ReminderKind;
  /** 距截止时间的提前量（毫秒） */
  readonly offsetMs: number;
  /** 人类可读的提前量，用于通知文案 */
  readonly label: string;
}

/** 档位定义（顺序：由远及近，生成后 fire_at 天然升序） */
export const REMINDER_OFFSETS: readonly ReminderOffset[] = [
  { kind: '7d', offsetMs: 7 * DAY_MS, label: '7 天' },
  { kind: '3d', offsetMs: 3 * DAY_MS, label: '3 天' },
  { kind: '1d', offsetMs: 1 * DAY_MS, label: '1 天' },
  { kind: '3h', offsetMs: 3 * HOUR_MS, label: '3 小时' },
  { kind: '1h', offsetMs: HOUR_MS, label: '1 小时' },
  { kind: 'due', offsetMs: 0, label: '到点' },
];

/** 全部合法 kind，顺序与档位一致 */
export const REMINDER_KINDS: readonly ReminderKind[] = REMINDER_OFFSETS.map((item) => item.kind);

/**
 * 判断字符串是否为合法提醒档位。
 *
 * @param value 待判定值
 */
export function isReminderKind(value: string): value is ReminderKind {
  return (REMINDER_KINDS as readonly string[]).includes(value);
}

/**
 * 根据截止时间生成提醒计划。
 *
 * @param deadline 截止时间（毫秒时间戳）
 * @param now 当前时间（毫秒时间戳），由调用方注入以便测试
 * @returns 按 fireAt 升序排列的提醒计划；截止时间不在未来时返回空数组
 */
export function planReminders(deadline: number, now: number): ReminderPlanItem[] {
  if (!Number.isFinite(deadline) || !Number.isFinite(now)) {
    return [];
  }

  const plans: ReminderPlanItem[] = [];
  for (const { kind, offsetMs } of REMINDER_OFFSETS) {
    const fireAt = deadline - offsetMs;
    // 必须严格大于 now：恰好等于 now 的档位也丢弃，
    // 否则「刚创建就立刻收到一条过期档位提醒」，与「不回补」的产品规则冲突。
    if (fireAt > now) {
      plans.push({ kind, fireAt });
    }
  }

  plans.sort((a, b) => a.fireAt - b.fireAt);
  return plans;
}

/**
 * 取最近一条待发提醒时间。
 *
 * @param plans 提醒计划
 * @returns 最早 fireAt，空计划返回 null
 */
export function earliestFireAt(plans: readonly ReminderPlanItem[]): number | null {
  if (plans.length === 0) {
    return null;
  }
  return plans.reduce((min, item) => (item.fireAt < min ? item.fireAt : min), plans[0].fireAt);
}

/**
 * 某档位的通知正文文案。
 *
 * @param kind 提醒档位
 */
export function reminderBody(kind: ReminderKind): string {
  const offset = REMINDER_OFFSETS.find((item) => item.kind === kind);
  if (!offset || kind === 'due') {
    return '已到截止时间';
  }
  return `还有 ${offset.label}截止`;
}

/**
 * 通知分组标签：不同事项、不同档位互不覆盖（产品要求「每件事单独弹出提醒」）。
 *
 * @param todoId 待办 id
 * @param kind 提醒档位
 */
export function reminderTag(todoId: string, kind: ReminderKind): string {
  return `todo:${todoId}:${kind}`;
}
