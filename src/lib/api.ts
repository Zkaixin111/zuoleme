import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  isValidRepeatRule,
  nextOccurrence,
  normalizeRepeatRule,
  normalizeWeekdays,
} from '../../shared/repeat';
import type { CreateTodoBody, RepeatRule, Todo, UpdateTodoBody } from '../../shared/types';

/**
 * 本地待办存储（APK 版本）。
 *
 * 数据只有一处真相：`localStorage` 的 `zuoleme.todos.v2`。
 * 结构是 `{ version: 2, todos: Todo[] }`。
 *
 * 迁移策略（**不做破坏性迁移**）：v2 不存在时读 v1，逐条补上
 * `content: ''` 与 `repeat: { kind: 'none' }` 后写入 v2，**v1 原样保留不删**。
 * 用户数据丢失是不可接受事故，留一份旧数据比省那点空间重要得多。
 *
 * **为什么加了 `deadline: number | null` 与 `advanceReminder` 却不升到 v3**：
 * 这两个字段都能宽容补默认值（`advanceReminder` 缺失 → `true`，
 * `deadline` 缺失/null → `null`），不需要任何迁移动作；
 * 而刚修完「升级后闹钟全丢」这个 P1，再来一次版本切换就是重蹈覆辙 ——
 * 版本号只在**必须改写已存在字段的语义**时才动。
 */

/** 当前存储键 */
export const STORAGE_KEY = 'zuoleme.todos.v2';

/** 旧版本存储键（只读，永远不删） */
export const LEGACY_STORAGE_KEY = 'zuoleme.todos.v1';

/** 存储结构版本 */
export const STORAGE_VERSION = 2;

/** 标题最大长度 */
export const TITLE_MAX_LENGTH = 100;

/** 内容最大长度 */
export const CONTENT_MAX_LENGTH = 2000;

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
 * 优先 `crypto.randomUUID()`（Capacitor WebView 可用），老 WebView 回退到时间戳 + 随机数。
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
 * 读取某个键的原始字符串。
 *
 * @param key localStorage 键
 * @throws StorageError localStorage 不可用
 */
function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    throw new StorageError('无法访问本机存储，请检查系统是否禁止了应用存储权限');
  }
}

/**
 * 把任意一条数据规整成 Todo。
 *
 * **刻意宽松**：老数据没有 content / repeat / advanceReminder，缺字段就补默认值，
 * 绝不因此丢弃整条待办。只有「id / title 缺失或类型错误」以及
 * 「deadline 既不是数字也不是 null」才判定为脏数据。
 *
 * `deadline` 缺失与 `null` 都表示「不设时间」——这两个新字段都是**纯增量字段**，
 * 所以存储版本保持 zuoleme.todos.v2 不动，不需要迁移动作（见文件头注释）。
 *
 * @param value 原始值
 */
function normalizeTodo(value: unknown): Todo | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as Partial<Todo>;

  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    return null;
  }
  if (typeof candidate.title !== 'string') {
    return null;
  }

  let deadline: number | null;
  if (candidate.deadline === undefined || candidate.deadline === null) {
    deadline = null;
  } else if (typeof candidate.deadline === 'number' && Number.isFinite(candidate.deadline)) {
    deadline = candidate.deadline;
  } else {
    // 类型不对（比如 "abc"）：这是脏数据，丢掉这一条
    return null;
  }

  const now = Date.now();
  const hasDeadline = deadline !== null;
  const done = candidate.done === true;
  const createdAt = typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
    ? candidate.createdAt
    : now;
  const updatedAt = typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
    ? candidate.updatedAt
    : now;

  /**
   * 完成时刻。
   *
   * 两个容易写错的分支：
   * - `done === false` 一律 `null`：哪怕磁盘上残留了一个旧时间戳也要清掉，
   *   否则「取消完成再完成」会显示成很久以前完成的；
   * - `done === true` 但没有 `completedAt`（B5 之前的老数据）→ 用 `updatedAt` 兜底。
   *   没有这个兜底，升级后历史页会是空的 —— 用户会以为待办被删了。
   */
  let completedAt: number | null = null;
  if (done) {
    completedAt = typeof candidate.completedAt === 'number' && Number.isFinite(candidate.completedAt)
      ? candidate.completedAt
      : updatedAt;
  }

  return {
    id: candidate.id,
    title: candidate.title,
    content: typeof candidate.content === 'string' ? candidate.content : '',
    deadline,
    // 缺省视为「开启提前提醒」；没有截止时间时这个开关没有意义，归位 true
    advanceReminder: hasDeadline && candidate.advanceReminder === false ? false : true,
    done,
    completedAt,
    // 重复需要时间锚点：没有 deadline 的待办一律按「不重复」处理
    repeat: hasDeadline ? normalizeRepeatRule(candidate.repeat) : { kind: 'none' },
    createdAt,
    updatedAt,
  };
}

