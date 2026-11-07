/// <reference types="@cloudflare/workers-types" />
import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, planReminders } from '../shared/reminders';
import {
  deleteTodoCascade,
  insertTodo,
  setTodoDone,
  updateTodoFields,
} from '../worker/src/db';
import { FakeD1 } from './helpers/fake-d1';

/**
 * 提醒重建逻辑测试（D1 语句级）。
 *
 * 核心风险：修改截止时间时**只重建不删除**，用户会同时收到新旧两套提醒（双份）。
 * 这里用记录型 D1 替身验证语句顺序，而不是只看最终状态——顺序错了终态也可能一样。
 */

const NOW = 1_700_000_000_000;
const TODO_ID = 'todo-1';

const DELETE_UNSENT_REMINDERS = /DELETE FROM reminders WHERE todo_id = \? AND sent = 0/;
const INSERT_REMINDERS = /INSERT INTO reminders/;
const UPDATE_TODO = /UPDATE todos SET/;

function asDb(fake: FakeD1): D1Database {
  return fake as unknown as D1Database;
}

describe('updateTodoFields：改截止时间必须「先删未发提醒、再按新时间重建」', () => {
  it('语句顺序为 UPDATE todos → DELETE(sent=0) → INSERT×N', async () => {
    const fake = new FakeD1();
    const deadline = NOW + 10 * DAY_MS;

    await updateTodoFields(asDb(fake), TODO_ID, { deadline }, NOW);

    const deleteIndex = fake.indexOfFirst(DELETE_UNSENT_REMINDERS);
    const firstInsertIndex = fake.indexOfFirst(INSERT_REMINDERS);

    expect(deleteIndex).toBeGreaterThan(-1);
    expect(firstInsertIndex).toBeGreaterThan(-1);
    // 关键断言：删除必须发生在第一次插入之前，否则新旧提醒会并存
    expect(deleteIndex).toBeLessThan(firstInsertIndex);
    // 删除只针对本条待办
    expect(fake.log[deleteIndex].params).toEqual([TODO_ID]);
  });

  it('重建的提醒条数与 planReminders 完全一致（不残留旧档位）', async () => {
    const fake = new FakeD1();
    const deadline = NOW + 10 * DAY_MS;
    const expected = planReminders(deadline, NOW);

    await updateTodoFields(asDb(fake), TODO_ID, { deadline }, NOW);

    const inserts = fake.matching(INSERT_REMINDERS);
    expect(inserts).toHaveLength(expected.length);
    // 每条 INSERT 的参数形如 [reminderId, todoId, fireAt, kind]
    expect(inserts.map((statement) => statement.params[2])).toEqual(expected.map((plan) => plan.fireAt));
    expect(inserts.map((statement) => statement.params[3])).toEqual(expected.map((plan) => plan.kind));
    // 全部 sent=0（SQL 里固定写 0）
    for (const statement of inserts) {
      expect(statement.sql).toContain('0, NULL');
    }
  });

  it('把截止时间从 10 天后改到 3 小时后 → 只留下 2 档', async () => {
    const fake = new FakeD1();
    const nearDeadline = NOW + 3 * HOUR_MS;

    await updateTodoFields(asDb(fake), TODO_ID, { deadline: nearDeadline }, NOW);

    const inserts = fake.matching(INSERT_REMINDERS);
    expect(inserts.map((statement) => statement.params[3])).toEqual(['1h', 'due']);
  });

  it('只改标题时完全不碰 reminders（避免改标题误删提醒）', async () => {
    const fake = new FakeD1();

    await updateTodoFields(asDb(fake), TODO_ID, { title: '新标题' }, NOW);

    expect(fake.matching(UPDATE_TODO)).toHaveLength(1);
    expect(fake.matching(DELETE_UNSENT_REMINDERS)).toHaveLength(0);
    expect(fake.matching(INSERT_REMINDERS)).toHaveLength(0);
  });

  it('同时改标题与截止时间 → 一次 UPDATE + 先删后插', async () => {
    const fake = new FakeD1();
    const deadline = NOW + 2 * DAY_MS;

    await updateTodoFields(asDb(fake), TODO_ID, { title: '新标题', deadline }, NOW);

    expect(fake.matching(UPDATE_TODO)).toHaveLength(1);
    const deleteIndex = fake.indexOfFirst(DELETE_UNSENT_REMINDERS);
    expect(deleteIndex).toBeLessThan(fake.indexOfFirst(INSERT_REMINDERS));
    expect(fake.matching(INSERT_REMINDERS)).toHaveLength(planReminders(deadline, NOW).length);
  });

  it('既没给标题也没给截止时间 → 不产生任何语句', async () => {
    const fake = new FakeD1();
    await updateTodoFields(asDb(fake), TODO_ID, {}, NOW);
    expect(fake.log).toHaveLength(0);
  });
});

