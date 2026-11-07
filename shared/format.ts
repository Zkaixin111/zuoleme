/**
 * 时间格式化纯函数（前端倒计时、Worker 无关）。
 * 单独成文件，便于单元测试且不污染 reminders.ts 的领域语义。
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * 把剩余毫秒格式化为人类可读的紧凑中文。
 *
 * 规则：
 * - 已经到期（ms <= 0）→「已逾期」
 * - 不足 1 分钟 →「不到1分钟」
 * - 以天为单位：「3天2小时」（整小时为 0 时只显示「3天」）
 * - 以小时为单位：「2小时30分钟」（整分钟为 0 时只显示「2小时」）
 * - 仅分钟：「45分钟」
 *
 * @param ms 剩余毫秒（可为负）
 */
export function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms)) {
    return '—';
  }
  if (ms <= 0) {
    return '已逾期';
  }

  const totalMinutes = Math.floor(ms / MINUTE_MS);
  if (totalMinutes < 1) {
    return '不到1分钟';
  }

  const days = Math.floor(totalMinutes / (DAY_MS / MINUTE_MS));
  const minutesAfterDays = totalMinutes % (DAY_MS / MINUTE_MS);
  const hours = Math.floor(minutesAfterDays / (HOUR_MS / MINUTE_MS));
  const minutes = minutesAfterDays % (HOUR_MS / MINUTE_MS);

  if (days > 0) {
    return hours > 0 ? `${days}天${hours}小时` : `${days}天`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}小时${minutes}分钟` : `${hours}小时`;
  }
  return `${minutes}分钟`;
}

/**
 * 把截止时间格式化为「今天 14:30」「明天 09:00」「3月5日 14:30」。
 *
 * @param timestamp 截止时间（毫秒时间戳）
 * @param now 参照的当前时间，默认取系统时间
 */
export function formatDeadline(timestamp: number, now: number = Date.now()): string {
  if (!Number.isFinite(timestamp)) {
    return '—';
  }

  const target = new Date(timestamp);
  const current = new Date(now);
  const time = `${pad2(target.getHours())}:${pad2(target.getMinutes())}`;

  const startOfToday = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
  const startOfTarget = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const dayDiff = Math.round((startOfTarget - startOfToday) / DAY_MS);

  if (dayDiff === 0) {
    return `今天 ${time}`;
  }
  if (dayDiff === 1) {
    return `明天 ${time}`;
  }
  if (dayDiff === -1) {
    return `昨天 ${time}`;
  }
  if (target.getFullYear() === current.getFullYear()) {
    return `${target.getMonth() + 1}月${target.getDate()}日 ${time}`;
  }
  return `${target.getFullYear()}年${target.getMonth() + 1}月${target.getDate()}日 ${time}`;
}

/**
 * 把毫秒时间戳转成 `<input type="datetime-local">` 需要的本地字符串。
 *
 * @param timestamp 毫秒时间戳
 */
export function toDateTimeLocalValue(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(
    date.getMinutes(),
  )}`;
}
