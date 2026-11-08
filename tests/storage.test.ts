import { beforeEach, describe, expect, it } from 'vitest';
import type { Todo } from '../shared/types';
import { DAY_MS } from '../shared/reminders';
import {
  CONTENT_MAX_LENGTH,
  LEGACY_STORAGE_KEY,
  STORAGE_KEY,
  STORAGE_VERSION,
  TITLE_MAX_LENGTH,
  api,
  readTodos,
  sortTodos,
} from '../src/lib/api';

/**
 * 本地存储与数据迁移测试（`src/lib/api.ts`）。
 *
 * 两条底线：
 * 1. **老用户升级后数据不能丢**。v1 的待办没有 content / repeat，
 *    迁移必须是「补默认值」而不是「丢弃重来」，并且 v1 要原样留着；
 * 2. **完成一个重复任务 = 推进 deadline，而不是把它标成已完成**。
 *    否则「每天喝水」点一次就永远消失了。
 *
 * Node 环境没有 localStorage，这里用一个 Map 垫片顶上。
 */

/** 最小可用的 localStorage 垫片 */
class MemoryStorage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    const value = this.map.get(key);
    return value === undefined ? null : value;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

const storage = new MemoryStorage();

// api.ts 只在函数体内访问 window.localStorage，因此可以在导入后再挂垫片
(globalThis as unknown as { window: { localStorage: MemoryStorage } }).window = { localStorage: storage };

beforeEach(() => {
  storage.clear();
});

/**
 * 造一条 v1 时代的数据（没有 content / repeat）。
 *
 * @param id 待办 id
 * @param overrides 需要覆盖的字段
 */
function legacyTodo(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `旧待办 ${id}`,
    deadline: Date.now() + 10 * DAY_MS,
    done: false,
    createdAt: Date.now() - DAY_MS,
    updatedAt: Date.now() - DAY_MS,
    ...overrides,
  };
}

describe('v1 → v2 迁移', () => {
  it('老数据补上 content="" 与 repeat={kind:"none"}，一条都不丢', () => {
    storage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify({ version: 1, todos: [legacyTodo('a'), legacyTodo('b')] })
    );

    const todos = readTodos();

    expect(todos).toHaveLength(2);
    for (const todo of todos) {
      expect(todo.content).toBe('');
      expect(todo.repeat).toEqual({ kind: 'none' });
      expect(todo.done).toBe(false);
    }
  });

  it('迁移后写入 v2（带 version=2），且 v1 原样保留', () => {
    const legacyRaw = JSON.stringify({ version: 1, todos: [legacyTodo('a')] });
    storage.setItem(LEGACY_STORAGE_KEY, legacyRaw);

    readTodos();

    const written = storage.getItem(STORAGE_KEY);
    expect(written).not.toBeNull();

    const parsed = JSON.parse(written as string) as { version: number; todos: Todo[] };
    expect(parsed.version).toBe(STORAGE_VERSION);
    expect(parsed.version).toBe(2);
    expect(parsed.todos).toHaveLength(1);

    // 关键：v1 不被删除，用户回退旧版本时数据仍在
    expect(storage.getItem(LEGACY_STORAGE_KEY)).toBe(legacyRaw);
  });

  it('v2 已存在时不再读 v1（以新数据为准）', () => {
    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ version: 1, todos: [legacyTodo('old')] }));
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 2, todos: [legacyTodo('new')] })
    );

    const todos = readTodos();

    expect(todos.map((todo) => todo.id)).toEqual(['new']);
  });

  it('老数据里多余的字段（比如 nextFireAt）不会污染模型', () => {
    storage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify({ version: 1, todos: [{ ...legacyTodo('a'), nextFireAt: 123 }] })
    );

    const todo = readTodos()[0] as Todo & { nextFireAt?: number };
    expect(todo.nextFireAt).toBeUndefined();
  });
});

