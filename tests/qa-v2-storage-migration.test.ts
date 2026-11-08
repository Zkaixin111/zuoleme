import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS } from '../shared/reminders';
import { LEGACY_STORAGE_KEY, STORAGE_KEY, STORAGE_VERSION, StorageError, readTodos } from '../src/lib/api';

/**
 * QA 独立复验：v1 → v2 存储迁移（对应验收要求「标题与内容分离」+「支持定时任务」的数据层）。
 *
 * 老版本（v1）只有 `id/title/deadline/done/createdAt/updatedAt`，
 * 新版本多了 `content` 与 `repeat`。**用户数据丢失是不可接受事故**，所以这里钉三条：
 * 1. 一条都不能少；
 * 2. `content === ''`、`repeat.kind === 'none'`（不是 undefined / null）；
 * 3. `done` 与 `deadline` 原样保留（不能被 Date.now() 冲掉）。
 *
 * 另外钉脏数据鲁棒性：v1 里混一条 `deadline: "abc"` 的坏记录，
 * 只能丢这一条，其余必须完好 —— 迁移阶段丢整张表是最常见的翻车方式。
 */

/** 最小 localStorage 垫片 */
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
const holder = globalThis as unknown as { window: { localStorage: MemoryStorage } };
holder.window = { localStorage: storage };

const NOW = new Date(2026, 2, 3, 20, 0, 0, 0).getTime();

/**
 * 造一条真实的 v1 记录（**没有** content 与 repeat）。
 *
 * @param id 待办 id
 * @param overrides 覆盖字段
 */
function v1Record(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `旧待办 ${id}`,
    deadline: NOW + 3 * DAY_MS,
    done: false,
    createdAt: NOW - 10 * DAY_MS,
    updatedAt: NOW - 2 * DAY_MS,
    ...overrides,
  };
}

beforeEach(() => {
  storage.clear();
  holder.window = { localStorage: storage };
  vi.useFakeTimers({ now: NOW });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('E. v1 → v2 迁移不丢数据', () => {
  it('包裹形态 {version:1,todos}：条数不变、content=""、repeat=none、done/deadline 原样', () => {
    const legacy = [
      v1Record('a', { done: true, deadline: NOW + 1 * DAY_MS }),
      v1Record('b', { deadline: NOW + 5 * DAY_MS }),
      v1Record('c', { deadline: NOW - 2 * DAY_MS, done: false }),
    ];
    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ version: 1, todos: legacy }));

    const todos = readTodos();

    expect(todos).toHaveLength(3);
    const byId = new Map(todos.map((todo) => [todo.id, todo]));
    expect(byId.size).toBe(3);

    for (const record of legacy) {
      const migrated = byId.get(record.id as string);
      expect(migrated, `待办 ${record.id} 在迁移后消失`).toBeTruthy();
      expect(migrated?.content).toBe('');
      expect(migrated?.repeat).toEqual({ kind: 'none' });
      expect(migrated?.done).toBe(record.done);
      expect(migrated?.deadline).toBe(record.deadline);
      expect(migrated?.createdAt).toBe(record.createdAt);
      expect(migrated?.updatedAt).toBe(record.updatedAt);
    }
  });

  it('历史「裸数组」形态同样能迁移', () => {
    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify([v1Record('x'), v1Record('y')]));

    const todos = readTodos();

    expect(todos.map((todo) => todo.id).sort()).toEqual(['x', 'y']);
    expect(todos.every((todo) => todo.content === '' && todo.repeat.kind === 'none')).toBe(true);
  });

  it('迁移会写出 v2（version=2），并且 v1 原文一个字都不改', () => {
    const rawLegacy = JSON.stringify({ version: 1, todos: [v1Record('a'), v1Record('b')] });
    storage.setItem(LEGACY_STORAGE_KEY, rawLegacy);

    readTodos();

    expect(storage.getItem(LEGACY_STORAGE_KEY)).toBe(rawLegacy);
    const stored = JSON.parse(storage.getItem(STORAGE_KEY) as string) as { version: number; todos: unknown[] };
    expect(stored.version).toBe(STORAGE_VERSION);
    expect(stored.todos).toHaveLength(2);
  });

  it('100 条老数据全部迁移（不是只迁前几条）', () => {
    const legacy = Array.from({ length: 100 }, (_, index) => v1Record(`bulk-${index}`));
    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ version: 1, todos: legacy }));

    expect(readTodos()).toHaveLength(100);
  });

  it('v2 已存在时以 v2 为准，不会被 v1 覆盖回去', () => {
    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ version: 1, todos: [v1Record('old')] }));
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        todos: [
          {
            id: 'new',
            title: '新数据',
            content: '有内容',
            deadline: NOW + DAY_MS,
            done: false,
            repeat: { kind: 'daily' },
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      }),
    );

    const todos = readTodos();

    expect(todos).toHaveLength(1);
    expect(todos[0].id).toBe('new');
    expect(todos[0].content).toBe('有内容');
    expect(todos[0].repeat).toEqual({ kind: 'daily' });
  });
});

