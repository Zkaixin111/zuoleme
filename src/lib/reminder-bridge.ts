import { Capacitor, registerPlugin } from '@capacitor/core';
import type { Todo } from '../../shared/types';
import { compileAlarmsWithStats } from './alarms';

/**
 * 原生提醒桥接层。
 *
 * 上层（React）只说「这批待办应该有哪些提醒」，本层负责：
 * 1. 用 `compileAlarmsWithStats` 把待办（含重复任务展开）编译成扁平提醒列表；
 * 2. 调用自研的 `ReminderAlarm` 原生插件（AlarmManager + 静音横幅通知）；
 * 3. 只有在原生环境（APK）里才真正做事 —— 浏览器 / vitest 下所有调用都是安全的空操作。
 */

/** 原生侧 `getPermissionState()` 的返回结构 */
export interface NativePermissionState {
  /** 是否已授予通知权限（Android 13+ 为运行时权限） */
  notifications: boolean;
  /** 是否允许精确闹钟（Android 12+ 需要用户手动开启） */
  exactAlarm: boolean;
  /** 是否被系统电池优化限制（true = 被限制，不理想） */
  batteryOptimized: boolean;
  /** 磁盘上有多少条提醒记录解析不出来（正常 0；> 0 说明提醒已经丢了） */
  droppedAlarmCount?: number;
}

/** 界面用：在原生状态外补一个「当前环境是否支持」 */
export interface PermissionSnapshot extends NativePermissionState {
  /** false 表示不是 APK 环境（浏览器），系统提醒不可用 */
  supported: boolean;
  /** 未能恢复的旧提醒条数（正常 0） */
  droppedAlarmCount: number;
}

/**
 * 传给原生插件的提醒结构。
 *
 * 字段与 Kotlin 侧 `AlarmRecord` 必须一一对应：
 * **没有 body** —— 通知正文由原生在触发时刻用 `deadline - 当前时间` 现算，
 * 这样文案永远准确（补发 20 小时前的提醒也不会说「还有 3 小时」）。
 * 也没有 content —— 正文只在详情页看，绝不进通知。
 */
export interface NativeAlarm {
  id: number;
  todoId: string;
  title: string;
  /** 该实例的截止时刻 */
  deadline: number;
  /** 触发时刻 */
  fireAt: number;
}

/** 自研原生插件的方法签名 */
interface ReminderAlarmPlugin {
  /**
   * 全量替换：存盘 + 取消旧提醒 + 逐条 setExactAndAllowWhileIdle。
   *
   * 原生返回 `{ scheduled }` —— 真正排上的条数（已过滤过去时刻、已扣除失败）。
   */
  scheduleAll(options: { alarms: NativeAlarm[] }): Promise<{ scheduled?: number } | void>;
  /** 取消全部提醒并清空持久化记录 */
  cancelAll(): Promise<void>;
  /** 读取三项系统授权状态 */
  getPermissionState(): Promise<NativePermissionState>;
  /** Android 13+ 请求通知权限 */
  requestNotificationPermission(): Promise<{ notifications: boolean }>;
  /** 跳转「准时触发」系统设置页 */
  openExactAlarmSettings(): Promise<void>;
  /** 跳转「电池优化」系统设置页 */
  openBatterySettings(): Promise<void>;
  /** 跳转本应用的通知设置页 */
  openNotificationSettings(): Promise<void>;
  /** 取走并清空「用户点了哪条通知」（用于打开对应详情页） */
  getPendingOpen(): Promise<{ todoId?: string | null }>;
}

/** 插件代理对象；在 Web 上调用会抛「未实现」，因此所有调用都先判平台 */
const ReminderAlarm = registerPlugin<ReminderAlarmPlugin>('ReminderAlarm');

/** 非原生环境的默认状态 */
const WEB_PERMISSION_STATE: PermissionSnapshot = {
  supported: false,
  notifications: false,
  exactAlarm: false,
  batteryOptimized: false,
  droppedAlarmCount: 0,
};

/** 是否运行在原生 App（APK）里 */
export function isNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/** 一次全量排程的结果 */
export interface ScheduleResult {
  ok: boolean;
  /** 真正交给系统的提醒条数 */
  scheduled: number;
  /** 因上限被丢弃的条数（界面可提示「只排了最近 240 条」） */
  truncated: number;
  /** 失败原因（中文，可直接展示） */
  error: string | null;
}