/**
 * 解析一段存储文本。
 *
 * 兼容三种历史形态：`{version, todos}`、裸数组、以及损坏 JSON（返回空数组）。
 *
 * @param raw 原始字符串
 */
function parseTodos(raw: string): Todo[] {
  return tryParseTodos(raw) ?? [];
}

/**
 * 尝试解析一段存储文本。
 *
 * @param raw 原始字符串
 * @returns 解析成功返回待办数组（可能是空数组）；**JSON 本身损坏返回 null**
 */
function tryParseTodos(raw: string): Todo[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
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
  return todos;
}

/**
 * 待办排序：未完成在前 → 有截止时间的按时间升序 → 无截止时间的排在有时间的之后
 * （组内按创建时间）→ 已完成的永远最后。
 *
 * 「无期限」必须显式排到最后而不是靠 `null - now` 参与比较：
 * `null` 参与算术会变成 0，等于 1970 年，那条待办会跳到最前面冒充「最早到期」。
 *
 * @param todos 待排序数组
 */
export function sortTodos(todos: readonly Todo[]): Todo[] {
  return [...todos].sort((a, b) => {
    if (a.done !== b.done) {
      return a.done ? 1 : -1;
    }

    const aHasDeadline = a.deadline !== null;
    const bHasDeadline = b.deadline !== null;
    if (aHasDeadline !== bHasDeadline) {
      return aHasDeadline ? -1 : 1;
    }
    if (a.deadline !== null && b.deadline !== null && a.deadline !== b.deadline) {
      return a.deadline - b.deadline;
    }

    if (a.createdAt !== b.createdAt) {
      return a.createdAt - b.createdAt;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * 读取全部待办（含 v1 → v2 迁移）。
 *
 * **区分「损坏」与「清空」**（这是 P2 的一条真实缺陷修复）：
 * - v2 的 JSON **解析抛异常** → 说明数据坏了，回落到完好的 v1 备份，
 *   否则用户一条待办都看不到；再新建一条就会把 v2 覆盖掉，v1 备份从此再也读不回来；
 * - v2 解析成功但是空数组 → 用户真的把待办删光了，**尊重 v2**，绝不能把 v1 里的老待办复活。
 *
 * @returns 排好序的待办数组
 * @throws StorageError localStorage 不可用
 */
export function readTodos(): Todo[] {
  const current = readRaw(STORAGE_KEY);
  if (current !== null && current.trim().length > 0) {
    const parsed = tryParseTodos(current);
    if (parsed !== null) {
      return sortTodos(parsed);
    }
    // 走到这里说明 v2 坏了：继续往下尝试 v1，而不是返回空数组
  }

  const legacy = readRaw(LEGACY_STORAGE_KEY);
  if (legacy !== null && legacy.trim().length > 0) {
    const migrated = parseTodos(legacy);
    if (migrated.length > 0) {
      // 写入 v2；v1 保持原样，用户回退旧版本时数据仍在
      writeTodos(migrated);
    }
    return sortTodos(migrated);
  }

  return [];
}

/**
 * 覆盖写入全部待办。
 *
 * @param todos 待写入的待办
 * @throws StorageError 写入失败
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
 * 校验标题。
 *
 * @param title 原始标题
 */
function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new StorageError('请填写待办标题');
  }
  if (trimmed.length > TITLE_MAX_LENGTH) {
    throw new StorageError(`标题不能超过 ${TITLE_MAX_LENGTH} 字`);
  }
  return trimmed;
}

/**
 * 校验内容。
 *
 * @param content 原始内容
 */
function normalizeContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length > CONTENT_MAX_LENGTH) {
    throw new StorageError(`内容不能超过 ${CONTENT_MAX_LENGTH} 字`);
  }
  return trimmed;
}

/**
 * 校验重复规则（结构 + 间隔上下限）。
 *
 * @param repeat 原始规则
 */
function validateRepeat(repeat: RepeatRule | undefined): RepeatRule {
  if (repeat === undefined) {
    return { kind: 'none' };
  }
  if (!isValidRepeatRule(repeat)) {
    throw new StorageError('重复规则不合法');
  }
  // 注意顺序：必须先看**原始**规则里有没有选星期。
  // `normalizeRepeatRule` 会把「空星期」悄悄降级成「不重复」，
  // 那是读盘时的兜底策略；写入时这么做等于把用户的「每周」悄悄改掉，必须报错。
  if (repeat.kind === 'weekly' && normalizeWeekdays(repeat.weekdays).length === 0) {
    throw new StorageError('每周重复至少要选一天');
  }
  const normalized = normalizeRepeatRule(repeat);
  if (normalized.kind === 'interval') {
    if (normalized.intervalMs < MIN_INTERVAL_MS) {
      throw new StorageError('重复间隔不能小于 15 分钟');
    }
    if (normalized.intervalMs > MAX_INTERVAL_MS) {
      throw new StorageError('重复间隔不能大于 30 天');
    }
  }
  return normalized;
}

