/**
 * 共享类型定义：前后端（前端 / Service Worker / Worker）都从这里取类型，
 * 保证接口契约只有一处真相。
 */

/** 六档提醒类型 */
export type ReminderKind = '7d' | '3d' | '1d' | '3h' | '1h' | 'due';

/** 提醒计划项（纯逻辑输出） */
export interface ReminderPlanItem {
  kind: ReminderKind;
  /** 毫秒时间戳 */
  fireAt: number;
}

/**
 * 待办实体（前端本地 APK 版本的唯一数据模型）。
 *
 * 刻意保持最小：没有分类、优先级、备注等字段。
 * 「最近一条待发提醒时间」（nextFireAt）不是持久化字段，
 * 而是每次由 `planReminders(deadline, now)` 现算出来的派生值，
 * 因为本地方案里闹钟的真实排期在 Android AlarmManager 上，不在这里。
 */
export interface Todo {
  id: string;
  title: string;
  /** 截止时间，毫秒时间戳 */
  deadline: number;
  done: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Worker（已停用，仅保留代码）返回的待办：比本地模型多一个计算字段。
 * APK 版本不引用 worker/，保留它只为将来可能做同步。
 */
export interface TodoWithNextFire extends Todo {
  /** 最近一条未发送提醒的时间；无待发提醒时为 null */
  nextFireAt: number | null;
}

/** D1 中 todos 表的原始行 */
export interface TodoRow {
  id: string;
  title: string;
  deadline: number;
  done: number;
  created_at: number;
  updated_at: number;
  next_fire_at?: number | null;
}

/** D1 中 reminders 表的原始行 */
export interface ReminderRow {
  id: string;
  todo_id: string;
  fire_at: number;
  kind: ReminderKind;
  sent: number;
  sent_at: number | null;
}

/** D1 中 subs 表的原始行 */
export interface SubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: number;
}

/** Web Push 推送体（Service Worker 侧解析） */
export interface PushPayload {
  /** 通知标题（= 待办标题） */
  title: string;
  /** 通知正文（= 距离截止时间的说明） */
  body: string;
  todoId: string;
  kind: ReminderKind;
  /** 通知分组标签：todo:<id>:<kind>，保证不同档位/不同事项互不覆盖 */
  tag: string;
}

/** PushSubscription.toJSON() 的结构 */
export interface PushSubscriptionJson {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/** POST /api/todos 请求体 */
export interface CreateTodoBody {
  title: string;
  deadline: number;
}

/** PATCH /api/todos/:id 请求体 */
export interface UpdateTodoBody {
  title?: string;
  deadline?: number;
  done?: boolean;
}

/** 统一错误响应 */
export interface ApiError {
  error: string;
}

/** 页面 ↔ Service Worker 的消息（notificationclick 时告知前端刷新/聚焦） */
export interface SwClientMessage {
  type: 'notification-clicked' | 'todo-completed';
  todoId: string;
  kind?: ReminderKind;
}
