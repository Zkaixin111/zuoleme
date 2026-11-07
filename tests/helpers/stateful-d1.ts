/// <reference types="@cloudflare/workers-types" />

/**
 * D1 的「有状态」假实现（仅供单元测试使用）。
 *
 * 与同目录 fake-d1.ts（记录型）的分工：
 * - fake-d1.ts：不执行 SQL，只记录语句顺序 —— 用于验证「先删后插」这类**顺序**正确性；
 * - 本文件：按 db.ts 实际发出的 SQL 做最小语义模拟 —— 用于验证**终态**（如
 *   「取消完成后未发提醒是否真的回来了、nextFireAt 是否非空」），这是记录型替身做不到的。
 *
 * 只模拟 worker/src/db.ts 真正用到的语句形态，遇到未模拟的 SQL 直接抛错，
 * 保证新写的 SQL 不会在测试里被静默忽略。
 */

interface FakeTodoRow {
  id: string;
  title: string;
  deadline: number;
  done: number;
  created_at: number;
  updated_at: number;
}

interface FakeReminderRow {
  id: string;
  todo_id: string;
  fire_at: number;
  kind: string;
  sent: number;
  sent_at: number | null;
  attempts: number;
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

class StatefulStatement {
  readonly sql: string;
  readonly params: unknown[];
  private readonly db: StatefulD1;

  constructor(db: StatefulD1, sql: string, params: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params: unknown[]): StatefulStatement {
    return new StatefulStatement(this.db, this.sql, params);
  }

  async all<T>(): Promise<{ results: T[]; success: true }> {
    return { results: this.db.selectAll(this.sql, this.params) as T[], success: true };
  }

  async first<T>(): Promise<T | null> {
    return (this.db.selectOne(this.sql, this.params) ?? null) as T | null;
  }

  async run(): Promise<{ success: true }> {
    this.db.execute(this.sql, this.params);
    return { success: true };
  }
}

/** 有状态的 D1 替身：内存里维护 todos / reminders 两张表 */
export class StatefulD1 {
  todos: FakeTodoRow[] = [];
  reminders: FakeReminderRow[] = [];

  prepare(sql: string): StatefulStatement {
    return new StatefulStatement(this, normalize(sql));
  }

  /** D1 的 batch 是单个事务内顺序执行 */
  async batch(statements: StatefulStatement[]): Promise<Array<{ success: true }>> {
    const results: Array<{ success: true }> = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results;
  }

  execute(rawSql: string, params: unknown[]): void {
    const sql = normalize(rawSql);

    if (sql.startsWith('INSERT INTO todos')) {
      const [id, title, deadline, createdAt, updatedAt] = params as [string, string, number, number, number];
      this.todos.push({ id, title, deadline, done: 0, created_at: createdAt, updated_at: updatedAt });
      return;
    }

    if (sql.startsWith('INSERT INTO reminders')) {
      const [id, todoId, fireAt, kind] = params as [string, string, number, string];
      this.reminders.push({ id, todo_id: todoId, fire_at: fireAt, kind, sent: 0, sent_at: null, attempts: 0 });
      return;
    }

    if (sql === 'DELETE FROM reminders WHERE todo_id = ? AND sent = 0') {
      const todoId = params[0] as string;
      this.reminders = this.reminders.filter((row) => !(row.todo_id === todoId && row.sent === 0));
      return;
    }

    if (sql === 'DELETE FROM reminders WHERE todo_id = ?') {
      const todoId = params[0] as string;
      this.reminders = this.reminders.filter((row) => row.todo_id !== todoId);
      return;
    }

    if (sql === 'DELETE FROM todos WHERE id = ?') {
      const id = params[0] as string;
      this.todos = this.todos.filter((row) => row.id !== id);
      return;
    }

    if (sql.startsWith('UPDATE todos SET done = ?')) {
      const [done, updatedAt, id] = params as [number, number, string];
      const todo = this.todos.find((row) => row.id === id);
      if (todo) {
        todo.done = done;
        todo.updated_at = updatedAt;
      }
      return;
    }

    if (sql.startsWith('UPDATE reminders SET sent = 1, sent_at = ?, attempts = attempts + 1')) {
      const [sentAt, id] = params as [number, string];
      const reminder = this.reminders.find((row) => row.id === id);
      if (reminder) {
        reminder.sent = 1;
        reminder.sent_at = sentAt;
        reminder.attempts += 1;
      }
      return;
    }

    if (sql.startsWith('UPDATE reminders SET attempts = attempts + 1')) {
      const id = params[0] as string;
      const reminder = this.reminders.find((row) => row.id === id);
      if (reminder) {
        reminder.attempts += 1;
      }
      return;
    }

    throw new Error(`StatefulD1 未模拟的 SQL：${sql}`);
  }

  selectOne(rawSql: string, params: unknown[]): unknown {
    const sql = normalize(rawSql);
    if (sql.includes('FROM todos t')) {
      const id = params[0] as string;
      const todo = this.todos.find((row) => row.id === id);
      if (!todo) {
        return null;
      }
      const pending = this.reminders.filter((row) => row.todo_id === id && row.sent === 0);
      const nextFireAt = pending.length === 0 ? null : Math.min(...pending.map((row) => row.fire_at));
      return { ...todo, next_fire_at: nextFireAt };
    }
    throw new Error(`StatefulD1 未模拟的 SELECT(first)：${sql}`);
  }

  selectAll(rawSql: string, params: unknown[]): unknown[] {
    const sql = normalize(rawSql);
    if (sql.includes('FROM reminders r') && sql.includes('JOIN todos t')) {
      const now = params[0] as number;
      return this.reminders
        .filter((row) => row.sent === 0 && row.fire_at <= now)
        .map((row) => {
          const todo = this.todos.find((item) => item.id === row.todo_id);
          if (!todo || todo.done !== 0) {
            return null;
          }
          return {
            id: row.id,
            todo_id: row.todo_id,
            fire_at: row.fire_at,
            kind: row.kind,
            attempts: row.attempts,
            title: todo.title,
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null)
        .sort((a, b) => a.fire_at - b.fire_at);
    }
    throw new Error(`StatefulD1 未模拟的 SELECT(all)：${sql}`);
  }
}

/** 把替身当 D1Database 传入（只依赖 db.ts 实际用到的子集） */
export function asDb(fake: StatefulD1): D1Database {
  return fake as unknown as D1Database;
}
