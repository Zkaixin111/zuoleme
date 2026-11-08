import { describe, expect, it } from 'vitest';
import { DAY_MS } from '../shared/reminders';
import type { ReminderKind, Todo } from '../shared/types';
import { ALARM_ID_MAX, alarmId, compileAlarms, hashAlarmKey } from '../src/lib/alarms';

/**
 * 闹钟 id 的碰撞与唯一性专项测试。
 *
 * 为什么单独立一个文件：Android 把闹钟 id 同时当作**通知 id** 和
 * **PendingIntent requestCode**。两个不同的 (待办, 档位) 落到同一个 id 上时，
 * 后一条通知会覆盖前一条、后一个 PendingIntent 会替换前一个 ——
 * 用户看到的现象是「少响了一次」，而这正是本产品最核心的诉求。
 * 这类失败**不会抛异常、不会写日志**，只能靠测试证明。
 *
 * 覆盖三层：
 * 1. `hashAlarmKey` 自身的取值范围与稳定性；
 * 2. 真实规模下（上百个待办 × 六档）id 全局唯一；
 * 3. 已知哈希碰撞对上，`compileAlarms` 的线性探测是否真的救了回来。
 */

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

/** 六档 kind，顺序与 shared/reminders.ts 一致 */
const KINDS: readonly ReminderKind[] = ['7d', '3d', '1d', '3h', '1h', 'due'];

/**
 * 构造一条待办。
 *
 * @param id 待办 id
 * @param overrides 需要覆盖的字段
 */
function makeTodo(id: string, overrides: Partial<Todo> = {}): Todo {
  return {
    id,
    title: `待办 ${id}`,
    deadline: NOW + 30 * DAY_MS,
    done: false,
    createdAt: NOW - DAY_MS,
    updatedAt: NOW - DAY_MS,
    ...overrides,
  };
}

/**
 * 造一个贴近真实的 uuid v4 形态 id（长度 36，含连字符）。
 *
 * @param index 序号
 */
function uuidLike(index: number): string {
  const hex = index.toString(16).padStart(8, '0');
  return `${hex}-1111-4111-8111-${hex}00000000`.slice(0, 36);
}

/**
 * 断言一批 id 全部落在 AlarmManager / NotificationManager 可接受的区间内。
 *
 * @param ids 待检查的 id
 */
function expectValidIds(ids: readonly number[]): void {
  for (const id of ids) {
    expect(Number.isInteger(id)).toBe(true);
    expect(id).toBeGreaterThan(0);
    expect(id).toBeLessThanOrEqual(ALARM_ID_MAX);
    // 关键：必须能被 Kotlin 的 JSONObject.optInt 无损承接（32 位有符号正数）
    expect(id).toBeLessThan(2 ** 31);
  }
}

describe('hashAlarmKey 的取值范围', () => {
  it('任意输入都落在 1..0x7fffffff，且是整数（Kotlin Int 可无损承接）', () => {
    const keys = [
      '',
      'a',
      'zuoleme.alarm::',
      'zuoleme.alarm:x:7d',
      '做了么',
      'x'.repeat(500),
      '\u0000\u0001',
      '😀🚀',
    ];
    const ids = keys.map((key) => hashAlarmKey(key));
    expectValidIds(ids);
  });

  it('空串不会退化到 0（0 在原生侧表示「非法 id」）', () => {
    expect(hashAlarmKey('')).toBeGreaterThan(0);
  });

  it('同一键 1000 次结果完全一致（排程幂等的前提）', () => {
    const first = hashAlarmKey('zuoleme.alarm:fixed:due');
    for (let index = 0; index < 1000; index += 1) {
      expect(hashAlarmKey('zuoleme.alarm:fixed:due')).toBe(first);
    }
  });
});