describe('insertTodo：新建时按「只生成未来档位」写入', () => {
  it('30 天后截止 → 1 条 todos + 6 条 reminders，且在同一次 batch 内', async () => {
    const fake = new FakeD1();
    const deadline = NOW + 30 * DAY_MS;

    const id = await insertTodo(asDb(fake), { title: '交周报', deadline, now: NOW });

    expect(id).toMatch(/^[0-9a-f]{8}-/);
    expect(fake.matching(/INSERT INTO todos/)).toHaveLength(1);
    expect(fake.matching(INSERT_REMINDERS)).toHaveLength(6);
    expect(fake.log[0].params[1]).toBe('交周报');
  });

  it('30 分钟后截止 → 只写 1 条 reminder（due）', async () => {
    const fake = new FakeD1();
    await insertTodo(asDb(fake), { title: '喝水', deadline: NOW + 30 * 60_000, now: NOW });
    expect(fake.matching(INSERT_REMINDERS)).toHaveLength(1);
    expect(fake.log[1].params[3]).toBe('due');
  });
});

describe('setTodoDone：完成时清理未发提醒', () => {
  it('标记完成 → UPDATE done=1 并删除未发送提醒', async () => {
    const fake = new FakeD1();
    await setTodoDone(asDb(fake), TODO_ID, true, NOW);

    expect(fake.log[0].sql).toContain('UPDATE todos SET done = ?');
    expect(fake.log[0].params[0]).toBe(1);
    expect(fake.matching(DELETE_UNSENT_REMINDERS)).toHaveLength(1);
  });

  it('取消完成 → 不删除提醒（保留待发）', async () => {
    const fake = new FakeD1();
    await setTodoDone(asDb(fake), TODO_ID, false, NOW);

    expect(fake.log[0].params[0]).toBe(0);
    expect(fake.matching(DELETE_UNSENT_REMINDERS)).toHaveLength(0);
  });

  /**
   * 已知缺陷（D2）的固化用例：先完成、再取消完成之后，该待办的提醒被删光了，
   * 却没有任何代码路径把它重建回来 —— 于是它「永久不再提醒」，界面上 nextFireAt 变成 null。
   *
   * 之所以断言当前行为而不是期望行为：待工程师修复。修复后本用例会失败，
   * 届时请把它改成「取消完成后应重建未发提醒」。
   */
  it('【已知缺陷 D2】完成→取消完成不会重建提醒，该事项此后永久没有提醒', async () => {
    const fake = new FakeD1();

    await setTodoDone(asDb(fake), TODO_ID, true, NOW);
    expect(fake.matching(DELETE_UNSENT_REMINDERS)).toHaveLength(1);

    await setTodoDone(asDb(fake), TODO_ID, false, NOW);
    // 取消完成只改了 done 标记，没有 INSERT 任何提醒
    expect(fake.matching(INSERT_REMINDERS)).toHaveLength(0);
  });
});

describe('deleteTodoCascade：先删提醒再删待办', () => {
  it('存在该待办时按顺序删除两级记录', async () => {
    const fake = new FakeD1({ todos: [{ id: TODO_ID }] });

    const deleted = await deleteTodoCascade(asDb(fake), TODO_ID);

    expect(deleted).toBe(true);
    const deleteRemindersIndex = fake.indexOfFirst(/DELETE FROM reminders WHERE todo_id = \?/);
    const deleteTodoIndex = fake.indexOfFirst(/DELETE FROM todos WHERE id = \?/);
    expect(deleteRemindersIndex).toBeGreaterThan(-1);
    expect(deleteRemindersIndex).toBeLessThan(deleteTodoIndex);
  });

  it('待办不存在时返回 false 且不删除任何东西', async () => {
    const fake = new FakeD1({ todos: [] });
    const deleted = await deleteTodoCascade(asDb(fake), 'missing');
    expect(deleted).toBe(false);
    expect(fake.matching(/DELETE FROM/)).toHaveLength(0);
  });
});
