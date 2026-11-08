import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * JS ↔ Kotlin ↔ AndroidManifest 的**静态契约测试**。
 *
 * 这三层之间没有任何编译期校验：字段名拼错、SharedPreferences 名字改了、
 * PendingIntent 少一个 flag —— 全都能编译通过、装得上、跑起来不报错，
 * 只是「提醒不响」。这类静默失败在真机上极难定位，所以在 CI 里用源码断言把它钉住。
 *
 * 断言遵循一个原则：**只锁协议，不锁实现**。
 * 例如不要求某个函数写成什么样子，只要求「读的键」与「写的键」完全一致。
 */

const ROOT = new URL('../', import.meta.url);

/**
 * 读取仓库内的源码文件。
 *
 * @param relative 相对仓库根目录的路径
 */
function readSource(relative: string): string {
  return readFileSync(new URL(relative, ROOT), 'utf8');
}

/**
 * 提取所有匹配到的第一个捕获组。
 *
 * @param text 源文本
 * @param pattern 带一个捕获组的正则（必须带 g 标志）
 */
function captureAll(text: string, pattern: RegExp): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(pattern)) {
    found.push(match[1]);
  }
  return found;
}

const REMINDER_STORE = readSource('android/app/src/main/java/com/zkaixin/zuoleme/ReminderStore.kt');
const BOOT_RECEIVER = readSource('android/app/src/main/java/com/zkaixin/zuoleme/BootReceiver.kt');
const ALARM_RECEIVER = readSource('android/app/src/main/java/com/zkaixin/zuoleme/AlarmReceiver.kt');
const NOTIFIER = readSource('android/app/src/main/java/com/zkaixin/zuoleme/ReminderNotifier.kt');
const PLUGIN = readSource('android/app/src/main/java/com/zkaixin/zuoleme/ReminderAlarmPlugin.kt');
const MAIN_ACTIVITY = readSource('android/app/src/main/java/com/zkaixin/zuoleme/MainActivity.kt');
const MANIFEST = readSource('android/app/src/main/AndroidManifest.xml');
const BRIDGE = readSource('src/lib/reminder-bridge.ts');

