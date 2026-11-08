import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatRemaining } from '../shared/format';
import {
  REMINDER_GIVE_UP_MS,
  REMINDER_MAX_ATTEMPTS,
  planReminders,
} from '../shared/reminders';
import type { Todo } from '../shared/types';
import { NO_REPEAT } from '../shared/types';
import { compileAlarms } from '../src/lib/alarms';

/**
 * QA 独立复验：JS ↔ Kotlin 契约、通知内容隔离、剩余时间文案一致性、以及老功能回归。
 *
 * 这些代码之间没有任何编译期校验，字段拼错 / 少传一个字段 / 通知里混进正文，
 * 都能编译通过、装上、跑起来，只是「不响」或「把用户正文推给锁屏」。
 * 所以这里直接对源码做静态断言（只锁协议，不锁实现细节）。
 */

const ROOT = new URL('../', import.meta.url);

/**
 * 读取仓库内源码。
 *
 * @param relative 相对仓库根目录的路径
 */
function readSource(relative: string): string {
  return readFileSync(new URL(relative, ROOT), 'utf8');
}

const KOTLIN_DIR = 'android/app/src/main/java/com/zkaixin/zuoleme/';
const STORE = readSource(`${KOTLIN_DIR}ReminderStore.kt`);
const NOTIFIER = readSource(`${KOTLIN_DIR}ReminderNotifier.kt`);
const RECEIVER = readSource(`${KOTLIN_DIR}AlarmReceiver.kt`);
const PLUGIN = readSource(`${KOTLIN_DIR}ReminderAlarmPlugin.kt`);
const BOOT = readSource(`${KOTLIN_DIR}BootReceiver.kt`);
const MANIFEST = readSource('android/app/src/main/AndroidManifest.xml');
const BRIDGE = readSource('src/lib/reminder-bridge.ts');
const ALARMS = readSource('src/lib/alarms.ts');

/**
 * 提取 Kotlin `data class X(...)` 的「字段名 → 类型」。
 *
 * @param source 源文本
 * @param name 类名
 */
function kotlinDataClassFields(source: string, name: string): Array<[string, string]> {
  const body = new RegExp(`data class ${name}\\(([\\s\\S]*?)\\n\\)`).exec(source);
  if (body === null) {
    return [];
  }
  const fields: Array<[string, string]> = [];
  for (const match of body[1].matchAll(/val\s+(\w+)\s*:\s*([A-Za-z<>?]+)/g)) {
    fields.push([match[1], match[2].trim()]);
  }
  return fields;
}

/**
 * 提取 TS `export interface X { ... }` 的「字段名 → 类型」。
 *
 * @param source 源文本
 * @param name 接口名
 */
function tsInterfaceFields(source: string, name: string): Array<[string, string]> {
  const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source);
  if (body === null) {
    return [];
  }
  const fields: Array<[string, string]> = [];
  for (const match of body[1].matchAll(/^\s*(\w+)\??:\s*([^;]+);/gm)) {
    fields.push([match[1], match[2].trim()]);
  }
  return fields;
}

/**
 * 提取一个 Kotlin 函数的函数体（按花括号配平）。
 *
 * @param source 源文本
 * @param signature 函数签名（正则片段）
 */
function kotlinFunctionBody(source: string, signature: RegExp): string {
  const start = source.search(signature);
  if (start < 0) {
    return '';
  }
  const open = source.indexOf('{', start);
  if (open < 0) {
    return '';
  }
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open, index + 1);
      }
    }
  }
  return '';
}

