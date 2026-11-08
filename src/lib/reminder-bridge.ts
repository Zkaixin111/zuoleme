import { Capacitor, registerPlugin } from '@capacitor/core';
import type { Todo } from '../../shared/types';
import { compileAlarms, type ReminderAlarm } from './alarms';

/**
 * 原生闹钟桥接层。
 *
 * 上层（React）只说「这批待办应该有哪些闹钟」，本层负责：
 * 1. 用 `compileAlarms` 把待办编译成扁平闹钟列表；
 * 2. 调用自研的 `ReminderAlarm` 原生插件（AlarmManager + 通知）；
 * 3. 只有在原生环境（APK）里才真正做事 —— 在浏览器 / vitest 里所有调用都是安全的空操作。
 *
 * 为什么不用 `@capacitor/local-notifications`：
 * 它在设备重启后不会重建闹钟，而「重启后照常提醒」是硬需求。
 */

/** 原生侧 `getPermissionState()` 的返回结构 */
export interface NativePermissionState {
  /** 是否已授予通知权限（Android 13+ 为运行时权限） */
  notifications: boolean;
  /** 是否允许精确闹钟（Android 12+ 需要用户手动开启） */
  exactAlarm: boolean;
  /** 是否被系统电池优化限制（true = 被限制，不理想） */
  batteryOptimized: boolean;
}

/** 界面用：在原生状态外补一个「当前环境是否支持」 */
export interface PermissionSnapshot extends NativePermissionState {
  /** false 表示不是 APK 环境（浏览器），系统闹钟不可用 */
  supported: boolean;
}

/** 传给原生插件的闹钟结构（字段与 Kotlin 侧 AlarmRecord 一一对应） */
export interface NativeAlarm {
  id: number;
  title: string;
  body: string;
  fireAt: number;
}

/** 自研原生插件的方法签名 */
interface ReminderAlarmPlugin {
  /** 全量替换：存盘 + 取消旧闹钟 + 逐条 setExactAndAllowWhileIdle */
  scheduleAll(options: { alarms: NativeAlarm[] }): Promise<void>;
  /** 取消全部闹钟并清空持久化记录 */
  cancelAll(): Promise<void>;
  /** 读取三项系统授权状态 */
  getPermissionState(): Promise<NativePermissionState>;
  /** Android 13+ 请求通知权限 */
  requestNotificationPermission(): Promise<{ notifications: boolean }>;
  /** 跳转「精确闹钟」系统设置页 */
  openExactAlarmSettings(): Promise<void>;
  /** 跳转「电池优化」系统设置页 */
  openBatterySettings(): Promise<void>;
}

/** 插件代理对象；在 Web 上调用会抛「未实现」，因此所有调用都先判平台 */
const ReminderAlarm = registerPlugin<ReminderAlarmPlugin>('ReminderAlarm');

/** 非原生环境的默认状态（浏览器打开网页版时的展示） */
const WEB_PERMISSION_STATE: PermissionSnapshot = {
  supported: false,
  notifications: false,
  exactAlarm: false,
  batteryOptimized: false,
};

/** 是否运行在原生 App（APK）里 */
export function isNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    // Capacitor 未注入（极老的 WebView）时按浏览器处理
    return false;
  }
}

/** 一次全量排程的结果 */
export interface ScheduleResult {
  ok: boolean;
  /** 本次提交给系统的闹钟条数 */
  scheduled: number;
  /** 失败原因（中文，可直接展示） */
  error: string | null;
}

/**
 * 按当前待办全量重排闹钟。
 *
 * 为什么是全量而不是增量：数据量极小（几十条），全量重排逻辑简单、
 * 不会出现「删除某档后残留旧闹钟」的隐蔽 bug；代价只是几十次 setExact。
 *
 * @param todos 全部待办
 * @param now 当前时间（毫秒时间戳），默认取系统时间
 */
export async function syncAlarms(todos: readonly Todo[], now: number = Date.now()): Promise<ScheduleResult> {
  const alarms = compileAlarms(todos, now);

  if (!isNativePlatform()) {
    // 浏览器里没有 AlarmManager，静默跳过（界面会单独提示「仅 APK 可用」）
    return { ok: true, scheduled: 0, error: null };
  }

  const payload: NativeAlarm[] = alarms.map((alarm: ReminderAlarm) => ({
    id: alarm.id,
    title: alarm.title,
    body: alarm.body,
    fireAt: alarm.fireAt,
  }));

  try {
    await ReminderAlarm.scheduleAll({ alarms: payload });
    return { ok: true, scheduled: payload.length, error: null };
  } catch (error) {
    return {
      ok: false,
      scheduled: 0,
      error: error instanceof Error ? error.message : '设置系统闹钟失败，提醒可能不会响',
    };
  }
}

/**
 * 取消全部闹钟（清空数据时使用）。
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

/** 跳转系统「精确闹钟」授权页 */
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
