import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatDeadline } from '../shared/format';

/**
 * 常驻通知的「自己走秒」（对刚交付功能的修正）。
 *
 * 上一版常驻卡把 `remainingText(deadline - now)` 写死进正文，息屏两小时后打开，
 * 通知栏里那句「还有 2 小时」是旧的 —— 显示一个**停住的数字**比不显示更糟，它是错的。
 *
 * 修法不是加定时器（那会是第二个 wake 源），而是让系统计时器渲染：
 * `setWhen(deadline)` + `setUsesChronometer(true)` + `setChronometerCountDown(...)`。
 * 代价是正文不能再放相对量（计时器负责了），要放**绝对时间**，所以 Kotlin 侧需要
 * 一个与 JS `formatDeadline` 同规则的 `deadlineText`。
 *
 * 这个文件做两件事：
 * 1. 用 JS 镜像逐条对账 `deadlineText` 的规则，并与真正的 `formatDeadline` 交叉验证
 *    （JS 镜像 ←→ 产品规格）；
 * 2. 用源码断言把 Kotlin 的分支顺序与那几行计时器调用钉住
 *    （Kotlin ←→ JS 镜像）。
 *
 * 为什么是镜像而不是直接跑 Kotlin：CI 里没有 Android 运行时（`android.jar` 里的
 * `java.util.Calendar` 是 stub），这与项目里 `ReminderStore` 解析镜像的做法一致。
 */

const ROOT = new URL('../', import.meta.url);
const SERVICE = readFileSync(
  new URL('android/app/src/main/java/com/zkaixin/zuoleme/OngoingService.kt', ROOT),
  'utf8',
);

const DAY_MS = 86_400_000;

/** NOW = 2026 年 11 月 8 日 20:00（本地时区） */
const NOW = new Date(2026, 10, 8, 20, 0, 0, 0).getTime();

/**
 * 补零到两位。
 *
 * @param value 数字
 */
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 取某个时间戳「当天 0 点」的毫秒值。
 *
 * @param timestamp 毫秒时间戳
 */
function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * `OngoingService.deadlineText` 的 JS 镜像（逐行对照 Kotlin 实现）。
 *
 * @param deadline 截止时刻
 * @param now 当前时刻
 */
function deadlineTextMirror(deadline: number, now: number): string {
  const target = new Date(deadline);
  const current = new Date(now);
  const clock = `${pad2(target.getHours())}:${pad2(target.getMinutes())}`;
  const dayDiff = Math.round((startOfDay(deadline) - startOfDay(now)) / DAY_MS);

  if (dayDiff === 0) {
    return `今天 ${clock}`;
  }
  if (dayDiff === 1) {
    return `明天 ${clock}`;
  }
  if (dayDiff === -1) {
    return `昨天 ${clock}`;
  }
  if (target.getFullYear() === current.getFullYear()) {
    return `${target.getMonth() + 1}月${target.getDate()}日 ${clock}`;
  }
  return `${target.getFullYear()}年${target.getMonth() + 1}月${target.getDate()}日 ${clock}`;
}

/**
 * 构造某个本地时刻的时间戳。
 *
 * @param year 年
 * @param month 月（1-12）
 * @param day 日
 * @param hour 时
 * @param minute 分
 */
