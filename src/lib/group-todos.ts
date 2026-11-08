import type { Todo } from '../../shared/types';

/**
 * 首页列表分组（纯函数，便于单测）。
 *
 * 分组顺序就是用户关心的顺序：**已逾期**永远排最前（那是真正着火的），
 * 然后是今天、明天、本周（7 天内）、以后，最后是**无期限**。
 *
 * 已完成的待办统一落到「以后」组，避免它们插在今天里干扰视线。
 *
 * 「无期限」必须**先判 `deadline === null`**：`null` 参与减法会被当成 0，
 * 也就是 1970 年，那条待办会被误判成「已逾期 56 年」并顶到最前面。
 */

/** 分组键 */
export type TodoGroupKey = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'undated';

/** 一个分组 */
export interface TodoGroup {
  key: TodoGroupKey;
  label: string;
  todos: Todo[];
}

/** 分组顺序与中文名 */
const GROUP_META: ReadonlyArray<{ key: TodoGroupKey; label: string }> = [
  { key: 'overdue', label: '已逾期' },
  { key: 'today', label: '今天' },
  { key: 'tomorrow', label: '明天' },
  { key: 'week', label: '本周' },
  { key: 'later', label: '以后' },
  { key: 'undated', label: '无期限' },
];

/**
 * 取某个时间戳当天的 0 点。
 *
 * @param timestamp 毫秒时间戳
 */
function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * 组内排序：有时间的按时间升序，无时间的排在后面按创建时间升序。
 *
 * @param a 待办 A
 * @param b 待办 B
 */
function compareInGroup(a: Todo, b: Todo): number {
  if (a.deadline !== null && b.deadline !== null && a.deadline !== b.deadline) {
    return a.deadline - b.deadline;
  }
  if (a.deadline === null && b.deadline !== null) {
    return 1;
  }
  if (a.deadline !== null && b.deadline === null) {
    return -1;
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 把待办按「逾期 / 今天 / 明天 / 本周 / 以后 / 无期限」分组。
 *
 * 空分组会被过滤掉（界面不显示空标题）。
 *
 * 分组边界用 `todayStart + 86_400_000` 这类固定 24 小时偏移是**刻意的**：
 * 中国全境不使用夏令时，一天恒等于 24 小时；换成日历计算只会徒增复杂度。
 *
 * @param todos 待办列表
 * @param now 当前时间
 * @returns 非空分组数组，顺序固定
 */
export function groupTodos(todos: readonly Todo[], now: number): TodoGroup[] {
  const todayStart = startOfDay(now);
  const tomorrowStart = todayStart + 86_400_000;
  const weekEnd = todayStart + 7 * 86_400_000;

  const buckets = new Map<TodoGroupKey, Todo[]>([
    ['overdue', []],
    ['today', []],
    ['tomorrow', []],
    ['week', []],
    ['later', []],
    ['undated', []],
  ]);

  for (const todo of todos) {
    if (todo.done) {
      buckets.get('later')?.push(todo);
      continue;
    }
    // 必须先判 null：否则下面的 `todo.deadline < now` 会把 null 当成 0
    if (todo.deadline === null) {
      buckets.get('undated')?.push(todo);
      continue;
    }
    if (todo.deadline < now) {
      buckets.get('overdue')?.push(todo);
      continue;
    }
    if (todo.deadline < tomorrowStart) {
      buckets.get('today')?.push(todo);
      continue;
    }
    if (todo.deadline < tomorrowStart + 86_400_000) {
      buckets.get('tomorrow')?.push(todo);
      continue;
    }
    if (todo.deadline < weekEnd) {
      buckets.get('week')?.push(todo);
      continue;
    }
    buckets.get('later')?.push(todo);
  }

  return GROUP_META.map((meta) => ({
    key: meta.key,
    label: meta.label,
    todos: [...(buckets.get(meta.key) ?? [])].sort(compareInGroup),
  })).filter((group) => group.todos.length > 0);
}
