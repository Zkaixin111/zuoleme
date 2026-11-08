import { describe, expect, it } from 'vitest';
import { NO_REPEAT, type Todo } from '../shared/types';
import { ALARM_ID_MAX, RESERVED_ALARM_IDS, allocateId, compileAlarms } from '../src/lib/alarms';

/**
 * 提醒 id 与常驻通知 id 的隔离（对刚交付功能的修正）。
 *
 * 常驻通知固定用 `OngoingService.NOTIFICATION_ID = 7011`；提醒的 id 同时也是通知 id
 * 与 PendingIntent requestCode。一旦某条提醒哈希到 7011，那条提醒会**顶掉常驻卡**，
 * 现象是「常驻功能坏了」，而且不抛异常、不打日志 —— 典型的静默事故。
 *
 * 所以 `allocateId` 在探测时跳过 `RESERVED_ALARM_IDS`。这里既直接测探测函数，
 * 也在真实编译结果上兜一层。
 */

const NOW = new Date(2026, 10, 8, 20, 0, 0, 0).getTime();
const DAY_MS = 86_400_000;

/**
 * 构造一条待办。
 *
 * @param id 待办 id
 * @param deadline 截止时间
 */
function makeTodo(id: string, deadline: number): Todo {
  return {
    id,
    title: `待办 ${id}`,
    content: '',
    deadline,
    advanceReminder: true,
    done: false,
    completedAt: null,
    repeat: NO_REPEAT,
    createdAt: NOW - DAY_MS,
    updatedAt: NOW - DAY_MS,
  };
}

describe('RESERVED_ALARM_IDS：常驻通知占用的 id 不许被提醒使用', () => {
  it('保留了 7011（与 OngoingService.NOTIFICATION_ID 一致）', () => {
    expect(RESERVED_ALARM_IDS.has(7011)).toBe(true);
    expect([...RESERVED_ALARM_IDS]).toEqual([7011]);
  });

  it('候选刚好是 7011 → 跳到 7012', () => {
    expect(allocateId(7011, new Set<number>())).toBe(7012);
  });

  it('7012 已被占用 → 继续探测到 7013（跳过保留区不影响线性探测）', () => {
    expect(allocateId(7011, new Set<number>([7012]))).toBe(7013);
  });

  it('候选在保留区之前/之后时不受影响', () => {
    expect(allocateId(7010, new Set<number>())).toBe(7010);
    expect(allocateId(7012, new Set<number>())).toBe(7012);
  });

  it('探测过程中撞上保留区也会跳过去（不只是起点）', () => {
    // 7010 已被占用 → 探测到 7011 → 保留 → 跳到 7012
    expect(allocateId(7010, new Set<number>([7010]))).toBe(7012);
  });

  it('到达上界时回绕，且回绕后仍然不落进保留区', () => {
    expect(allocateId(ALARM_ID_MAX, new Set<number>([ALARM_ID_MAX]))).toBe(1);
  });

  it('分配结果一定写进 usedIds（下一次调用不会重复）', () => {
    const used = new Set<number>();
    const first = allocateId(7011, used);
    const second = allocateId(7011, used);

    expect(first).toBe(7012);
    expect(second).toBe(7013);
    expect(used.has(7012)).toBe(true);
    expect(used.has(7013)).toBe(true);
  });
});

describe('真实编译结果里不出现 7011', () => {
  it('400 条待办编译出的闹钟，id 全唯一且都不等于 7011', () => {
    const todos: Todo[] = [];
    for (let index = 0; index < 400; index += 1) {
      todos.push(makeTodo(`todo-${index}`, NOW + (index + 1) * 3_600_000));
    }

    const alarms = compileAlarms(todos, NOW);
    const ids = alarms.map((alarm) => alarm.id);

    expect(alarms.length).toBeGreaterThan(0);
    expect(ids).not.toContain(7011);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