describe('容错读取', () => {
  it('损坏的 JSON → 空数组（不抛异常，界面不会白屏）', () => {
    storage.setItem(STORAGE_KEY, '{ not json');

    expect(readTodos()).toEqual([]);
  });

  it('兼容历史「裸数组」形态', () => {
    storage.setItem(STORAGE_KEY, JSON.stringify([legacyTodo('a')]));

    expect(readTodos()).toHaveLength(1);
  });

  it('脏数据（缺 title 或缺 deadline）被跳过，其余照常读出', () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        todos: [
          { id: 'no-title', deadline: Date.now() + DAY_MS },
          { id: 'no-deadline', title: '没有截止时间' },
          { id: 'ok', title: '正常', deadline: Date.now() + DAY_MS },
        ],
      })
    );

    const todos = readTodos();
    expect(todos.map((todo) => todo.id)).toEqual(['ok']);
  });

  it('重复 id 只保留第一条', () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        todos: [legacyTodo('dup', { title: '第一' }), legacyTodo('dup', { title: '第二' })],
      })
    );

    const todos = readTodos();
    expect(todos).toHaveLength(1);
    expect(todos[0].title).toBe('第一');
  });
});

describe('sortTodos', () => {
  it('未完成在前 → deadline 升序 → id 兜底', () => {
    const base = {
      title: '待办',
      content: '',
      deadline: 0,
      done: false,
      repeat: { kind: 'none' as const },
      createdAt: 0,
      updatedAt: 0,
    };
    const todos: Todo[] = [
      { ...base, id: 'c', deadline: 300 },
      { ...base, id: 'a', deadline: 100 },
      { ...base, id: 'done', deadline: 50, done: true },
      { ...base, id: 'b', deadline: 100 },
    ];

    expect(sortTodos(todos).map((todo) => todo.id)).toEqual(['a', 'b', 'c', 'done']);
  });
});

describe('api.createTodo 校验', () => {
  it('正常创建：字段齐全，默认不重复、content 为空串', async () => {
    const todo = await api.createTodo({ title: '  交周报  ', deadline: Date.now() + DAY_MS });

    expect(todo.title).toBe('交周报');
    expect(todo.content).toBe('');
    expect(todo.repeat).toEqual({ kind: 'none' });
    expect(todo.done).toBe(false);
    expect((await api.listTodos()).map((item) => item.id)).toEqual([todo.id]);
  });

  it('标题为空 / 只有空白 → 报错', async () => {
    await expect(api.createTodo({ title: '   ', deadline: Date.now() + DAY_MS })).rejects.toThrow(
      '请填写待办标题'
    );
  });

  it('标题超长 → 报错', async () => {
    await expect(
      api.createTodo({ title: 'a'.repeat(TITLE_MAX_LENGTH + 1), deadline: Date.now() + DAY_MS })
    ).rejects.toThrow(`标题不能超过 ${TITLE_MAX_LENGTH} 字`);
  });

  it('内容超长 → 报错', async () => {
    await expect(
      api.createTodo({
        title: '正常',
        content: 'x'.repeat(CONTENT_MAX_LENGTH + 1),
        deadline: Date.now() + DAY_MS,
      })
    ).rejects.toThrow(`内容不能超过 ${CONTENT_MAX_LENGTH} 字`);
  });

  it('截止时间不在未来 → 报错', async () => {
    await expect(api.createTodo({ title: '过去的事', deadline: Date.now() - 1 })).rejects.toThrow(
      '截止时间必须晚于现在'
    );
  });

  it('每周重复一天都没选 → 报错（否则会存下永远不响的规则）', async () => {
    await expect(
      api.createTodo({
        title: '每周',
        deadline: Date.now() + DAY_MS,
        repeat: { kind: 'weekly', weekdays: [] },
      })
    ).rejects.toThrow('每周重复至少要选一天');
  });

  it('重复间隔小于 15 分钟 / 大于 30 天 → 报错', async () => {
    await expect(
      api.createTodo({
        title: '太密',
        deadline: Date.now() + DAY_MS,
        repeat: { kind: 'interval', intervalMs: 60_000 },
      })
    ).rejects.toThrow('重复间隔不能小于 15 分钟');

    await expect(
      api.createTodo({
        title: '太稀',
        deadline: Date.now() + DAY_MS,
        repeat: { kind: 'interval', intervalMs: 31 * DAY_MS },
      })
    ).rejects.toThrow('重复间隔不能大于 30 天');
  });
});

