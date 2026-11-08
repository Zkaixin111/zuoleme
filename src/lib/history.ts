import type { Todo } from '../../shared/types';

/**
 * 历史任务（已完成的待办）的排序与文案（纯函数，便于单测）。
 *
 * 为什么不在组件里就地写：排序规则有两个边界（缺 `completedAt` 的老数据、
 * 同一毫秒完成的两条），在 JSX 里既写不清也测不到。
 */

/**
 * 按完成时间**倒序**排（最近完成的在最上面）。
 *
 * - `completedAt` 为 null（理论上 normalizeTodo 已兜底，这里防御老数据/手工数据）
 *   排在最后，不参与时间比较 —— 让 `null` 参与减法会变成 1970 年，直接沉到最底或顶到最前。
 * - 同一时刻完成的两条用 `id` 兜底，保证排序**稳定**（否则每次进入历史页顺序都在抖）。
 *
 * @param todos 已完成待办
 */
export function sortCompleted(todos: readonly Todo[]): Todo[] {
  return [...todos].sort((a, b) => {
    const aTime = a.completedAt;
    const bTime = b.completedAt;
    if (aTime !== null && bTime !== null && aTime !== bTime) {
      return bTime - aTime;
    }
    if (aTime === null && bTime !== null) {
      return 1;
    }
    if (aTime !== null && bTime === null) {
      return -1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * 历史页里的绝对时间：`11月8日 21:30`（跨年时带年份）。
 *
 * 刻意不用 `formatDeadline`：那个函数会把当天显示成「今天 21:30」，
 * 而历史页全都是过去的事，说「今天」会让人误以为刚完成。
 *
 * @param timestamp 毫秒时间戳
 * @param now 当前时间（判断是否跨年）
 */
export function formatCompletedAt(timestamp: number, now: number = Date.now()): string {
  if (!Number.isFinite(timestamp)) {
    return '—';
  }
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const current = new Date(now);
  if (date.getFullYear() !== current.getFullYear()) {
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
  }
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}
