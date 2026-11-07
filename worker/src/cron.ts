import type { PushPayload } from '../../shared/types';
import { reminderBody, reminderTag } from '../../shared/reminders';
import { deleteSubById, dueReminders, listSubs, markReminderSent, type DueReminderRow } from './db';
import type { Env } from './env';
import { sendPushToSub } from './push';

/**
 * 每分钟执行的调度逻辑。
 *
 * 顺序严格为「先发送，成功/失败后再标记 sent=1」：
 * 宁可重复发一次，也不要漏发（重复可容忍、漏发不可容忍）。
 */

export interface CronSummary {
  scanned: number;
  pushed: number;
  failed: number;
  subscriptions: number;
}

/**
 * 扫描到期提醒并逐条推送。
 *
 * @param env 运行环境
 * @param now 当前时间（毫秒）
 */
export async function runCron(env: Env, now: number): Promise<CronSummary> {
  const summary: CronSummary = { scanned: 0, pushed: 0, failed: 0, subscriptions: 0 };

  const due: DueReminderRow[] = await dueReminders(env.DB, now);
  summary.scanned = due.length;
  if (due.length === 0) {
    return summary;
  }

  let subs = await listSubs(env.DB);
  summary.subscriptions = subs.length;

  for (const reminder of due) {
    const payload: PushPayload = {
      title: reminder.title,
      body: reminderBody(reminder.kind),
      todoId: reminder.todo_id,
      kind: reminder.kind,
      // 不同档位 / 不同事项各自独立一条通知，不互相覆盖
      tag: reminderTag(reminder.todo_id, reminder.kind),
    };

    if (subs.length === 0) {
      // 没有任何订阅者：不报错，但要标记 sent 避免每分钟重复扫描堆积
      console.warn(`[cron] 无订阅者，跳过推送并标记已处理 reminder=${reminder.id} kind=${reminder.kind}`);
      await markReminderSent(env.DB, reminder.id, now);
      continue;
    }

    const results = await Promise.all(subs.map((sub) => sendPushToSub(env, sub, payload, now)));

    const goneIds = new Set<string>();
    for (const result of results) {
      if (result.ok) {
        summary.pushed += 1;
      } else {
        summary.failed += 1;
      }
      if (result.gone) {
        goneIds.add(result.subscriptionId);
      }
    }

    // 清理失效订阅，并让本轮后续提醒不再尝试
    for (const id of goneIds) {
      await deleteSubById(env.DB, id);
      console.warn(`[cron] 清理失效订阅 id=${id}`);
    }
    if (goneIds.size > 0) {
      subs = subs.filter((sub) => !goneIds.has(sub.id));
    }

    // 先发后标记：即使全部失败也标记，避免同一条提醒每分钟疯狂重发；
    // 若需要更严格的重试语义，可改为「只要有一个成功才标记」。
    await markReminderSent(env.DB, reminder.id, now);
  }

  console.log(
    `[cron] now=${new Date(now).toISOString()} scanned=${summary.scanned} pushed=${summary.pushed} failed=${summary.failed} subs=${summary.subscriptions}`,
  );
  return summary;
}