/**
 * 按当前待办全量重排提醒。
 *
 * 为什么是全量而不是增量：数据量极小，全量重排逻辑简单、
 * 不会出现「删除某档后残留旧提醒」的隐蔽 bug。
 *
 * @param todos 全部待办
 * @param now 当前时间（毫秒），默认取系统时间
 */
export async function syncAlarms(todos: readonly Todo[], now: number = Date.now()): Promise<ScheduleResult> {
  const { alarms, truncated } = compileAlarmsWithStats(todos, now);

  if (!isNativePlatform()) {
    return { ok: true, scheduled: 0, truncated: 0, error: null };
  }

  const payload: NativeAlarm[] = alarms.map((alarm) => ({
    id: alarm.id,
    todoId: alarm.todoId,
    title: alarm.title,
    deadline: alarm.deadline,
    fireAt: alarm.fireAt,
  }));

  try {
    const result = await ReminderAlarm.scheduleAll({ alarms: payload });
    const reported = result && typeof result.scheduled === 'number' ? result.scheduled : payload.length;
    return { ok: true, scheduled: reported, truncated, error: null };
  } catch (error) {
    return {
      ok: false,
      scheduled: 0,
      truncated,
      error: error instanceof Error ? error.message : '设置系统提醒失败，提醒可能不会响',
    };
  }
}

/**
 * 取消全部提醒（清空数据时使用）。
 */
export async function cancelAllAlarms(): Promise<void> {
  if (!isNativePlatform()) {
    return;
  }
  try {
    await ReminderAlarm.cancelAll();
  } catch {
    // 取消失败不阻塞主流程：下次 scheduleAll 也会覆盖
  }
}

/**
 * 读取三项系统授权状态。
 */
export async function readPermissionState(): Promise<PermissionSnapshot> {
  if (!isNativePlatform()) {
    return WEB_PERMISSION_STATE;
  }
  try {
    const state = await ReminderAlarm.getPermissionState();
    return {
      supported: true,
      notifications: state.notifications === true,
      exactAlarm: state.exactAlarm === true,
      batteryOptimized: state.batteryOptimized === true,
      droppedAlarmCount:
        typeof state.droppedAlarmCount === 'number' && Number.isFinite(state.droppedAlarmCount)
          ? state.droppedAlarmCount
          : 0,
    };
  } catch {
    return { ...WEB_PERMISSION_STATE };
  }
}

/**
 * 请求通知权限（Android 13+ 会弹系统授权框；低版本直接返回 true）。
 *
 * @returns 请求后是否已授予
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!isNativePlatform()) {
    return false;
  }
  try {
    const result = await ReminderAlarm.requestNotificationPermission();
    return result.notifications === true;
  } catch {
    return false;
  }
}

/** 跳转系统「准时触发」授权页 */
export async function openExactAlarmSettings(): Promise<void> {
  if (!isNativePlatform()) {
    return;
  }
  try {
    await ReminderAlarm.openExactAlarmSettings();
  } catch {
    // 部分 ROM 没有该页面，忽略
  }
}

/** 跳转系统「电池优化」设置页 */
export async function openBatterySettings(): Promise<void> {
  if (!isNativePlatform()) {
    return;
  }
  try {
    await ReminderAlarm.openBatterySettings();
  } catch {
    // 忽略
  }
}

/**
 * 跳转本应用的通知设置页。
 *
 * 用户在授权框里点「不允许」后系统不再弹框，只能引导他去手动打开。
 */
export async function openNotificationSettings(): Promise<void> {
  if (!isNativePlatform()) {
    return;
  }
  try {
    await ReminderAlarm.openNotificationSettings();
  } catch {
    // 部分 ROM 没有该页面，忽略
  }
}

/**
 * 取走「用户点了哪条通知」。
 *
 * 原生侧读一次就清空，所以不会重复跳转。
 *
 * @returns 待办 id；没有待处理的点击时返回 null
 */
export async function consumePendingOpen(): Promise<string | null> {
  if (!isNativePlatform()) {
    return null;
  }
  try {
    const result = await ReminderAlarm.getPendingOpen();
    const todoId = typeof result.todoId === 'string' ? result.todoId : null;
    return todoId !== null && todoId.length > 0 ? todoId : null;
  } catch {
    return null;
  }
}
