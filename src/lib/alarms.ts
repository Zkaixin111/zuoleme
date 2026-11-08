import { DAY_MS, reminderOffsetsFor } from '../../shared/reminders';
import { nextOccurrence } from '../../shared/repeat';
import type { ReminderKind, Todo } from '../../shared/types';

/**
 * 把待办列表「编译」成扁平的闹钟列表（纯函数，无任何 IO / 平台依赖）。
 *
 * 这一层要解决三件事：
 * 1. **重复任务展开**：一条「每天 9:00」的任务必须在未来一段时间里排多份闹钟，
 *    否则用户只会在第一次收到提醒；
 * 2. **档位随周期收缩**：见 `reminderOffsetsFor`；
 * 3. **id 全局唯一**：Android 用 id 同时当通知 id 与 PendingIntent requestCode，
 *    重复 → 后一条覆盖前一条 → 用户「少响一次」，而且不抛异常、不写日志。
 */

/** AlarmManager / NotificationManager 接受的 id 必须落在 32 位有符号正整数区间 */
export const ALARM_ID_MAX = 0x7fffffff;

/** 一次排程的全局上限：太多会让排程变慢，也超出系统耐心（240 条已能覆盖 30 天内的密集任务） */
export const MAX_ALARMS = 240;

/** 重复任务向后展开的时间窗：30 天 */
export const ALARM_HORIZON_MS = 30 * DAY_MS;

/** 单条重复任务最多展开的实例数（防止 15 分钟间隔把循环撑爆） */
const MAX_INSTANCES_PER_TODO = MAX_ALARMS;

/** 一条待排闹钟（与原生插件约定的结构，字段必须一一对应） */
export interface ReminderAlarm {
  /** 正整数 id：既是通知 id，也是 PendingIntent requestCode */
  id: number;
  /** 来源待办 id */
  todoId: string;
  /** 提醒档位 */
  kind: ReminderKind;
  /** 通知标题 = 待办标题（**不含** content） */
  title: string;
  /** 该实例的截止时刻（原生侧用它现算剩余时间文案） */
  deadline: number;
  /** 触发时刻（毫秒时间戳） */
  fireAt: number;
}

/** 编译结果（含被截断的数量，供界面提示） */
export interface CompileResult {
  alarms: ReminderAlarm[];
  /** 因超过 `MAX_ALARMS` 被丢弃的条数 */
  truncated: number;
}

/**
 * FNV-1a 32 位哈希（稳定、实现简单、无依赖）。
 *
 * @param input 待哈希字符串
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * 把任意键哈希成 1..0x7fffffff 的正整数。
 *
 * @param key 哈希键
 */
export function hashAlarmKey(key: string): number {
  const hashed = fnv1a(key) & ALARM_ID_MAX;
  return hashed === 0 ? 1 : hashed;
}

/**
 * 计算某条闹钟的 id。
 *
 * **必须把实例时刻 fireAt 纳入哈希**：同一条「每天」任务的 3h 档，
 * 每个实例的 (todoId, kind) 完全一样，只有 fireAt 不同；
 * 不计 fireAt 的话所有实例会算成同一个 id，后一个实例把前一个的闹钟顶掉。
 *
 * @param todoId 待办 id
 * @param kind 提醒档位
 * @param fireAt 该档位的触发时刻
 */
export function alarmId(todoId: string, kind: ReminderKind, fireAt: number): number {
  return hashAlarmKey(`zuoleme.alarm:${todoId}:${kind}:${fireAt}`);
}

/**
 * 展开一条待办的未来实例截止时刻。
 *
 * - 一次性任务：deadline 在未来就是唯一实例，否则没有实例；
 * - 重复任务：先推进到未来，再沿规则展开 `ALARM_HORIZON_MS` 内的全部实例。
 *
 * @param todo 待办
 * @param now 当前时间
 */