describe('持久化：开机重建读的就是排程时写的（最致命的静默失败点）', () => {
  it('ReminderStore 用常量定义 prefs 名与键，且两处读写共用同一常量', () => {
    const prefsName = captureAll(REMINDER_STORE, /PREFS_NAME = "([^"]+)"/g);
    const keyName = captureAll(REMINDER_STORE, /KEY_ALARMS = "([^"]+)"/g);

    expect(prefsName).toEqual(['zuoleme_alarms']);
    expect(keyName).toEqual(['alarms']);

    // 写与读必须都走这两个常量，不能出现第二个字面量
    const literalPrefs = captureAll(REMINDER_STORE, /getSharedPreferences\(\s*"([^"]+)"/g);
    expect(literalPrefs).toEqual([]);
    const literalKeys = captureAll(REMINDER_STORE, /\.(?:getString|putString|remove)\(\s*"([^"]+)"/g);
    expect(literalKeys).toEqual([]);
  });

  it('BootReceiver 只通过 ReminderStore 读盘，绝不自己拼 prefs 名', () => {
    // 自己拼一个名字 = 两次写读不同文件 = 重启后静默不响
    expect(BOOT_RECEIVER).toMatch(/ReminderStore\.load\(context\)/);
    expect(BOOT_RECEIVER).not.toMatch(/getSharedPreferences/);
    expect(BOOT_RECEIVER).not.toMatch(/"zuoleme_alarms"/);
    expect(BOOT_RECEIVER).toMatch(/ReminderStore\.scheduleAll\(context,\s*alarms\)/);
  });

  it('load 与 save 字段一一对应（少存一个字段 = 重启后通知文案变默认值）', () => {
    const saved = captureAll(REMINDER_STORE, /item\.put\("(\w+)"/g).sort();
    const loaded = captureAll(REMINDER_STORE, /item\.opt(?:Int|Long|String)\("(\w+)"/g).sort();

    expect(saved).toEqual(['body', 'fireAt', 'id', 'title']);
    expect(loaded).toEqual(['body', 'fireAt', 'id', 'title']);
  });

  it('开机重建会过滤掉已过去的闹钟（不补发历史提醒）', () => {
    expect(REMINDER_STORE).toMatch(/filter\s*\{\s*it\.fireAt\s*>\s*now\s*\}/);
  });

  it('BootReceiver 的 try/finally 一定调用 pendingResult.finish()（否则系统会杀掉进程）', () => {
    expect(BOOT_RECEIVER).toMatch(/goAsync\(\)/);
    expect(BOOT_RECEIVER).toMatch(/finally\s*\{[\s\S]*pendingResult\.finish\(\)/);
  });
});

describe('PendingIntent 的唯一性与 flag', () => {
  it('requestCode 用的是 alarm id，且 action/data 也带上 id（三重唯一）', () => {
    expect(REMINDER_STORE).toMatch(/PendingIntent\.getBroadcast\(context,\s*record\.id,/);
    expect(REMINDER_STORE).toMatch(/action\s*=\s*"\$ACTION_FIRE_PREFIX\.\$\{record\.id\}"/);
    expect(REMINDER_STORE).toMatch(/data\s*=\s*Uri\.parse\("zuoleme:\/\/alarm\/\$\{record\.id\}"\)/);
  });

  it('flags 同时包含 FLAG_UPDATE_CURRENT 与 FLAG_IMMUTABLE', () => {
    for (const source of [REMINDER_STORE, NOTIFIER]) {
      expect(source).toMatch(/FLAG_UPDATE_CURRENT/);
      expect(source).toMatch(/FLAG_IMMUTABLE/);
    }
    // Android 12+ 对「带 mutable flag」的 PendingIntent 直接抛异常，必须显式写清楚
    expect(REMINDER_STORE).not.toMatch(/FLAG_MUTABLE/);
    expect(NOTIFIER).not.toMatch(/FLAG_MUTABLE/);
  });
});

describe('通知：id、渠道与重要性', () => {
  it('通知 id 直接用 alarm id（不同档位 = 不同通知，不会互相覆盖）', () => {
    expect(NOTIFIER).toMatch(/manager\.notify\(\s*alarmId\s*,/);
    expect(ALARM_RECEIVER).toMatch(/notifyReminder\(context,\s*alarmId,\s*title,\s*body\)/);
  });

  it('渠道 IMPORTANCE 是 HIGH（低重要性会被折叠，用户看不到）', () => {
    expect(NOTIFIER).toMatch(/NotificationChannel\([^)]*IMPORTANCE_HIGH\)/);
    expect(NOTIFIER).not.toMatch(/IMPORTANCE_LOW|IMPORTANCE_MIN|IMPORTANCE_DEFAULT/);
  });

  it('发通知前一定会 ensureChannel（Android 8+ 没有渠道会被静默丢弃）', () => {
    expect(NOTIFIER).toMatch(/fun notifyReminder\([\s\S]*?ensureChannel\(context\)/);
    // Activity 启动时也建一次，保证「装完先看看」的阶段就有渠道
    expect(MAIN_ACTIVITY).toMatch(/ReminderNotifier\.ensureChannel\(this\)/);
  });

  it('插件注册发生在 super.onCreate 之前（否则 JS 拿到空实现）', () => {
    const registerIndex = MAIN_ACTIVITY.indexOf('registerPlugin');
    const superIndex = MAIN_ACTIVITY.indexOf('super.onCreate');

    expect(registerIndex).toBeGreaterThan(-1);
    expect(superIndex).toBeGreaterThan(-1);
    expect(registerIndex).toBeLessThan(superIndex);
  });

  it('插件名与 JS 侧 registerPlugin 的名字一致', () => {
    expect(PLUGIN).toMatch(/name\s*=\s*"ReminderAlarm"/);
    expect(BRIDGE).toMatch(/registerPlugin<[^>]*>\('ReminderAlarm'\)/);
  });
});

describe('JS ↔ Kotlin 的闹钟字段协议', () => {
  it('JS 的 NativeAlarm 字段 = Kotlin 插件读取的字段 = Kotlin 落盘的字段', () => {
    const interfaceBlock = BRIDGE.slice(
      BRIDGE.indexOf('export interface NativeAlarm'),
      BRIDGE.indexOf('}', BRIDGE.indexOf('export interface NativeAlarm'))
    );
    const jsKeys = captureAll(interfaceBlock, /^\s{2}(\w+):/gm).sort();

    const pluginKeys = captureAll(PLUGIN, /item\.opt(?:Int|Long|String)\("(\w+)"/g).sort();
    const storeKeys = captureAll(REMINDER_STORE, /item\.put\("(\w+)"/g).sort();

    expect(jsKeys).toEqual(['body', 'fireAt', 'id', 'title']);
    expect(pluginKeys).toEqual(['body', 'fireAt', 'id', 'title']);
    expect(storeKeys).toEqual(['body', 'fireAt', 'id', 'title']);
  });

  it('原生侧把「非法 id / 过去的 fireAt」当无效条目丢掉（不在系统里排错误时间）', () => {
    expect(PLUGIN).toMatch(/if\s*\(id\s*<=\s*0\s*\|\|\s*fireAt\s*<=\s*0L\)/);
    expect(REMINDER_STORE).toMatch(/if\s*\(id\s*<=\s*0\s*\|\|\s*fireAt\s*<=\s*0L\)/);
  });
});

describe('AndroidManifest：权限与广播接收器', () => {
  const REQUIRED_PERMISSIONS = [
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.SCHEDULE_EXACT_ALARM',
    'android.permission.USE_EXACT_ALARM',
    'android.permission.RECEIVE_BOOT_COMPLETED',
    'android.permission.WAKE_LOCK',
    'android.permission.VIBRATE',
  ];

  it('六个必需权限一个都不少', () => {
    for (const permission of REQUIRED_PERMISSIONS) {
      expect(MANIFEST).toContain(`<uses-permission android:name="${permission}" />`);
    }
  });

  it('两个 receiver 都在，且都显式声明 exported（targetSdk 31+ 必须写）', () => {
    expect(MANIFEST).toMatch(/android:name="\.AlarmReceiver"[\s\S]{0,120}android:exported="false"/);
    expect(MANIFEST).toMatch(/android:name="\.BootReceiver"[\s\S]{0,120}android:exported="false"/);
  });

  it('BootReceiver 声明了 BOOT_COMPLETED 与 MY_PACKAGE_REPLACED（升级后也要能重建）', () => {
    const bootBlock = MANIFEST.slice(MANIFEST.indexOf('.BootReceiver'));
    const actions = captureAll(bootBlock, /<action android:name="([^"]+)"\s*\/>/g);

    expect(actions).toContain('android.intent.action.BOOT_COMPLETED');
    expect(actions).toContain('android.intent.action.MY_PACKAGE_REPLACED');
    expect(actions).toContain('android.intent.action.LOCKED_BOOT_COMPLETED');
  });

  it('Manifest 里声明的 action 与 BootReceiver 的 HANDLED_ACTIONS 完全一致（不漏不重）', () => {
    const bootBlock = MANIFEST.slice(MANIFEST.indexOf('.BootReceiver'));
    const manifestActions = captureAll(bootBlock, /<action android:name="([^"]+)"\s*\/>/g).sort();
    const handled = captureAll(BOOT_RECEIVER, /"([A-Za-z0-9_.]*(?:BOOT_COMPLETED|POWERON|PACKAGE_REPLACED))"/g)
      .concat(captureAll(BOOT_RECEIVER, /Intent\.ACTION_(BOOT_COMPLETED|MY_PACKAGE_REPLACED)/g).map(
        (name) => `android.intent.action.${name}`
      ))
      .sort();

    expect(handled).toEqual(manifestActions);
  });
});
