import { planReminders, reminderBody } from '../../shared/reminders';
import type { ReminderKind, Todo } from '../../shared/types';

/**
 * 把待办列表「编译」成扁平的闹钟列表（纯函数，无任何 IO / 平台依赖）。
 *
 * 这一层存在的理由：
 * - `planReminders` 只回答「某条待办还剩哪几档没过去」（时间语义）；
 * - Android 的 AlarmManager 需要的是「一堆互不相同的 (id, 触发时刻, 文案)」（平台语义）；
 * - 两者之间需要一个可测试的转换层，就是这里。
 *
 * 关键约束（产品要求「每件事、每一档都是独立一条通知」）：
 * 同一条待办的 6 档必须得到 6 个**互不相同**的整型 id，
 * 因为 Android 用 id 作为通知 id 与 PendingIntent requestCode，重复就会互相覆盖。
 */

/** AlarmManager / NotificationManager 接受的 id 必须落在 32 位有符号正整数区间 */
export const ALARM_ID_MAX = 0x7fffffff;

/** 一条待排闹钟（与原生插件约定的数据结构，字段必须一一对应） */
export interface ReminderAlarm {
  /** 正整数 id：既是通知 id，也是 PendingIntent requestCode */
  id: number;
  /** 来源待办 id（便于排查） */
  todoId: string;
  /** 提醒档位 */
  kind: ReminderKind;
  /** 通知标题 = 待办标题 */
  title: string;
  /** 通知正文 = 「还有 3 小时截止」这类固定文案 */
  body: string;
  /** 触发时刻（毫秒时间戳） */
  fireAt: number;
}

/**
 * FNV-1a 32 位哈希（稳定、实现简单、无依赖）。
 *
 * @param input 待哈希字符串
 * @returns 无符号 32 位整数
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    // Math.imul 保证 32 位整数乘法不丢精度
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * 把任意键哈希成 1..0x7fffffff 的正整数。
 *
 * 为什么截掉最高位：Kotlin 侧 id 用作通知 id（Int），
 * 保持正数可以让 Java/Kotlin 与 JS 的数值完全一致，不会出现符号位歧义。
 *
 * @param key 哈希键
 */
export function hashAlarmKey(key: string): number {
  const hashed = fnv1a(key) & ALARM_ID_MAX;
  // 0 保留给「无效」，统一落到 1
  return hashed === 0 ? 1 : hashed;
}

/**
 * 计算某条待办某一档提醒的闹钟 id。
 *
 * 同一 todo 的不同 kind 键不同 → id 不同；不同 todo 的同一 kind 键也不同。
 *
 * @param todoId 待办 id
 * @param kind 提醒档位
 */
export function alarmId(todoId: string, kind: ReminderKind): number {
  return hashAlarmKey(`zuoleme.alarm:${todoId}:${kind}`);
}

/**
 * 把待办列表编译成闹钟列表。
 *
 * 规则：
 * - 已完成的待办不产生任何闹钟；
 * - 已过去的档位由 `planReminders` 过滤掉（不补发）；
 * - id 冲突时按确定性线性探测递增，保证全局唯一；
 * - 输出按触发时刻升序（同一时刻按 id 升序），便于原生侧顺序排程。
 *
 * @param todos 待办列表
 * @param now 当前时间（毫秒时间戳），由调用方注入以便测试
 * @returns 扁平闹钟列表
 */
export function compileAlarms(todos: readonly Todo[], now: number): ReminderAlarm[] {
  if (!Number.isFinite(now)) {
    return [];
  }

  // 先按 id 排序，让 id 分配结果与输入顺序无关（幂等，便于调试与测试）
  const ordered = [...todos].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const usedIds = new Set<number>();
  const alarms: ReminderAlarm[] = [];

  for (const todo of ordered) {
    if (todo.done) {
      continue;
    }
    const plans = planReminders(todo.deadline, now);
    for (const plan of plans) {
      const id = allocateId(alarmId(todo.id, plan.kind), usedIds);
      alarms.push({
        id,
        todoId: todo.id,
        kind: plan.kind,
        title: todo.title,
        body: reminderBody(plan.kind),
        fireAt: plan.fireAt,
      });
    }
  }

  alarms.sort((a, b) => (a.fireAt !== b.fireAt ? a.fireAt - b.fireAt : a.id - b.id));
  return alarms;
}

/**
 * 分配一个全局未占用的闹钟 id。
 *
 * 哈希撞车概率极低（2^31 空间），但一旦撞车，两条提醒会互相覆盖，
 * 属于「静默丢提醒」级别的事故，所以这里做确定性线性探测兜底。
 *
 * @param candidate 哈希候选值
 * @param usedIds 已占用集合（会被就地修改）
 */
function allocateId(candidate: number, usedIds: Set<number>): number {
  let id = candidate;
  while (usedIds.has(id)) {
    id = id >= ALARM_ID_MAX ? 1 : id + 1;
  }
  usedIds.add(id);
  return id;
}

/**
 * 统计一条待办当前还剩几档提醒（用于界面文案，不给原生层用）。
 *
 * @param todo 待办
 * @param now 当前时间
 */
export function countPendingAlarms(todo: Todo, now: number): number {
  if (todo.done) {
    return 0;
  }
  return planReminders(todo.deadline, now).length;
}