function instanceDeadlines(todo: Todo, now: number): number[] {
  const rule = todo.repeat;
  if (!rule || rule.kind === 'none') {
    return todo.deadline > now ? [todo.deadline] : [];
  }

  const horizon = now + ALARM_HORIZON_MS;
  const instances: number[] = [];

  let cursor = todo.deadline;
  // 当前这次已经过去：先推进到未来（不补发过去的实例）
  let guard = 0;
  while (cursor <= now && guard < MAX_INSTANCES_PER_TODO) {
    const next = nextOccurrence(cursor, rule, now);
    if (next === null) {
      return [];
    }
    cursor = next;
    guard += 1;
  }

  while (cursor < horizon && instances.length < MAX_INSTANCES_PER_TODO) {
    instances.push(cursor);
    const next = nextOccurrence(cursor, rule, cursor);
    if (next === null || next <= cursor) {
      break;
    }
    cursor = next;
  }

  return instances;
}

/**
 * 把待办列表编译成闹钟列表。
 *
 * @param todos 待办列表
 * @param now 当前时间（毫秒），由调用方注入以便测试
 * @returns 扁平闹钟列表（按 fireAt 升序，最多 `MAX_ALARMS` 条）
 */
export function compileAlarms(todos: readonly Todo[], now: number): ReminderAlarm[] {
  return compileAlarmsWithStats(todos, now).alarms;
}

/**
 * 同 `compileAlarms`，但额外给出被截断的条数（界面可据此提示）。
 *
 * @param todos 待办列表
 * @param now 当前时间
 */
export function compileAlarmsWithStats(todos: readonly Todo[], now: number): CompileResult {
  if (!Number.isFinite(now)) {
    return { alarms: [], truncated: 0 };
  }

  // 先按 id 排序，让 id 分配结果与输入顺序无关（幂等，便于调试与测试）
  const ordered = [...todos].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const usedIds = new Set<number>();
  const candidates: ReminderAlarm[] = [];

  for (const todo of ordered) {
    if (todo.done) {
      continue;
    }
    const offsets = reminderOffsetsFor(todo.repeat);
    for (const deadline of instanceDeadlines(todo, now)) {
      for (const offset of offsets) {
        const fireAt = deadline - offset.offsetMs;
        if (fireAt <= now) {
          continue;
        }
        const id = allocateId(alarmId(todo.id, offset.kind, fireAt), usedIds);
        candidates.push({
          id,
          todoId: todo.id,
          kind: offset.kind,
          title: todo.title,
          deadline,
          fireAt,
        });
      }
    }
  }

  candidates.sort((a, b) => (a.fireAt !== b.fireAt ? a.fireAt - b.fireAt : a.id - b.id));

  const alarms = candidates.slice(0, MAX_ALARMS);
  return { alarms, truncated: candidates.length - alarms.length };
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
 * 取下一次到期时刻（界面显示「下次 11月11日 09:00」用）。
 *
 * @param todo 待办
 * @param now 当前时间
 * @returns 下一次截止时间；一次性任务已过期或规则损坏时返回 null
 */
export function nextDeadlineFor(todo: Todo, now: number): number | null {
  if (todo.repeat.kind === 'none') {
    return todo.deadline > now ? todo.deadline : null;
  }
  if (todo.deadline > now) {
    return todo.deadline;
  }
  return nextOccurrence(todo.deadline, todo.repeat, now);
}

/**
 * 当前这一次还剩几档提醒（常驻卡片「还有 2 档提醒」用）。
 *
 * 注意只算**当前这一次**，不把重复任务的未来实例算进去，否则数字会大到没有意义。
 *
 * @param todo 待办
 * @param now 当前时间
 */
export function remainingReminderCount(todo: Todo, now: number): number {
  if (todo.done) {
    return 0;
  }
  const deadline = nextDeadlineFor(todo, now);
  if (deadline === null) {
    return 0;
  }
  return reminderOffsetsFor(todo.repeat).filter((offset) => deadline - offset.offsetMs > now).length;
}

/**
 * 统计一条待办在未来会响几次（一次性任务用；重复任务只算当前实例）。
 *
 * @param todo 待办
 * @param now 当前时间
 */
export function countPendingAlarms(todo: Todo, now: number): number {
  if (todo.done) {
    return 0;
  }
  const deadlines = instanceDeadlines(todo, now);
  let total = 0;
  for (const deadline of deadlines) {
    for (const offset of reminderOffsetsFor(todo.repeat)) {
      if (deadline - offset.offsetMs > now) {
        total += 1;
      }
    }
  }
  return total;
}
