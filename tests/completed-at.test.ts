import { beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS } from '../shared/reminders';
import { STORAGE_KEY, api, readTodos } from '../src/lib/api';
import { installMemoryStorage } from './helpers/memory-storage';

/**
 * `completedAt` 的语义与老数据兼容（需求 5 的数据层）。
 *
 * 为什么这件事必须单独测：主页现在只显示 `!done` 的待办，已完成的都进历史页，
 * 历史页按 `completedAt` 倒序排。一旦「完成时不写 `completedAt`」或者
 * 「老数据没有这个字段就被当成未完成」，用户升级后会看到**历史页空着、
 * 而完成过的事重新回到待办列表**——这是最容易被忽略、又最难自愈的一类 bug。
 */

const storage = installMemoryStorage();

beforeEach(() => {
  storage.clear();
});

/** 直接往存储里塞一份 v2 原始数据（用来模拟「老版本写下的数据」） */
function seed(raw: unknown[]): void {
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, todos: raw }));
}

/** 一条最简一次性待办（已完成，但**没有** completedAt —— 老数据形态） */
function legacyDoneTodo(updatedAt: number): Record<string, unknown> {
  return {
    id: 'legacy-done',
    title: '老数据里已完成的事',
    content: '',
    deadline: updatedAt - HOUR_MS,
    advanceReminder: true,
    done: true,
    repeat: { kind: 'none' },
    createdAt: updatedAt - DAY_MS,
    updatedAt,
  };
}

describe('一次性待办：完成写入 completedAt，取消完成清空', () => {
  it('标记完成 → completedAt 是当前时间戳', async () => {
    const created = await api.createTodo({ title: '交周报', deadline: Date.now() + DAY_MS });
    expect(created.completedAt).toBeNull();

    const before = Date.now();
    const completed = await api.updateTodo(created.id, { done: true });
    const after = Date.now();

    expect(completed.done).toBe(true);
    expect(completed.completedAt).not.toBeNull();
    expect(completed.completedAt as number).toBeGreaterThanOrEqual(before);
    expect(completed.completedAt as number).toBeLessThanOrEqual(after);
    // 落盘的值与返回值一致（别只改了内存里的对象）
    expect(readTodos()[0].completedAt).toBe(completed.completedAt);
  });

  it('取消完成 → completedAt 归零（否则历史页会留着一条其实没完成的事）', async () => {
    const created = await api.createTodo({ title: '交周报', deadline: Date.now() + DAY_MS });
    await api.updateTodo(created.id, { done: true });

    const restored = await api.updateTodo(created.id, { done: false });

    expect(restored.done).toBe(false);
    expect(restored.completedAt).toBeNull();
    expect(readTodos()[0].completedAt).toBeNull();
  });

  it('只改标题不会动 completedAt（改标题不等于重新完成）', async () => {
    const created = await api.createTodo({ title: '交周报', deadline: Date.now() + DAY_MS });
    const completed = await api.updateTodo(created.id, { done: true });
    const stamp = completed.completedAt;

    const edited = await api.updateTodo(created.id, { title: '交周报（改）' });

    expect(edited.completedAt).toBe(stamp);
  });
});

describe('重复待办：完成 = 推进到下一次，completedAt 恒为 null', () => {
  it('每天重复的任务完成一次 → done 仍为 false，deadline 前进，completedAt 仍为 null', async () => {
    const deadline = Date.now() + HOUR_MS;
    const created = await api.createTodo({
      title: '吃药',
      deadline,
      repeat: { kind: 'daily' },
    });

    const advanced = await api.updateTodo(created.id, { done: true });

    expect(advanced.done).toBe(false);
    expect(advanced.completedAt).toBeNull();
    expect(advanced.deadline).not.toBeNull();
    expect(advanced.deadline as number).toBeGreaterThan(deadline);
    // 推进后的时间戳仍然落在「下一次的那一天」
    expect((advanced.deadline as number) - deadline).toBeGreaterThanOrEqual(DAY_MS - 2 * HOUR_MS);
  });

  it('重复任务不会因为完成而进入历史页（done 恒为 false 是历史页的过滤条件）', async () => {
    const created = await api.createTodo({
      title: '每周复盘',
      deadline: Date.now() + HOUR_MS,
      repeat: { kind: 'weekly', weekdays: [1] },
    });

    await api.updateTodo(created.id, { done: true });

    expect(readTodos().filter((todo) => todo.done)).toHaveLength(0);
  });
});

describe('老数据兼容：缺 completedAt 也不能被当成未完成', () => {
  it('done: true 但没有 completedAt → 用 updatedAt 兜底（历史页才不会空）', () => {
    const updatedAt = Date.now() - 3 * DAY_MS;
    seed([legacyDoneTodo(updatedAt)]);

    const [todo] = readTodos();

    expect(todo.done).toBe(true);
    expect(todo.completedAt).toBe(updatedAt);
  });

  it('done: false 且没有 completedAt → completedAt 为 null', () => {
    seed([
      {
        id: 'legacy-pending',
        title: '还没做的事',
        content: '',
        deadline: Date.now() + DAY_MS,
        advanceReminder: true,
        done: false,
        repeat: { kind: 'none' },
        createdAt: Date.now() - DAY_MS,
        updatedAt: Date.now() - DAY_MS,
      },
    ]);

    expect(readTodos()[0].completedAt).toBeNull();
  });

  it('completedAt 是脏值（字符串 / NaN）→ 退回 updatedAt，不把 NaN 带进排序', () => {
    const updatedAt = Date.now() - DAY_MS;
    seed([{ ...legacyDoneTodo(updatedAt), completedAt: 'not-a-number' }]);

    expect(readTodos()[0].completedAt).toBe(updatedAt);
  });

  it('已有 completedAt 的老数据保持原值（不会被 updatedAt 覆盖）', () => {
    const updatedAt = Date.now() - DAY_MS;
    const completedAt = Date.now() - 5 * DAY_MS;
    seed([{ ...legacyDoneTodo(updatedAt), completedAt }]);

    expect(readTodos()[0].completedAt).toBe(completedAt);
  });
});
