import type { CreateTodoBody, Todo, UpdateTodoBody } from '../../shared/types';

/**
 * 本地待办存储（APK 版本）。
 *
 * 历史包袱说明：这个文件以前是 Cloudflare Worker 的 HTTP 客户端，
 * 现在整个应用**不联网**，所以同名模块退化成「localStorage 仓储层」，
 * 对外仍然暴露 `api.listTodos / createTodo / updateTodo / deleteTodo` 四个方法，
 * 让 UI 层不需要关心数据从哪来。
 *
 * 数据只有一处真相：localStorage 的 `zuoleme.todos.v1`。
 * 结构是 `{ version: 1, todos: Todo[] }`，带 version 是为了以后能平滑迁移。
 */

/** localStorage 键名：改了它等于清空用户数据，务必谨慎 */
export const STORAGE_KEY = 'zuoleme.todos.v1';

/** 当前存储结构版本 */
const STORAGE_VERSION = 1;

/** 标题最大长度（与输入框 maxLength 一致） */
export const TITLE_MAX_LENGTH = 200;

/** 存储层错误（消息可直接展示给用户） */
export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

/** 磁盘上的存储结构 */
interface StoredState {
  version: number;
  todos: Todo[];
}

/**
 * 生成待办 id。
 *
 * 优先用 `crypto.randomUUID()`（Capacitor WebView 里可用），
 * 老 WebView 回退到「时间戳 + 随机数」的组合，保证同一毫秒内也不重复。
 */
function createId(): string {
  const cryptoApi = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  const random = Math.floor(Math.random() * 0xffffffff).toString(36);
  return `t-${Date.now().toString(36)}-${random}`;
}

/**
 * 类型守卫：判断一个未知值是否是合法的 Todo。
 *
 * 存储可能被手工改坏（用户清缓存、旧版本残留），
 * 遇到脏数据时**丢弃单条**而不是整体崩溃。
 *
 * @param value 待判定的未知值
 */
function isTodo(value: unknown): value is Todo {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Todo>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.title === 'string' &&
    typeof candidate.deadline === 'number' &&
    Number.isFinite(candidate.deadline) &&
    typeof candidate.done === 'boolean' &&
    typeof candidate.createdAt === 'number' &&
    Number.isFinite(candidate.createdAt) &&
    typeof candidate.updatedAt === 'number' &&
    Number.isFinite(candidate.updatedAt)
  );
}

/**
 * 把任意对象规整成 Todo（补默认值、剔除多余字段）。
 *
 * @param value 原始值
 * @returns 合法 Todo；不合法返回 null
 */
