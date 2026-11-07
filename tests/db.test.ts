/// <reference types="@cloudflare/workers-types" />
import { describe, expect, it } from 'vitest';
import {
  deleteTodoCascade,
  dueReminders,
  findTodo,
  incrementReminderAttempts,
  insertTodo,
  markReminderSent,
  setTodoDone,
} from '../worker/src/db';
import { StatefulD1, asDb } from './helpers/stateful-d1';

/**
 * 提醒终态测试（D2 缺陷回归 + attempts 计数）。
 *
 * 这里用「有状态」替身（tests/helpers/stateful-d1.ts），因为要断言的是终态：
 * 取消完成后未发提醒是否真的回来了、nextFireAt 是否非空。
 * 语句顺序类的断言在 todo-reminders.test.ts（记录型替身）里覆盖。
 */

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;

describe('setTodoDone：取消完成必须重建提醒（D2）', () => {
  it('完成 → 取消完成，未发提醒恢复，nextFireAt 非空', async () => {
    const fake = new StatefulD1();
    const db = asDb(fake);
    const deadline = NOW + 30 * DAY;

    const id = await insertTodo(db, { title: '交季度总结', deadline, now: NOW });
    expect(fake.reminders.filter((row) => row.sent === 0)).toHaveLength(6);

    // 勾选完成 → 未发提醒清空
    await setTodoDone(db, id, true, NOW + 1000);
    expect(fake.reminders.filter((row) => row.sent === 0)).toHaveLength(0);
    const doneTodo = await findTodo(db, id);
    expect(doneTodo?.done).toBe(1);
    expect(doneTodo?.next_fire_at ?? null).toBeNull();

    // 误触后取消完成 → 提醒必须按当前截止时间重建
    await setTodoDone(db, id, false, NOW + 2000);
    const pending = fake.reminders.filter((row) => row.sent === 0);
    expect(pending).toHaveLength(6);
    expect([...pending.map((row) => row.kind)].sort()).toEqual(['1d', '1h', '3d', '3h', '7d', 'due']);

    const restored = await findTodo(db, id);
    expect(restored?.done).toBe(0);
    expect(restored?.next_fire_at).toBe(deadline - 7 * DAY);
  });

  it('截止只剩 30 分钟时取消完成 → 只重建 due 一档', async () => {
    const fake = new StatefulD1();
    const db = asDb(fake);
    const deadline = NOW + 30 * 60_000;

    const id = await insertTodo(db, { title: '五分钟后开会', deadline, now: NOW });
    await setTodoDone(db, id, true, NOW + 1000);
    await setTodoDone(db, id, false, NOW + 2000);

    const pending = fake.reminders.filter((row) => row.sent === 0);
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe('due');
    expect((await findTodo(db, id))?.next_fire_at).toBe(deadline);
  });

  it('连续取消完成两次不会重复插入提醒（先 DELETE 再 INSERT）', async () => {
    const fake = new StatefulD1();
    const db = asDb(fake);
    const id = await insertTodo(db, { title: '重复点击', deadline: NOW + 10 * DAY, now: NOW });

    await setTodoDone(db, id, true, NOW + 1000);
    await setTodoDone(db, id, false, NOW + 2000);
    await setTodoDone(db, id, false, NOW + 3000);

    expect(fake.reminders.filter((row) => row.sent === 0)).toHaveLength(6);
  });

  it('已发送的历史提醒保留，且对应档位不会被重复生成', async () => {
    const fake = new StatefulD1();
    const db = asDb(fake);
    const deadline = NOW + 2 * HOUR;
    const id = await insertTodo(db, { title: '保留历史', deadline, now: NOW });

    // 真实时序：1h 档在 NOW+1h 到点被发送
    const fired = fake.reminders.find((row) => row.kind === '1h');
    expect(fired).toBeDefined();
    const firedAt = NOW + HOUR;
    await markReminderSent(db, fired!.id, firedAt);

    // 之后用户误点完成，再取消完成
    await setTodoDone(db, id, true, firedAt + 60_000);
    await setTodoDone(db, id, false, firedAt + 120_000);

    expect(fake.reminders.filter((row) => row.sent === 1)).toHaveLength(1);
    const pending = fake.reminders.filter((row) => row.sent === 0);
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe('due');
  });

  it('待办不存在时取消完成不抛错、也不插入任何提醒', async () => {
    const fake = new StatefulD1();
    await setTodoDone(asDb(fake), 'missing', false, NOW);
    expect(fake.reminders).toHaveLength(0);
  });
});

describe('提醒重试计数（D1 修复的支撑能力）', () => {
  it('dueReminders 带出 attempts；markReminderSent 置 sent=1 并累加 attempts', async () => {
    const fake = new StatefulD1();
    const db = asDb(fake);
    await insertTodo(db, { title: '到点提醒', deadline: NOW + 60_000, now: NOW });

    const due = await dueReminders(db, NOW + 120_000);
    expect(due).toHaveLength(1);
    expect(due[0].attempts).toBe(0);
    expect(due[0].kind).toBe('due');

    await markReminderSent(db, due[0].id, NOW + 120_000);
    const row = fake.reminders.find((item) => item.id === due[0].id);
    expect(row?.sent).toBe(1);
    expect(row?.attempts).toBe(1);
    expect(row?.sent_at).toBe(NOW + 120_000);

    // 已发送后不再出现在扫描结果里
    expect(await dueReminders(db, NOW + 180_000)).toHaveLength(0);
  });

  it('incrementReminderAttempts 只加计数、不改 sent，下一轮仍会被扫到', async () => {
    const fake = new StatefulD1();
    const db = asDb(fake);
    await insertTodo(db, { title: '重试中', deadline: NOW + 60_000, now: NOW });

    const firstScan = await dueReminders(db, NOW + 120_000);
    await incrementReminderAttempts(db, firstScan[0].id);

    const secondScan = await dueReminders(db, NOW + 180_000);
    expect(secondScan).toHaveLength(1);
    expect(secondScan[0].attempts).toBe(1);
    expect(fake.reminders[0].sent).toBe(0);
  });

  it('删除待办时级联删除其提醒（含重试中的）', async () => {
    const fake = new StatefulD1();
    const db = asDb(fake);
    const id = await insertTodo(db, { title: '要删掉的', deadline: NOW + 60_000, now: NOW });

    expect(await deleteTodoCascade(db, id)).toBe(true);
    expect(fake.reminders).toHaveLength(0);
    expect(fake.todos).toHaveLength(0);
    expect(await deleteTodoCascade(db, id)).toBe(false);
  });
});