describe('F. 通知绝不会露出用户正文（content）', () => {
  it('Kotlin 侧任何文件里都没有以 content 为键的取值/落盘/传参', () => {
    for (const [label, source] of [
      ['ReminderStore.kt', STORE],
      ['ReminderAlarmPlugin.kt', PLUGIN],
      ['ReminderNotifier.kt', NOTIFIER],
      ['AlarmReceiver.kt', RECEIVER],
    ] as const) {
      expect(source.includes('"content"'), `${label} 出现了 content 字段`).toBe(false);
      expect(source.includes('EXTRA_CONTENT'), `${label} 出现了 EXTRA_CONTENT`).toBe(false);
    }
  });

  it('通知正文是触发时刻现算的剩余时间，不是任何用户输入', () => {
    const body = kotlinFunctionBody(RECEIVER, /override fun onReceive/);
    expect(body).toContain('deadline - System.currentTimeMillis()');
    expect(body).toContain('ReminderNotifier.remainingText(remaining)');
    // 通知里用的 body 只可能来自上面这一处
    expect(RECEIVER).not.toMatch(/EXTRA_BODY/);
  });

  it('notifyReminder 的入参只有 alarmId / todoId / title / body，ContentText 用的是 body', () => {
    const signature = /fun notifyReminder\(([\s\S]*?)\)\s*\{/.exec(NOTIFIER);
    expect(signature).not.toBeNull();
    const params = (signature as RegExpExecArray)[1];
    expect(params).toContain('title: String');
    expect(params).toContain('body: String');
    expect(params).not.toContain('content');

    const body = kotlinFunctionBody(NOTIFIER, /fun notifyReminder\(/);
    expect(body).toContain('.setContentTitle(title)');
    expect(body).toContain('.setContentText(body)');
    expect(body).not.toMatch(/\.setStyle\(|BigTextStyle/);
  });

  it('前端传给原生的 NativeAlarm 载荷里没有 content / body', () => {
    const mapping = /const payload: NativeAlarm\[\] = alarms\.map\([\s\S]*?\}\)\);/.exec(BRIDGE);
    expect(mapping).not.toBeNull();
    const block = (mapping as RegExpExecArray)[0];

    expect(block).not.toContain('content');
    expect(block).not.toContain('body');
    for (const field of ['id', 'todoId', 'title', 'deadline', 'fireAt']) {
      expect(block).toContain(field);
    }
  });

  it('产品要求「弹出但不出声」：渠道 HIGH 重要性 + 静音 + 无震动 + 锁屏可见 + 旧渠道删除', () => {
    expect(NOTIFIER).toContain('CHANNEL_ID = "reminders_v3"');
    expect(NOTIFIER).toContain('LEGACY_CHANNEL_IDS = listOf("reminders")');
    expect(NOTIFIER).toContain('NotificationManager.IMPORTANCE_HIGH');
    expect(NOTIFIER).toContain('setSound(null, null)');
    expect(NOTIFIER).toContain('enableVibration(false)');
    expect(NOTIFIER).toContain('vibrationPattern = null');
    expect(NOTIFIER).toContain('lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC');
    expect(NOTIFIER).toContain('deleteNotificationChannel(legacyId)');

    const notifyBody = kotlinFunctionBody(NOTIFIER, /fun notifyReminder\(/);
    expect(notifyBody).toContain('.setSilent(true)');
    expect(notifyBody).toContain('PRIORITY_HIGH');
    expect(notifyBody).toContain('VISIBILITY_PUBLIC');
    expect(notifyBody).toContain('CATEGORY_REMINDER');
    expect(notifyBody).not.toContain('.setVibrate(');
    expect(notifyBody).not.toContain('.setSound(');
  });
});

describe('H. 三处 ReminderAlarm 字段必须一一对应', () => {
  it('Kotlin AlarmRecord = 前端 NativeAlarm（字段名与类型都对得上）', () => {
    const kotlin = kotlinDataClassFields(STORE, 'AlarmRecord');
    const native = tsInterfaceFields(BRIDGE, 'NativeAlarm');

    expect(kotlin.map(([name]) => name)).toEqual(['id', 'todoId', 'title', 'deadline', 'fireAt']);
    expect(native.map(([name]) => name)).toEqual(kotlin.map(([name]) => name));

    const typeMap: Record<string, string[]> = {
      Int: ['number'],
      Long: ['number'],
      String: ['string'],
    };
    for (const [name, kotlinType] of kotlin) {
      const tsType = native.find(([field]) => field === name)?.[1];
      expect(tsType, `字段 ${name} 在 NativeAlarm 里缺失`).toBeTruthy();
      expect(typeMap[kotlinType], `Kotlin 字段 ${name} 的类型 ${kotlinType} 没有映射`).toContain(tsType);
    }
  });

  it('ReminderAlarm 只比 NativeAlarm 多一个 kind（前端内部使用，不进原生）', () => {
    const alarmFields = tsInterfaceFields(ALARMS, 'ReminderAlarm').map(([name]) => name);
    const nativeFields = tsInterfaceFields(BRIDGE, 'NativeAlarm').map(([name]) => name);

    expect(alarmFields).toEqual(['id', 'todoId', 'kind', 'title', 'deadline', 'fireAt']);
    expect(alarmFields.filter((name) => !nativeFields.includes(name))).toEqual(['kind']);
    expect(nativeFields.filter((name) => !alarmFields.includes(name))).toEqual([]);
  });

  it('插件读取的键 = 落盘写入的键 = 约定的五个字段（少一个就是重启后静默丢字段）', () => {
    const readKeys = new Set<string>();
    for (const match of PLUGIN.matchAll(/item\.opt(?:Int|Long|String)\("(\w+)"/g)) {
      readKeys.add(match[1]);
    }
    const saveKeys = new Set<string>();
    for (const match of STORE.matchAll(/item\.put\("(\w+)"/g)) {
      saveKeys.add(match[1]);
    }
    const loadKeys = new Set<string>();
    for (const match of STORE.matchAll(/item\.opt(?:Int|Long|String)\("(\w+)"/g)) {
      loadKeys.add(match[1]);
    }

    expect([...readKeys].sort()).toEqual(['deadline', 'fireAt', 'id', 'title', 'todoId']);
    expect([...saveKeys].sort()).toEqual([...readKeys].sort());
    expect([...loadKeys].sort()).toEqual([...readKeys].sort());
  });

  it('PendingIntent 的 extra 与接收端读取的 extra 完全一致（少一个 = 通知里标题变默认值）', () => {
    const put = new Set<string>();
    for (const match of STORE.matchAll(/putExtra\(EXTRA_(\w+),/g)) {
      put.add(match[1]);
    }
    const got = new Set<string>();
    for (const match of RECEIVER.matchAll(/get(?:Int|Long|String)Extra\(ReminderStore\.EXTRA_(\w+)/g)) {
      got.add(match[1]);
    }
    expect([...put].sort()).toEqual(['DEADLINE', 'ID', 'TITLE', 'TODO_ID']);
    expect([...got].sort()).toEqual([...put].sort());
  });
});

describe('F2. 原生存储版本不匹配的后果（升级窗口风险）', () => {
  it('load 在版本不匹配时直接返回空列表（旧记录整体丢弃）', () => {
    const body = kotlinFunctionBody(STORE, /fun load\(/);
    expect(body).toContain('version != FORMAT_VERSION');
    expect(body).toContain('return emptyList()');
    // 丢弃发生在读取 KEY_ALARMS 之前，说明不会尝试解析旧格式
    const versionCheckAt = body.indexOf('return emptyList()');
    const readAt = body.indexOf('getString(KEY_ALARMS');
    expect(versionCheckAt).toBeLessThan(readAt);
  });

  it('scheduleAll 的取消依据是 load() 的结果：版本不匹配时一条都不会被取消（也不会被重建）', () => {
    const body = kotlinFunctionBody(STORE, /fun scheduleAll\(/);
    expect(body).toContain('val previous = load(context)');
    expect(body).toContain('cancelPendingIntents(context, alarmManager, previous)');
  });

  it('升级后闹钟能重建的前提是「动过手」：MY_PACKAGE_REPLACED 已注册在 BootReceiver', () => {
    expect(MANIFEST).toContain('android.intent.action.MY_PACKAGE_REPLACED');
    expect(BOOT).toContain('Intent.ACTION_MY_PACKAGE_REPLACED');
    expect(BOOT).toContain('ReminderStore.load(context)');
    expect(BOOT).toContain('ReminderStore.scheduleAll(context, alarms)');
  });
});

describe('G. 剩余时间文案：TS 与 Kotlin 两端是否一致', () => {
  /**
   * Kotlin `ReminderNotifier.durationText` 的逐行移植（用于对账，不是被测代码）。
   *
   * @param remainingMs 剩余毫秒
   */
  function kotlinDurationText(remainingMs: number): string {
    const totalMinutes = Math.trunc(remainingMs / 60_000);
    if (totalMinutes < 1) {
      return '不到1分钟';
    }
    const days = Math.trunc(totalMinutes / (86_400_000 / 60_000));
    const minutesAfterDays = totalMinutes % (86_400_000 / 60_000);
    const hours = Math.trunc(minutesAfterDays / (3_600_000 / 60_000));
    const minutes = minutesAfterDays % (3_600_000 / 60_000);
    if (days > 0 && hours > 0) {
      return `${days}天${hours}小时`;
    }
    if (days > 0) {
      return `${days}天`;
    }
    if (hours > 0 && minutes > 0) {
      return `${hours}小时${minutes}分钟`;
    }
    if (hours > 0) {
      return `${hours}小时`;
    }
    return `${minutes}分钟`;
  }

  /**
   * Kotlin `ReminderNotifier.remainingText` 的逐行移植。
   *
   * @param remainingMs 剩余毫秒
   */
  function kotlinRemainingText(remainingMs: number): string {
    if (remainingMs > 0) {
      return `还有${kotlinDurationText(remainingMs)}截止`;
    }
    const overdue = -remainingMs;
    return overdue >= 60_000 ? `已逾期${kotlinDurationText(overdue)}` : '已到截止时间';
  }

  it('正数区间（用户最常看到的）两端逐值一致', () => {
    const samples = [
      1,
      59_999,
      60_000,
      60_001,
      90_000,
      3_599_999,
      3_600_000,
      3_600_000 + 60_000,
      86_399_999,
      86_400_000,
      86_400_000 + 3_600_000,
      7 * 86_400_000,
      30 * 86_400_000,
      365 * 86_400_000,
    ];
    for (const ms of samples) {
      expect(kotlinDurationText(ms), `剩余 ${ms}ms 的两端文案不一致`).toBe(formatRemaining(ms));
    }
  });

  it('已知分歧（已上报 P2）：零/负区间两端口径不同，仅记录现状', () => {
    // App 内详情页用 formatRemaining，通知用 remainingText
    expect(formatRemaining(0)).toBe('已逾期');
    expect(kotlinRemainingText(0)).toBe('已到截止时间');

    expect(formatRemaining(-59_999)).toBe('已逾期');
    expect(kotlinRemainingText(-59_999)).toBe('已到截止时间');

    expect(formatRemaining(-60_000)).toBe('已逾期');
    expect(kotlinRemainingText(-60_000)).toBe('已逾期1分钟');

    expect(formatRemaining(-40 * 60_000)).toBe('已逾期');
    expect(kotlinRemainingText(-40 * 60_000)).toBe('已逾期40分钟');

    // 非有限值只有 TS 侧有分支
    expect(formatRemaining(Number.NaN)).toBe('—');
  });
});

describe('回归：老功能不能被新功能弄坏', () => {
  const NOW = new Date(2026, 2, 3, 20, 0, 0, 0).getTime();

  /**
   * 构造一次性待办。
   *
   * @param deadline 截止时间
   */
  function oneOff(deadline: number): Todo {
    return {
      id: 'one-off',
      title: '一次性',
      content: '',
      deadline,
      done: false,
      repeat: NO_REPEAT,
      createdAt: NOW - 86_400_000,
      updatedAt: NOW - 86_400_000,
    };
  }

  it('planReminders 仍是纯函数且六档语义未变（截止在 10 天后 → 6 条，fireAt 升序）', () => {
    const deadline = NOW + 10 * 86_400_000;
    const plans = planReminders(deadline, NOW);

    expect(plans.map((item) => item.kind)).toEqual(['7d', '3d', '1d', '3h', '1h', 'due']);
    expect(plans.map((item) => item.fireAt)).toEqual([
      deadline - 7 * 86_400_000,
      deadline - 3 * 86_400_000,
      deadline - 86_400_000,
      deadline - 3 * 3_600_000,
      deadline - 3_600_000,
      deadline,
    ]);
    // 纯函数：两次调用不共享可变引用
    expect(planReminders(deadline, NOW)).not.toBe(plans);
    expect(planReminders(deadline, NOW)).toEqual(plans);
  });

  it('一次性任务完成后不再产生任何闹钟', () => {
    const todo = { ...oneOff(NOW + 10 * 86_400_000), done: true };
    expect(compileAlarms([todo], NOW)).toEqual([]);
  });

  it('一次性任务过期后不再产生任何闹钟（不补发）', () => {
    expect(compileAlarms([oneOff(NOW - 1)], NOW)).toEqual([]);
  });

  it('补发窗口改成 24 小时后，尝试次数上限仍在 1 小时处先生效（不是 24 小时）', () => {
    expect(REMINDER_GIVE_UP_MS).toBe(24 * 3_600_000);
    expect(REMINDER_MAX_ATTEMPTS).toBe(60);
    // 每分钟一轮 → 60 次 ≈ 1 小时，仍远小于 24 小时窗口
    expect(REMINDER_MAX_ATTEMPTS * 60_000).toBe(3_600_000);
    expect(REMINDER_MAX_ATTEMPTS * 60_000).toBeLessThan(REMINDER_GIVE_UP_MS);
  });
});