function at(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

describe('deadlineText：与 shared/format.ts 的 formatDeadline 同规则', () => {
  it('当天 → 「今天 HH:mm」', () => {
    expect(deadlineTextMirror(at(2026, 11, 8, 18, 0), NOW)).toBe('今天 18:00');
  });

  it('次日 → 「明天 HH:mm」（跨零点也算明天，哪怕只差 4 小时）', () => {
    expect(deadlineTextMirror(at(2026, 11, 9, 0, 0), NOW)).toBe('明天 00:00');
    expect(deadlineTextMirror(at(2026, 11, 9, 9, 0), NOW)).toBe('明天 09:00');
  });

  it('前一天 → 「昨天 HH:mm」', () => {
    expect(deadlineTextMirror(at(2026, 11, 7, 23, 59), NOW)).toBe('昨天 23:59');
  });

  it('同年其它日期 → 「M月D日 HH:mm」', () => {
    expect(deadlineTextMirror(at(2026, 11, 12, 9, 0), NOW)).toBe('11月12日 09:00');
    expect(deadlineTextMirror(at(2026, 1, 3, 9, 5), NOW)).toBe('1月3日 09:05');
  });

  it('跨年 → 带年份', () => {
    expect(deadlineTextMirror(at(2027, 1, 3, 9, 5), NOW)).toBe('2027年1月3日 09:05');
    expect(deadlineTextMirror(at(2025, 12, 31, 23, 0), NOW)).toBe('2025年12月31日 23:00');
  });

  it('分钟补零（09:05 不能显示成 9:5）', () => {
    expect(deadlineTextMirror(at(2026, 11, 8, 9, 5), NOW)).toBe('今天 09:05');
  });

  it('镜像与真正的 formatDeadline 逐条一致（规格对齐）', () => {
    const samples = [
      at(2026, 11, 8, 18, 0),
      at(2026, 11, 8, 9, 5),
      at(2026, 11, 9, 0, 0),
      at(2026, 11, 7, 23, 59),
      at(2026, 11, 12, 9, 0),
      at(2026, 1, 3, 9, 5),
      at(2027, 1, 3, 9, 5),
      at(2025, 12, 31, 23, 0),
    ];

    for (const sample of samples) {
      expect(deadlineTextMirror(sample, NOW), `deadline=${new Date(sample).toISOString()}`).toBe(
        formatDeadline(sample, NOW),
      );
    }
  });
});

describe('Kotlin 侧：deadlineText 的分支顺序与写法（源码断言）', () => {
  const start = SERVICE.indexOf('fun deadlineText(deadline: Long, now: Long): String');
  const body = SERVICE.slice(start, SERVICE.indexOf('private fun startOfDay'));

  it('函数存在，且签名与镜像一致', () => {
    expect(start).toBeGreaterThan(-1);
    expect(SERVICE).toContain('fun deadlineText(deadline: Long, now: Long): String');
  });

  it('四个分支的顺序：今天 → 明天 → 昨天 → 同年 → 跨年（顺序错了「明天」会被「同年」吃掉）', () => {
    const today = body.indexOf('dayDiff == 0L -> "今天');
    const tomorrow = body.indexOf('dayDiff == 1L -> "明天');
    const yesterday = body.indexOf('dayDiff == -1L -> "昨天');
    const sameYear = body.indexOf('target.get(Calendar.YEAR) == current.get(Calendar.YEAR)');

    expect(today).toBeGreaterThan(-1);
    expect(tomorrow).toBeGreaterThan(today);
    expect(yesterday).toBeGreaterThan(tomorrow);
    expect(sameYear).toBeGreaterThan(yesterday);
    // 跨年分支是最后一条（带年份）
    expect(body).toContain('${target.get(Calendar.YEAR)}年');
  });

  it('用「当天 0 点相减再取整」算天数差，与 JS 的 Math.round 口径一致', () => {
    expect(body).toContain('startOfDay(target) - startOfDay(current)');
    expect(body).toContain('/ DAY_MS.toDouble()');
    expect(body).toContain('Math.round(');
  });

  it('HH:mm 用 %02d 补零，且固定 Locale.US（避免某些区域用本地数字）', () => {
    expect(body).toContain('"%02d:%02d"');
    expect(body).toContain('Locale.US');
  });

  it('注释里写明「与 shared/format.ts 的 formatDeadline 同规则，改动要两边一起改」', () => {
    // KDoc 在函数签名之前，所以这里断言整份源码而不是 body 片段
    expect(SERVICE).toContain('shared/format.ts');
    expect(SERVICE).toContain('formatDeadline');
    expect(SERVICE).toContain('两边一起改');
  });
});

describe('Kotlin 侧：计时器走秒（源码断言）', () => {
  it('用系统计时器而不是自己起定时器', () => {
    expect(SERVICE).toContain('.setUsesChronometer(true)');
    expect(SERVICE).toContain('.setWhen(item.deadline)');
    // 不应该出现任何自建定时器
    expect(SERVICE).not.toContain('Timer(');
    expect(SERVICE).not.toContain('Handler(');
    expect(SERVICE).not.toContain('postDelayed');
  });

  it('未到期 → 倒计时；已逾期 → 正计时（同一个 when 起点，方向相反）', () => {
    const branch = SERVICE.indexOf('if (item.deadline > now) {');
    const countDown = SERVICE.indexOf('.setChronometerCountDown(true)');
    const countUp = SERVICE.indexOf('.setChronometerCountDown(false)');

    expect(branch).toBeGreaterThan(-1);
    expect(countDown).toBeGreaterThan(branch);
    expect(countUp).toBeGreaterThan(countDown);
  });

  it('未到期时正文放绝对时间（相对量交给计时器，避免两句话打架）', () => {
    expect(SERVICE).toContain('builder.setContentText(deadlineText(item.deadline, now))');
  });

  it('已逾期时正文是「已逾期」，具体多久由正计时显示', () => {
    expect(SERVICE).toContain('builder.setContentText("已逾期")');
  });

  it('API 24 以下降级为静态文案，并有注释说明', () => {
    expect(SERVICE).toContain('Build.VERSION.SDK_INT >= Build.VERSION_CODES.N');
    expect(SERVICE).toContain('ReminderNotifier.remainingText(item.deadline - now)');
    expect(SERVICE).toContain('API 23 降级路径');
  });

  it('通知 id 与 JS 侧保留 id 的对应关系写进了注释（改一边要改另一边）', () => {
    expect(SERVICE).toContain('RESERVED_ALARM_IDS');
    expect(SERVICE).toContain('private const val NOTIFICATION_ID = 7011');
  });
});
