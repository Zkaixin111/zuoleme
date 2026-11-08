/**
 * 共享类型定义：前端 / Service Worker /（保留的）Worker 都从这里取类型。
 *
 * 数据模型只有一处真相：
 * - `title` 是「做什么」（必填，列表与通知里显示的就是它）；
 * - `content` 是「具体内容」（可空，只在详情页显示，**绝不进通知**）；
 * - `deadline` 是「当前这一次」的截止时间，**可以是 null**（用户主动选择「不设时间」）；
 * - `advanceReminder` 决定要不要提前分档提醒，关掉后就只在到点那一刻提醒一次；
 * - `repeat` 描述这件事多久来一次。
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
  /**
   * 「当前这一次」的截止时间，毫秒时间戳；**null = 用户主动选择「不设时间」**。
   * 不设时间的待办不产生任何提醒，也不参与排序里的时间比较。
   */
  deadline: number | null;
  /**
   * 是否启用提前档位，默认 true。
   * false = 只在到点那一刻提醒一次（不问「提前 7 天」这些档位）。
   * 没有截止时间时该字段无意义，写入侧会被归位成 true。
   */
  advanceReminder: boolean;
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
  /** null / 省略 = 不设截止时间 */
  deadline?: number | null;
  /** 省略 = 默认 true（提前提醒） */
  advanceReminder?: boolean;
  repeat?: RepeatRule;
}

/** PATCH /api/todos/:id 请求体 */
export interface UpdateTodoBody {
  title?: string;
  content?: string;
  /** 传 null = 清除截止时间（同时会强制把 repeat 归零） */
  deadline?: number | null;
  advanceReminder?: boolean;
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
