import { describe, expect, it } from 'vitest';
import { NO_REPEAT, type Todo } from '../shared/types';
import { formatCompletedAt, sortCompleted } from '../src/lib/history';

/**
 * 历史任务页（需求 5）的排序与文案。
 *
 * 排序是这一页唯一的真实逻辑，也是最容易「看起来对、用起来抖」的地方：
 * 同一毫秒完成的两条如果不定序，每次进入页面顺序都在变；
 * 缺 `completedAt` 的老数据如果参与减法，会被当成 1970 年而沉底或顶到最前。
 */

const NOW = new Date(2026, 10, 8, 21, 30, 0, 0).getTime();
const DAY_MS = 86_400_000;

/**
 * 构造一条已完成待办。
 *
 * @param id 待办 id
 * @param completedAt 完成时刻（null = 老数据没记）
 * @param deadline 原定截止时间
 */
function doneTodo(id: string, completedAt: number | null, deadline: number | null = null): Todo {
  return {
    id,
    title: `待办 ${id}`,
    content: '',
    deadline,
    advanceReminder: true,
    done: true,
    completedAt,
    repeat: NO_REPEAT,
    createdAt: NOW - 10 * DAY_MS,
    updatedAt: NOW - DAY_MS,
  };
}

describe('sortCompleted：按完成时间倒序', () => {
  it('最近完成的排最前', () => {
    const sorted = sortCompleted([
      doneTodo('old', NOW - 5 * DAY_MS),
      doneTodo('new', NOW - 1000),
      doneTodo('middle', NOW - 2 * DAY_MS),
    ]);

    expect(sorted.map((todo) => todo.id)).toEqual(['new', 'middle', 'old']);
  });

  it('同一毫秒完成的两条按 id 定序（顺序稳定，不会每次进页面都在跳）', () => {
    const stamp = NOW - DAY_MS;
    const first = sortCompleted([doneTodo('b', stamp), doneTodo('a', stamp)]);
    const second = sortCompleted([doneTodo('a', stamp), doneTodo('b', stamp)]);

    expect(first.map((todo) => todo.id)).toEqual(['a', 'b']);
    expect(second.map((todo) => todo.id)).toEqual(['a', 'b']);
  });

  it('缺 completedAt（null）的排在最后，且不参与时间比较', () => {
    const sorted = sortCompleted([
      doneTodo('no-stamp', null),
      doneTodo('recent', NOW - 1000),
      doneTodo('older', NOW - 9 * DAY_MS),
    ]);

    expect(sorted.map((todo) => todo.id)).toEqual(['recent', 'older', 'no-stamp']);
  });

  it('不修改传入的数组（调用方可能还拿着原列表渲染）', () => {
    const input = [doneTodo('a', NOW - 1000), doneTodo('b', NOW - 2000)];
    const snapshot = input.map((todo) => todo.id);

    sortCompleted(input);

    expect(input.map((todo) => todo.id)).toEqual(snapshot);
  });

  it('空列表 / 单条不出错', () => {
    expect(sortCompleted([])).toEqual([]);
    expect(sortCompleted([doneTodo('only', NOW)]).map((todo) => todo.id)).toEqual(['only']);
  });
});

describe('formatCompletedAt：绝对时间，不说「今天」', () => {
  it('同年 → 「11月8日 21:30」', () => {
    expect(formatCompletedAt(NOW, NOW)).toBe('11月8日 21:30');
  });

  it('同一时刻也不用「今天」这种相对说法（历史页全是过去的事）', () => {
    expect(formatCompletedAt(NOW - 60_000, NOW)).toBe('11月8日 21:29');
    expect(formatCompletedAt(NOW - 60_000, NOW)).not.toContain('今天');
  });

  it('跨年 → 带年份', () => {
    const lastYear = new Date(2025, 11, 31, 23, 5, 0, 0).getTime();
    expect(formatCompletedAt(lastYear, NOW)).toBe('2025年12月31日 23:05');
  });

  it('非法时间戳 → 占位符，不崩也不显示 NaN', () => {
    expect(formatCompletedAt(Number.NaN, NOW)).toBe('—');
    expect(formatCompletedAt(Number.POSITIVE_INFINITY, NOW)).toBe('—');
  });
});
