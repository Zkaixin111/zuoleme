import type { Todo } from '../../shared/types';

/**
 * 通知栏常驻卡要显示哪一件事（纯函数，便于单测）。
 *
 * **为什么这条规则必须留在 JS**：原生侧手里只有闹钟列表
 * （`AlarmRecord`：id / todoId / title / deadline / fireAt），它不知道
 * 「哪条已经完成」「哪条只是没设时间」，也不知道「下一次」该怎么算。这些是业务规则，
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
 * 从全部待办里挑出「下一件要做的事」。
 *
 * **产品口径（用户明确要求，已改过一次，别按旧注释改回去）**：
 * 常驻卡**不分一次性和重复任务**，只要求「未完成 + 有截止时间」，取 `deadline` 最早的那条。
 * 所以「每天 9:00 吃药」这类固定任务会长期占据常驻卡 —— 这是用户要的效果：
 * 通知栏里永远是「时间最快截止的那件事」，一次性的事只有比它更近才会顶上来。
 *
 * 曾经的规则是「重复任务不算」（理由是怕挤掉一次性任务、倒计时一直在滚），
 * 那条规则已经按用户要求删掉了；如果将来又要改，请先确认是不是真的改产品口径。
 *
 * 两条筛选：
 * 1. **已完成的不算**：否则常驻卡会一直挂着昨天做完的事；
 * 2. **没有截止时间的不算**：常驻卡的正文与计时器都以截止时间为锚点，没有时间就没有内容可写。
 * 剩下的按 `deadline` 升序取第一条，同一时刻用 `createdAt`、再不行用 `id` 兜底，
 * 保证结果**稳定**（否则同一批数据每次算出来的「下一件」可能在抖）。
 *
 * 已知后果（实测过、可接受）：一条一直没被「完成」的重复任务，它的 `deadline` 会停在过去，
 * 于是常驻卡会持续显示「已逾期 N 天」。这与首页列表里那一行的显示口径一致
 * （列表同样按存储的 `deadline` 归到「已逾期」组），所以不是新增的不一致。
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
    // 这里**不再**排除重复任务：用户要求「一次性任务和每天/每周的固定任务一起比，
    // 只显示时间最快截止的那一件」。详见函数注释里的产品口径。
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