describe('E2. 脏数据鲁棒性：只丢坏的那一条', () => {
  it('v1 里混一条 deadline:"abc" → 该条被丢弃，其余两条完好', () => {
    storage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        todos: [v1Record('good-1'), v1Record('broken', { deadline: 'abc' }), v1Record('good-2')],
      }),
    );

    const todos = readTodos();

    expect(todos.map((todo) => todo.id).sort()).toEqual(['good-1', 'good-2']);
    expect(todos.find((todo) => todo.id === 'good-1')?.deadline).toBe(NOW + 3 * DAY_MS);
    expect(todos.find((todo) => todo.id === 'good-2')?.content).toBe('');
  });

  it('缺 title / 缺 id / 是 null 的记录逐条丢弃，有效记录照常读出', () => {
    storage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        todos: [v1Record('ok'), { ...v1Record('no-title'), title: undefined }, { id: '', title: 'x', deadline: 1 }, null],
      }),
    );

    const todos = readTodos();

    expect(todos).toHaveLength(1);
    expect(todos[0].id).toBe('ok');
  });

  it('损坏 JSON → 空数组，不抛异常（界面不会白屏）', () => {
    storage.setItem(LEGACY_STORAGE_KEY, '{not json');

    expect(readTodos()).toEqual([]);
  });

  it('v2 损坏（JSON 解析抛异常）→ 回落到完好的 v1，绝不返回空列表（修复后行为）', () => {
    // 修复前的缺陷：readTodos 只看「v2 字符串非空」，不区分「v2 损坏」与「用户确实清空了」，
    // 于是 v2 一旦损坏，用户一条待办都看不到，v1 的备份永远不会被再读到。
    // 修复后：解析抛异常 = 数据坏了 → 回落 v1。
    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ version: 1, todos: [v1Record('a')] }));
    storage.setItem(STORAGE_KEY, '{broken');

    const todos = readTodos();

    expect(todos.map((todo) => todo.id)).toEqual(['a']);
    // v1 原文仍然在盘上（没有被删除），这一点必须保持
    expect(storage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull();
  });

  it('v2 解析成功但是空数组 → 尊重 v2（用户真的清空了，绝不能把 v1 的老待办复活）', () => {
    // 这是与上一条**方向相反**的要求，必须同时成立，否则「回落」会变成「删除后自动复活」。
    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ version: 1, todos: [v1Record('a')] }));
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, todos: [] }));

    expect(readTodos()).toEqual([]);
  });

  it('v2 合法且有内容 → 只读 v2，v1 里的老待办不会混进来（迁移完成后以 v2 为准）', () => {
    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ version: 1, todos: [v1Record('old')] }));
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        todos: [
          {
            id: 'new',
            title: '新待办',
            content: '',
            deadline: NOW + 3 * DAY_MS,
            advanceReminder: true,
            done: false,
            repeat: { kind: 'none' },
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      }),
    );

    expect(readTodos().map((todo) => todo.id)).toEqual(['new']);
  });
});

describe('E3. 存储不可用时的错误必须是人话', () => {
  it('localStorage.getItem 抛异常 → StorageError，且消息可展示给用户', () => {
    holder.window = {
      localStorage: {
        getItem: (): string | null => {
          throw new Error('SecurityError');
        },
      } as unknown as MemoryStorage,
    };

    expect(() => readTodos()).toThrow(StorageError);
    expect(() => readTodos()).toThrow('无法访问本机存储');
  });
});
