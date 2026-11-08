/**
 * 共享类型定义：前端 / Service Worker /（保留的）Worker 都从这里取类型。
 *
 * 数据模型只有一处真相：
 * - `title` 是「做什么」（必填，列表与通知里显示的就是它）；
 * - `content` 是「具体内容」（可空，只在详情页显示，**绝不进通知**）；
 * - `repeat` 描述这件事多久来一次，`deadline` 永远是「当前这一次」的截止时间。
 */

/** 提醒档位 */
export type ReminderKind = '7d' | '3d' | '1d' | '3h' | '1h' | 'due';

/** 提醒计划项（纯逻辑输出） */
export interface ReminderPlanItem {
  kind: ReminderKind;
  /** 毫秒时间戳 */
  fireAt: number;
}

/**
 * 重复规则。
 *
 * 所有分支都以「当前这一次的 deadline」为锚点向后推进，见 `shared/repeat.ts`。
 */
export type RepeatRule =
  | { kind: 'none' }
  | { kind: 'daily' }
  /** 0 = 周日 … 6 = 周六，可多选，非空才算合法 */
  | { kind: 'weekly'; weekdays: number[] }
  /** 1..31；当月没有该日时取当月最后一天 */
  | { kind: 'monthly'; dayOfMonth: number }
  /** 固定间隔；最小 15 分钟、最大 30 天（在写入处校验） */
  | { kind: 'interval'; intervalMs: number };

/** 不重复（常量，避免到处写字面量对象） */
export const NO_REPEAT: RepeatRule = { kind: 'none' };

/** 待办实体（本地 APK 版本的唯一数据模型） */
export interface Todo {
  id: string;
  /** 做什么，必填，<= 100 字 */
  title: string;
  /** 具体内容，可空字符串，<= 2000 字 */
  content: string;
  /** 「当前这一次」的截止时间，毫秒时间戳 */
  deadline: number;
  /** 一次性任务表示完成；重复任务恒为 false（完成 = 推进到下一次） */
  done: boolean;
  /** 重复规则 */
  repeat: RepeatRule;
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
  /** 老表结构没有该列，Worker 侧按空串兜底 */
  content?: string | null;
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

/** Web Push 推送体（Service Worker 侧解析，网页版历史实现保留） */
export interface PushPayload {
  /** 通知标题（= 待办标题） */
  title: string;
  /** 通知正文 */
  body: string;
  todoId: string;
  kind: ReminderKind;
  /** 通知分组标签 */
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
  content?: string;
  deadline: number;
  repeat?: RepeatRule;
}

/** PATCH /api/todos/:id 请求体 */
export interface UpdateTodoBody {
  title?: string;
  content?: string;
  deadline?: number;
  done?: boolean;
  repeat?: RepeatRule;
}

/** 统一错误响应 */
export interface ApiError {
  error: string;
}

/** 页面 ↔ Service Worker 的消息 */
export interface SwClientMessage {
  type: 'notification-clicked' | 'todo-completed';
  todoId: string;
  kind?: ReminderKind;
}