function normalizeTodo(value: unknown): Todo | null {
  if (!isTodo(value)) {
    return null;
  }
  return {
    id: value.id,
    title: value.title,
    deadline: value.deadline,
    done: value.done,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/**
 * 待办排序：未完成在前 → 截止时间升序 → 创建时间升序。
 *
 * 排序规则写在存储层，保证每次读出来的顺序完全一致（常驻卡片依赖「第一条」语义）。
 *
 * @param todos 待排序数组
 * @returns 排序后的新数组
 */
export function sortTodos(todos: readonly Todo[]): Todo[] {
  return [...todos].sort((a, b) => {
    if (a.done !== b.done) {
      return a.done ? 1 : -1;
    }
    if (a.deadline !== b.deadline) {
      return a.deadline - b.deadline;
    }
    if (a.createdAt !== b.createdAt) {
      return a.createdAt - b.createdAt;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * 读取全部待办。
 *
 * @returns 按「未完成在前、截止时间升序、创建时间升序」排好序的待办数组
 * @throws StorageError 当 localStorage 不可用（隐私模式 / 配额异常）
 */
export function readTodos(): Todo[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    throw new StorageError('无法访问本机存储，请检查系统是否禁止了应用存储权限');
  }

  if (raw === null || raw.trim().length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 数据损坏：不清空用户数据，先按空列表处理，下次写入时覆盖
    return [];
  }

  const rawTodos: unknown[] = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as StoredState).todos)
      ? (parsed as StoredState).todos
      : [];

  const seen = new Set<string>();
  const todos: Todo[] = [];
  for (const item of rawTodos) {
    const todo = normalizeTodo(item);
    if (todo === null || seen.has(todo.id)) {
      continue;
    }
    seen.add(todo.id);
    todos.push(todo);
  }
  return sortTodos(todos);
}

/**
 * 覆盖写入全部待办。
 *
 * @param todos 待写入的待办（函数内部会再排一次序）
 * @throws StorageError 写入失败（配额满 / 隐私模式）
 */
function writeTodos(todos: readonly Todo[]): void {
  const state: StoredState = { version: STORAGE_VERSION, todos: sortTodos(todos) };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    throw new StorageError('保存失败：本机存储空间不足或被系统禁止写入');
  }
}

/**
 * 本地待办仓储 API（方法名与旧 HTTP 客户端保持一致，UI 层无需改动调用方式）。
 */
export const api = {
  /** 列出全部待办（同步读本机存储，包成 Promise 保持旧签名） */
  async listTodos(): Promise<Todo[]> {
    return readTodos();
  },

  /**
   * 新建待办。
   *
   * @param body 标题与截止时间
   * @returns 新建后的完整待办
   * @throws StorageError 标题/截止时间非法，或写入失败
   */
  async createTodo(body: CreateTodoBody): Promise<Todo> {
    const title = body.title.trim();
    if (title.length === 0) {
      throw new StorageError('请填写待办内容');
    }
    if (title.length > TITLE_MAX_LENGTH) {
      throw new StorageError(`内容不能超过 ${TITLE_MAX_LENGTH} 字`);
    }
    if (!Number.isFinite(body.deadline)) {
      throw new StorageError('请选择截止时间');
    }
    if (body.deadline <= Date.now()) {
      throw new StorageError('截止时间必须晚于现在');
    }

    const now = Date.now();
    const todo: Todo = {
      id: createId(),
      title,
      deadline: body.deadline,
      done: false,
      createdAt: now,
      updatedAt: now,
    };
    const next = sortTodos([...readTodos(), todo]);
    writeTodos(next);
    return todo;
  },

  /**
   * 更新待办（完成状态 / 标题 / 截止时间）。
   *
   * @param id 待办 id
   * @param body 需要修改的字段
   * @returns 更新后的待办
   * @throws StorageError 待办不存在或字段非法
   */
  async updateTodo(id: string, body: UpdateTodoBody): Promise<Todo> {
    const todos = readTodos();
    const index = todos.findIndex((item) => item.id === id);
    if (index < 0) {
      throw new StorageError('待办不存在，可能已被删除');
    }

    const current = todos[index];
    const patch: UpdateTodoBody = {};

    if (body.title !== undefined) {
      const title = body.title.trim();
      if (title.length === 0) {
        throw new StorageError('待办内容不能为空');
      }
      if (title.length > TITLE_MAX_LENGTH) {
        throw new StorageError(`内容不能超过 ${TITLE_MAX_LENGTH} 字`);
      }
      patch.title = title;
    }

    if (body.deadline !== undefined) {
      if (!Number.isFinite(body.deadline)) {
        throw new StorageError('截止时间不合法');
      }
      patch.deadline = body.deadline;
    }

    if (body.done !== undefined) {
      patch.done = body.done;
    }

    const updated: Todo = {
      ...current,
      ...patch,
      updatedAt: Date.now(),
    };

    const next = todos.slice();
    next[index] = updated;
    writeTodos(next);
    return updated;
  },

  /**
   * 删除待办。
   *
   * 提醒由调用方在数据变化后全量重排（见 lib/reminder-bridge.ts），
   * 所以这里不需要额外清理闹钟。
   *
   * @param id 待办 id
   */
  async deleteTodo(id: string): Promise<void> {
    const todos = readTodos();
    const next = todos.filter((item) => item.id !== id);
    if (next.length === todos.length) {
      return;
    }
    writeTodos(next);
  },
};
