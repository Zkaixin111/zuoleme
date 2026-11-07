/**
 * D1 的「记录型」假实现（仅供单元测试使用）。
 *
 * 它不解析、不执行 SQL，只做两件事：
 * 1. 按调用顺序原样记录每条 SQL 与绑定参数 —— 用于验证「语句种类 / 顺序 / 数量」；
 * 2. 按 SQL 里的表名返回测试注入的行 —— 让上层逻辑能拿到预期的查询结果。
 *
 * 为什么不引真的 SQL 引擎：本项目的关键正确性是「先删后插」的**语句顺序**，
 * 用真引擎反而看不出顺序问题（跑两遍结果一样）。
 */

/** 一行查询结果 */
type Row = Record<string, unknown>;

/** 各查询的注入结果 */
export interface FakeD1Rows {
  /** `FROM reminders r`（dueReminders）的返回行 */
  dueReminders?: Row[];
  /** `FROM subs`（listSubs）的返回行 */
  subs?: Row[];
  /** `FROM todos t`（listTodos / findTodo）的返回行 */
  todos?: Row[];
}

/** 一条被记录下来的 SQL */
export interface RecordedStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** 预处理语句假实现：bind 之后仍然可被 batch 消费 */
class FakePreparedStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
  private readonly owner: FakeD1;

  constructor(owner: FakeD1, sql: string, params: readonly unknown[]) {
    this.owner = owner;
    this.sql = sql;
    this.params = params;
  }

  bind(...params: unknown[]): FakePreparedStatement {
    return new FakePreparedStatement(this.owner, this.sql, params);
  }

  async all<T>(): Promise<{ results: T[]; success: true }> {
    this.owner.record({ sql: this.sql, params: this.params });
    return { results: this.owner.rowsFor(this.sql) as T[], success: true };
  }

  async first<T>(): Promise<T | null> {
    this.owner.record({ sql: this.sql, params: this.params });
    const rows = this.owner.rowsFor(this.sql) as T[];
    return rows.length > 0 ? rows[0] : null;
  }

  async run(): Promise<{ success: true }> {
    this.owner.record({ sql: this.sql, params: this.params });
    return { success: true };
  }
}

/** 记录型 D1 替身 */
export class FakeD1 {
  /** 按调用顺序累积的 SQL 日志 */
  readonly log: RecordedStatement[] = [];
  private readonly rows: FakeD1Rows;

  constructor(rows: FakeD1Rows = {}) {
    this.rows = rows;
  }

  prepare(sql: string): FakePreparedStatement {
    return new FakePreparedStatement(this, sql, []);
  }

  /** D1 的 batch 在单个事务内按数组顺序执行，这里如实按顺序记录 */
  async batch(statements: FakePreparedStatement[]): Promise<{ success: true }[]> {
    return statements.map((statement) => {
      this.record({ sql: statement.sql, params: statement.params });
      return { success: true };
    });
  }

  /** 记录一条 SQL */
  record(statement: RecordedStatement): void {
    this.log.push(statement);
  }

  /** 按表名把注入结果返回给对应查询 */
  rowsFor(sql: string): Row[] {
    // 注意匹配顺序：findTodo 的子查询里也出现 `FROM reminders r`，
    // dueReminders 则是 `FROM reminders r JOIN todos t`，必须先按最具体的形态判定。
    if (/FROM reminders r\s+JOIN todos t\b/.test(sql)) {
      return this.rows.dueReminders ?? [];
    }
    if (/FROM subs\b/.test(sql)) {
      return this.rows.subs ?? [];
    }
    if (/FROM todos t\b/.test(sql)) {
      return this.rows.todos ?? [];
    }
    return [];
  }

  /** 日志里所有匹配该正则的语句（保序） */
  matching(pattern: RegExp): RecordedStatement[] {
    return this.log.filter((statement) => pattern.test(statement.sql));
  }

  /** 该正则首次出现的下标；没有则 -1 */
  indexOfFirst(pattern: RegExp): number {
    return this.log.findIndex((statement) => pattern.test(statement.sql));
  }
}