describe('api.updateTodo：完成语义', () => {
  it('一次性任务完成 → done = true', async () => {
    const created = await api.createTodo({ title: '一次性', deadline: Date.now() + DAY_MS });

    const updated = await api.updateTodo(created.id, { done: true });

    expect(updated.done).toBe(true);
    expect(updated.deadline).toBe(created.deadline);
  });

  it('每天任务完成 → done 保持 false，deadline 推进到下一次（不会消失）', async () => {
    const deadline = Date.now() + DAY_MS;
    const created = await api.createTodo({
      title: '每天喝水',
      deadline,
      repeat: { kind: 'daily' },
    });

    const updated = await api.updateTodo(created.id, { done: true });

    expect(updated.done).toBe(false);
    expect(updated.deadline).toBeGreaterThan(Date.now());
    expect(updated.deadline).toBeGreaterThan(created.deadline);
    // 每天的推进步长就是 1 天
    expect(updated.deadline - created.deadline).toBe(DAY_MS);
    expect(updated.repeat).toEqual({ kind: 'daily' });
  });

  it('每周任务完成 → 推进到下一个被选中的星期', async () => {
    const created = await api.createTodo({
      title: '每周复盘',
      deadline: Date.now() + DAY_MS,
      repeat: { kind: 'weekly', weekdays: [1, 4] },
    });

    const updated = await api.updateTodo(created.id, { done: true });

    expect(updated.done).toBe(false);
    expect(updated.deadline).toBeGreaterThan(created.deadline);
    expect(updated.deadline - created.deadline).toBeLessThanOrEqual(7 * DAY_MS);
  });

  it('取消完成 → done = false，deadline 不动', async () => {
    const created = await api.createTodo({ title: '可撤销', deadline: Date.now() + DAY_MS });
    await api.updateTodo(created.id, { done: true });

    const reverted = await api.updateTodo(created.id, { done: false });

    expect(reverted.done).toBe(false);
    expect(reverted.deadline).toBe(created.deadline);
  });

  it('修改标题 / 内容 / 截止时间 / 重复规则都会落盘', async () => {
    const created = await api.createTodo({ title: '原名', deadline: Date.now() + DAY_MS });
    const nextDeadline = Date.now() + 2 * DAY_MS;

    const updated = await api.updateTodo(created.id, {
      title: '新名',
      content: '新的具体内容',
      deadline: nextDeadline,
      repeat: { kind: 'monthly', dayOfMonth: 15 },
    });

    expect(updated.title).toBe('新名');
    expect(updated.content).toBe('新的具体内容');
    expect(updated.deadline).toBe(nextDeadline);
    expect(updated.repeat).toEqual({ kind: 'monthly', dayOfMonth: 15 });

    const reloaded = await api.getTodo(created.id);
    expect(reloaded).toEqual(updated);
  });

  it('不存在的 id → 报错', async () => {
    await expect(api.updateTodo('missing', { done: true })).rejects.toThrow('待办不存在');
  });

  it('标题非法时不写盘（原数据保持不变）', async () => {
    const created = await api.createTodo({ title: '原名', deadline: Date.now() + DAY_MS });

    await expect(api.updateTodo(created.id, { title: '  ' })).rejects.toThrow('请填写待办标题');
    expect((await api.getTodo(created.id))?.title).toBe('原名');
  });
});

describe('api.deleteTodo / getTodo', () => {
  it('删除后列表里不再有它，其余待办保留', async () => {
    const first = await api.createTodo({ title: '留着的', deadline: Date.now() + DAY_MS });
    const second = await api.createTodo({ title: '删掉的', deadline: Date.now() + 2 * DAY_MS });

    await api.deleteTodo(second.id);

    expect((await api.listTodos()).map((todo) => todo.id)).toEqual([first.id]);
    expect(await api.getTodo(second.id)).toBeNull();
  });

  it('删除不存在的 id 是安全的空操作', async () => {
    await expect(api.deleteTodo('missing')).resolves.toBeUndefined();
  });
});
