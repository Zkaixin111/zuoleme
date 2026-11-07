import type { ReminderKind, SubRow, TodoRow } from '../../shared/types';
import { planReminders } from '../../shared/reminders';

/**
 * D1 访问层：只做 SQL，不做业务判断（业务在 api.ts / cron.ts）。
 * 所有时间参数均为毫秒时间戳。
 */

/** 到期提醒 + 所属待办标题（Cron 用） */
export interface DueReminderRow {
  id: string;
  todo_id: string;
  fire_at: number;
  kind: ReminderKind;
  /** 已尝试推送次数（失败重试计数） */
  attempts: number;
  title: string;
}

/**
 * 生成「清空某待办未发送提醒 + 按截止时间重建」的语句序列。
 * 新建、改截止时间、取消完成三处共用同一套规则，避免规则分叉。
 *
 * @param db D1 绑定
 * @param todoId 待办 id
 * @param deadline 截止时间（毫秒）
 * @param now 当前时间（毫秒）
 */
function pendingReminderStatements(
  db: D1Database,
  todoId: string,
  deadline: number,
  now: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM reminders WHERE todo_id = ? AND sent = 0').bind(todoId),
  ];
  for (const plan of planReminders(deadline, now)) {
    statements.push(
      db
        .prepare('INSERT INTO reminders (id, todo_id, fire_at, kind, sent, sent_at) VALUES (?, ?, ?, ?, 0, NULL)')
        .bind(newId(), todoId, plan.fireAt, plan.kind),
    );
  }
  return statements;
}

/** 生成随机 id（Workers 原生支持 crypto.randomUUID） */
export function newId(): string {
  return crypto.randomUUID();
}

/**
 * 查询全部待办：未完成在前，按截止时间升序，并带出最近一条待发提醒时间。
 */
export async function listTodos(db: D1Database): Promise<TodoRow[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.title, t.deadline, t.done, t.created_at, t.updated_at,
              (SELECT MIN(r.fire_at) FROM reminders r WHERE r.todo_id = t.id AND r.sent = 0) AS next_fire_at
         FROM todos t
        ORDER BY t.done ASC, t.deadline ASC, t.created_at ASC`,
    )
    .all<TodoRow>();
  return results ?? [];
}

/**
 * 按 id 查询单条待办（带 next_fire_at）。
 */
export async function findTodo(db: D1Database, id: string): Promise<TodoRow | null> {
  return await db
    .prepare(
      `SELECT t.id, t.title, t.deadline, t.done, t.created_at, t.updated_at,
              (SELECT MIN(r.fire_at) FROM reminders r WHERE r.todo_id = t.id AND r.sent = 0) AS next_fire_at
         FROM todos t
        WHERE t.id = ?`,
    )
    .bind(id)
    .first<TodoRow>();
}

/**
 * 新建待办，并按「只生成未来档位」规则批量写入提醒。
 *
 * @returns 新待办 id
 */
export async function insertTodo(
  db: D1Database,
  input: { title: string; deadline: number; now: number },
): Promise<string> {
  const id = newId();
  const statements: D1PreparedStatement[] = [
    db
      .prepare('INSERT INTO todos (id, title, deadline, done, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
      .bind(id, input.title, input.deadline, input.now, input.now),
  ];

  for (const plan of planReminders(input.deadline, input.now)) {
    statements.push(
      db
        .prepare('INSERT INTO reminders (id, todo_id, fire_at, kind, sent, sent_at) VALUES (?, ?, ?, ?, 0, NULL)')
        .bind(newId(), id, plan.fireAt, plan.kind),
    );
  }

  await db.batch(statements);
  return id;
}

/**
 * 更新标题 / 截止时间。截止时间变化时先删掉未发提醒再按新截止时间重建
 * （已发送的提醒保留，作为历史）。
 */
export async function updateTodoFields(
  db: D1Database,
  id: string,
  patch: { title?: string; deadline?: number },
  now: number,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];

  if (patch.title !== undefined && patch.deadline !== undefined) {
    statements.push(
      db
        .prepare('UPDATE todos SET title = ?, deadline = ?, updated_at = ? WHERE id = ?')
        .bind(patch.title, patch.deadline, now, id),
    );
  } else if (patch.title !== undefined) {
    statements.push(db.prepare('UPDATE todos SET title = ?, updated_at = ? WHERE id = ?').bind(patch.title, now, id));
  } else if (patch.deadline !== undefined) {
    statements.push(
      db.prepare('UPDATE todos SET deadline = ?, updated_at = ? WHERE id = ?').bind(patch.deadline, now, id),
    );
  } else {
    return;
  }

  if (patch.deadline !== undefined) {
    statements.push(...pendingReminderStatements(db, id, patch.deadline, now));
  }

  await db.batch(statements);
}

/**
 * 标记完成/取消完成。
 *
 * - 标记完成：删除未发送的提醒（已发送的保留作历史）
 * - 取消完成：按当前截止时间**重建**未发送的提醒，否则误触一次「完成」就永久不再提醒
 *   （误触路径有两条：列表勾选、通知上的「完成」按钮）
 */
export async function setTodoDone(db: D1Database, id: string, done: boolean, now: number): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db.prepare('UPDATE todos SET done = ?, updated_at = ? WHERE id = ?').bind(done ? 1 : 0, now, id),
  ];

  if (done) {
    statements.push(db.prepare('DELETE FROM reminders WHERE todo_id = ? AND sent = 0').bind(id));
  } else {
    const existing = await findTodo(db, id);
    if (existing) {
      statements.push(...pendingReminderStatements(db, id, existing.deadline, now));
    }
  }

  await db.batch(statements);
}

/**
 * 删除待办并级联删除其全部提醒。
 *
 * @returns 是否删除了记录
 */
export async function deleteTodoCascade(db: D1Database, id: string): Promise<boolean> {
  const existing = await findTodo(db, id);
  if (!existing) {
    return false;
  }
  await db.batch([
    db.prepare('DELETE FROM reminders WHERE todo_id = ?').bind(id),
    db.prepare('DELETE FROM todos WHERE id = ?').bind(id),
  ]);
  return true;
}

/**
 * 扫描到期且未发送的提醒（只取未完成待办的）。
 */
export async function dueReminders(db: D1Database, now: number): Promise<DueReminderRow[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.todo_id, r.fire_at, r.kind, r.attempts, t.title
         FROM reminders r
         JOIN todos t ON t.id = r.todo_id
        WHERE r.sent = 0 AND r.fire_at <= ? AND t.done = 0
        ORDER BY r.fire_at ASC`,
    )
    .bind(now)
    .all<DueReminderRow>();
  return results ?? [];
}