/**
 * 本地待办仓储 API。
 */
export const api = {
  /** 列出全部待办 */
  async listTodos(): Promise<Todo[]> {
    return readTodos();
  },

  /**
   * 新建待办。
   *
   * `deadline` 可以是 `null`（用户选「不设时间」）：这类待办不产生任何提醒，
   * 因此也不校验「必须晚于现在」，并且重复规则会被强制归零。
   *
   * @param body 标题 / 内容 / 截止时间 / 提前提醒开关 / 重复规则
   */
  async createTodo(body: CreateTodoBody): Promise<Todo> {
    const title = normalizeTitle(body.title);
    const content = normalizeContent(body.content ?? '');
    const deadline = body.deadline ?? null;

    if (deadline !== null) {
      if (!Number.isFinite(deadline)) {
        throw new StorageError('截止时间不合法');
      }
      if (deadline <= Date.now()) {
        throw new StorageError('截止时间必须晚于现在');
      }
    }

    // 没有截止时间就没有时间锚点：重复与提前提醒都无意义，一律归位
    const repeat = deadline === null ? { kind: 'none' as const } : validateRepeat(body.repeat);
    const advanceReminder = deadline === null ? true : body.advanceReminder !== false;

    const now = Date.now();
    const todo: Todo = {
      id: createId(),
      title,
      content,
      deadline,
      advanceReminder,
      done: false,
      completedAt: null,
      repeat,
      createdAt: now,
      updatedAt: now,
    };
    writeTodos([...readTodos(), todo]);
    return todo;
  },

  /**
   * 更新待办。
   *
   * 关键语义：
   * 1. **完成一个重复任务 = 把 deadline 推进到下一次**，`done` 保持 false；
   *    只有一次性任务才会真的被标记为完成；
   * 2. `deadline` 传 `null` = 清除时间，同一事务里把 `repeat` 归零、
   *    `advanceReminder` 回 `true`（无截止时间时这两个值都没有意义，留着只会造成困惑）；
   * 3. 从 `null` 改回有值时，`advanceReminder` 保持默认 `true`，除非请求体显式给了 `false`。
   *
   * @param id 待办 id
   * @param body 需要修改的字段
   * @throws StorageError 待办不存在或字段非法
   */
  async updateTodo(id: string, body: UpdateTodoBody): Promise<Todo> {
    const todos = readTodos();
    const index = todos.findIndex((item) => item.id === id);
    if (index < 0) {
      throw new StorageError('待办不存在，可能已被删除');
    }

    const current = todos[index];
    const patch: Partial<Todo> = {};

    if (body.title !== undefined) {
      patch.title = normalizeTitle(body.title);
    }
    if (body.content !== undefined) {
      patch.content = normalizeContent(body.content);
    }
    if (body.deadline !== undefined) {
      if (body.deadline === null) {
        patch.deadline = null;
      } else if (!Number.isFinite(body.deadline)) {
        throw new StorageError('截止时间不合法');
      } else {
        patch.deadline = body.deadline;
      }
    }
    if (body.advanceReminder !== undefined) {
      patch.advanceReminder = body.advanceReminder === true;
    }
    if (body.repeat !== undefined) {
      patch.repeat = validateRepeat(body.repeat);
    }

    const now = Date.now();
    const merged: Todo = { ...current, ...patch };

    // 不变量：没有截止时间 ⇒ 没有重复、没有提前档位
    if (merged.deadline === null) {
      merged.repeat = { kind: 'none' };
      merged.advanceReminder = true;
    }

    let updated: Todo;
    if (body.done === true) {
      const next =
        merged.deadline === null || merged.repeat.kind === 'none'
          ? null
          : nextOccurrence(merged.deadline, merged.repeat, now);
      if (next === null) {
        // 一次性任务 / 无期限任务，或规则损坏：退化成「真的完成」，不把任务卡死
        updated = { ...merged, done: true, completedAt: now, updatedAt: now };
      } else {
        // 重复任务：推进到下一次，**不算完成**，所以 completedAt 保持 null
        updated = { ...merged, deadline: next, done: false, completedAt: null, updatedAt: now };
      }
    } else if (body.done === false) {
      // 取消完成：清掉完成时刻，否则历史页里会留下一条已完成副本
      updated = { ...merged, done: false, completedAt: null, updatedAt: now };
    } else {
      updated = { ...merged, updatedAt: now };
    }

    const nextTodos = todos.slice();
    nextTodos[index] = updated;
    writeTodos(nextTodos);
    return updated;
  },

  /**
   * 删除待办。
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

  /**
   * 按 id 取单条待办。
   *
   * @param id 待办 id
   */
  async getTodo(id: string): Promise<Todo | null> {
    return readTodos().find((item) => item.id === id) ?? null;
  },
};