describe('真实规模下的 id 全局唯一性', () => {
  it('100 个待办 × 6 档 = 600 个 (todoId, kind) 组合，id 两两不同', () => {
    const keys: string[] = [];
    const ids: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const todoId = uuidLike(index);
      for (const kind of KINDS) {
        keys.push(`${todoId}:${kind}`);
        ids.push(alarmId(todoId, kind));
      }
    }

    expect(keys).toHaveLength(600);
    // 集合大小等于数组长度 == 没有任何一对碰撞
    expect(new Set(ids).size).toBe(ids.length);
    expectValidIds(ids);
  });

  it('300 个待办 × 6 档 = 1800 个组合，id 仍然两两不同', () => {
    const ids: number[] = [];
    for (let index = 0; index < 300; index += 1) {
      const todoId = uuidLike(index);
      for (const kind of KINDS) {
        ids.push(alarmId(todoId, kind));
      }
    }

    expect(ids).toHaveLength(1800);
    expect(new Set(ids).size).toBe(ids.length);
    expectValidIds(ids);
  });

  it('同一待办的六档 id 严格互不相同（档位不会互相覆盖）', () => {
    const todoId = uuidLike(7);
    const ids = KINDS.map((kind) => alarmId(todoId, kind));

    expect(new Set(ids).size).toBe(KINDS.length);
    expectValidIds(ids);
  });

  it('不同待办的同一档位 id 互不相同', () => {
    const ids = Array.from({ length: 200 }, (_, index) => alarmId(uuidLike(index), 'due'));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('已知哈希碰撞：线性探测必须兜住', () => {
  /**
   * 由穷举搜索得到的真实碰撞对（FNV-1a 截 31 位后完全相同）：
   * - `zuoleme.alarm:seed-6417:3h`
   * - `zuoleme.alarm:seed-6548:due`
   * 两者哈希值都是 1400701556。
   *
   * 用它来证明两件事：
   * 1. 哈希层**确实可能**碰撞（所以不能只依赖哈希）；
   * 2. `compileAlarms` 的探测逻辑真的把碰撞解开了（这条才是用户关心的）。
   */
  const COLLIDE_A = { todoId: 'seed-6417', kind: '3h' as ReminderKind };
  const COLLIDE_B = { todoId: 'seed-6548', kind: 'due' as ReminderKind };

  it('两个不同档位确实哈希到同一个值（前提成立，不是假想）', () => {
    const hashA = alarmId(COLLIDE_A.todoId, COLLIDE_A.kind);
    const hashB = alarmId(COLLIDE_B.todoId, COLLIDE_B.kind);

    expect(hashA).toBe(hashB);
    expect(hashA).toBe(1400701556);
  });

  it('compileAlarms 把碰撞对拆成两个不同 id，且都不超过上界', () => {
    const alarms = compileAlarms(
      [makeTodo(COLLIDE_A.todoId), makeTodo(COLLIDE_B.todoId)],
      NOW
    );

    const ids = alarms.map((alarm) => alarm.id);
    expect(new Set(ids).size).toBe(ids.length);
    expectValidIds(ids);

    // 探测策略：先分配到的拿哈希原值，后分配到的 +1
    const first = alarms.find(
      (alarm) => alarm.todoId === COLLIDE_A.todoId && alarm.kind === COLLIDE_A.kind
    );
    const second = alarms.find(
      (alarm) => alarm.todoId === COLLIDE_B.todoId && alarm.kind === COLLIDE_B.kind
    );
    expect(first?.id).toBe(1400701556);
    expect(second?.id).toBe(1400701557);
  });

  it('碰撞对在场时，其他待办的 id 不受影响（探测只影响后来者）', () => {
    const neighbor = makeTodo('seed-6549');
    const withCollision = compileAlarms(
      [makeTodo(COLLIDE_A.todoId), makeTodo(COLLIDE_B.todoId), neighbor],
      NOW
    );
    const soloIds = new Set(
      compileAlarms([neighbor], NOW).map((alarm) => alarm.id)
    );

    const neighborIds = withCollision
      .filter((alarm) => alarm.todoId === neighbor.id)
      .map((alarm) => alarm.id);

    expect(neighborIds).toHaveLength(soloIds.size);
    for (const id of neighborIds) {
      expect(soloIds.has(id)).toBe(true);
    }
  });
});

describe('id 分配的确定性与稳定性', () => {
  it('无碰撞时 alarm.id 就等于 alarmId(todoId, kind)（可直接反查）', () => {
    const todos = [makeTodo(uuidLike(1)), makeTodo(uuidLike(2))];
    for (const alarm of compileAlarms(todos, NOW)) {
      expect(alarm.id).toBe(alarmId(alarm.todoId, alarm.kind));
    }
  });

  it('输入顺序打乱不改变 id 分配结果（幂等，重建后不会错位）', () => {
    const todos = [makeTodo(uuidLike(3)), makeTodo(uuidLike(4)), makeTodo(uuidLike(5))];
    const forward = compileAlarms(todos, NOW);
    const reversed = compileAlarms([...todos].reverse(), NOW);

    expect(reversed).toEqual(forward);
  });

  it('重复调用 20 次结果完全一致（防止引入随机性）', () => {
    const todos = [makeTodo(uuidLike(9)), makeTodo(uuidLike(10))];
    const baseline = compileAlarms(todos, NOW);
    for (let index = 0; index < 20; index += 1) {
      expect(compileAlarms(todos, NOW)).toEqual(baseline);
    }
  });
});
