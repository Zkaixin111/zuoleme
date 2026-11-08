import type { Todo } from '../../shared/types';

/**
 * 通知栏常驻卡要显示哪一件事（纯函数，便于单测）。
 *
 * **为什么这条规则必须留在 JS**：原生侧手里只有闹钟列表
 * （`AlarmRecord`：id / todoId / title / deadline / fireAt），它不知道
 * 「哪条是重复任务」「哪条已经完成」「哪条只是没设时间」。这些是业务规则，
 * 复制一份到 Kotlin 里迟早会两边不一致 —— 改了 JS 忘了改 Kotlin，
 * 用户就会看到「常驻卡显示的是昨天已经做完的那件事」这种最讨厌的错。
 * 所以原生只负责显示，选择逻辑只在这里。
 */

/** 常驻通知的内容（字段与 Kotlin 侧 `OngoingItem` 一一对应） */
export interface OngoingItem {
  /** 待办 id：点通知时用它打开对应编辑页 */
  todoId: string;
  /** 通知标题（= 待办标题） */
  title: string;
  /** 截止时刻（毫秒）：通知正文由原生用 `deadline - 现在` 现算 */
  deadline: number;
}

/**
 * 从全部待办里挑出「最近一件要做的一次性事情」。
 *
 * 四条筛选（每一条都对应一种用户会立刻发现的错误）：
 * 1. **已完成的不算**：否则常驻卡会一直挂着昨天做完的事；
 * 2. **没有截止时间的不算**：常驻卡的第二行就是剩余时间，没有时间就没内容可写；
 * 3. **重复任务不算**：每天重复的事永远是「最近的一件」，会把真正一次性的事挤掉，
 *    而且它的倒计时永远在滚动，看着像卡住了；
 * 4. 剩下的取 **deadline 最早** 的那一条（= 最紧迫的）。
 *
 * 排序用 `deadline` 升序，同一时刻用 `createdAt`、再不行用 `id` 兜底，
 * 保证结果**稳定**（否则同一批数据每次算出来的「最近一件」可能在抖）。
 *
 * @param todos 全部待办
 * @returns 要常驻显示的那一件事；没有符合条件的返回 null（原生侧会收起常驻通知）
 */
export function pickOngoingItem(todos: readonly Todo[]): OngoingItem | null {
  let best: Todo | null = null;

  for (const todo of todos) {
    if (todo.done) {
      continue;
    }
    if (todo.deadline === null) {
      continue;
    }
    if (todo.repeat.kind !== 'none') {
      continue;
    }
    if (best === null) {
      best = todo;
      continue;
    }
    const bestDeadline = best.deadline as number;
    if (todo.deadline < bestDeadline) {
      best = todo;
      continue;
    }
    if (todo.deadline === bestDeadline) {
      if (todo.createdAt < best.createdAt) {
        best = todo;
      } else if (todo.createdAt === best.createdAt && todo.id < best.id) {
        best = todo;
      }
    }
  }

  if (best === null || best.deadline === null) {
    return null;
  }
  return { todoId: best.id, title: best.title, deadline: best.deadline };
}