/**
 * 把提醒标记为已发送（或放弃）：sent=1 并累加 attempts。
 * attempts 记录总尝试次数，便于事后排错（give_up 时能看出试了多少次）。
 */
export async function markReminderSent(db: D1Database, reminderId: string, now: number): Promise<void> {
  await db
    .prepare('UPDATE reminders SET sent = 1, sent_at = ?, attempts = attempts + 1 WHERE id = ?')
    .bind(now, reminderId)
    .run();
}

/**
 * 保留待重试：仅累加 attempts，不动 sent。
 */
export async function incrementReminderAttempts(db: D1Database, reminderId: string): Promise<void> {
  await db.prepare('UPDATE reminders SET attempts = attempts + 1 WHERE id = ?').bind(reminderId).run();
}

/** 查询全部订阅 */
export async function listSubs(db: D1Database): Promise<SubRow[]> {
  const { results } = await db
    .prepare('SELECT id, endpoint, p256dh, auth, created_at FROM subs ORDER BY created_at ASC')
    .all<SubRow>();
  return results ?? [];
}

/**
 * 插入或更新订阅（同一 endpoint 视为同一设备）。
 *
 * @returns 订阅 id
 */
export async function upsertSub(
  db: D1Database,
  sub: { endpoint: string; p256dh: string; auth: string },
  now: number,
): Promise<string> {
  const id = newId();
  await db
    .prepare(
      `INSERT INTO subs (id, endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
    )
    .bind(id, sub.endpoint, sub.p256dh, sub.auth, now)
    .run();
  return id;
}

/** 按 endpoint 删除订阅 */
export async function deleteSubByEndpoint(db: D1Database, endpoint: string): Promise<void> {
  await db.prepare('DELETE FROM subs WHERE endpoint = ?').bind(endpoint).run();
}

/** 按 id 删除订阅（推送返回 404/410 时清理失效订阅） */
export async function deleteSubById(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM subs WHERE id = ?').bind(id).run();
}
