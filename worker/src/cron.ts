import type { PushPayload } from '../../shared/types';
import { decideReminderOutcome, reminderBody, reminderTag } from '../../shared/reminders';
import {
  deleteSubById,
  dueReminders,
  incrementReminderAttempts,
  listSubs,
  markReminderSent,
  type DueReminderRow,
} from './db';
import type { Env } from './env';
import { sendPushToSub, type SendResult } from './push';

/**
 * 每分钟执行的调度逻辑。
 *
 * 核心原则：**宁可重复发一次，也不要漏发**。
 * 因此「先发送 → 再依据结果决定落库」：
 * - 至少一个订阅成功 → sent=1（结束）
 * - 全失败/无订阅者    → 保留 sent=0 并累加 attempts，下一轮继续补发
 * - 超出补发窗口或次数上限 → sent=1 并打 `[cron] 放弃` 的 error 日志（绝不静默丢弃）
 *
 * 补发窗口与次数上限的判定逻辑抽在 shared/reminders.ts 的 decideReminderOutcome（可单测）。
 */

export interface CronSummary {
  /** 本轮扫到的到期提醒数 */
  scanned: number;
  /** 成功推送的「订阅×提醒」条数 */
  pushed: number;
  /** 失败的「订阅×提醒」条数 */
  failed: number;
  /** 当前订阅数 */
  subscriptions: number;
  /** 本轮判定为已发送的提醒数 */
  sent: number;
  /** 本轮保留待重试的提醒数 */
  retried: number;
  /** 本轮放弃的提醒数（超窗口/超次数） */
  givenUp: number;
}

/** 把失败明细压成一行日志文案 */
function describeFailures(results: readonly SendResult[], subscriptionCount: number): string {
  if (subscriptionCount === 0) {
    return '无订阅者';
  }
  if (results.length === 0) {
    return '未发送';
  }
  return results
    .map((result) => {
      const shortId = result.subscriptionId.slice(0, 8);
      const detail = result.error ? ` ${result.error.slice(0, 80)}` : '';
      return `${shortId}:status=${result.status}${detail}`;
    })
    .join(' | ');
}

/**
 * 扫描到期提醒并逐条推送。
 *
 * @param env 运行环境
 * @param now 当前时间（毫秒）
 */
export async function runCron(env: Env, now: number): Promise<CronSummary> {
  const summary: CronSummary = {
    scanned: 0,
    pushed: 0,
    failed: 0,
    subscriptions: 0,
    sent: 0,
    retried: 0,
    givenUp: 0,
  };

  const due: DueReminderRow[] = await dueReminders(env.DB, now);
  summary.scanned = due.length;

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
      // 没有订阅者：**不再直接标记已发**。
      // 否则「先建待办、之后才开通知」的用户这一档会被静默烧掉，
      // 现在改为走统一判定：保留待重试，补齐订阅后仍能收到。
      // 真实的补发上限是 `REMINDER_MAX_ATTEMPTS = 60`（每分钟一轮 ≈ 1 小时），
      // 它会**先于** 24 小时的 `REMINDER_GIVE_UP_MS` 生效——所以别对外承诺「24 小时内一定补上」。
      console.warn(
        `[cron] 无订阅者，保留待重试 reminder=${reminder.id} todo=${reminder.todo_id} kind=${reminder.kind} attempts=${reminder.attempts}`,
      );
    }

    const results: SendResult[] =
      subs.length === 0 ? [] : await Promise.all(subs.map((sub) => sendPushToSub(env, sub, payload, now)));

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

    const pushSucceeded = results.some((result) => result.ok);
    const outcome = decideReminderOutcome({
      pushSucceeded,
      attempts: reminder.attempts,
      fireAt: reminder.fire_at,
      now,
    });

    if (outcome === 'retry') {
      await incrementReminderAttempts(env.DB, reminder.id);
      summary.retried += 1;
      console.warn(
        `[cron] 保留待重试 reminder=${reminder.id} todo=${reminder.todo_id} kind=${reminder.kind} ` +
          `attempts=${reminder.attempts + 1} 迟到=${Math.max(0, now - reminder.fire_at)}ms ` +
          `原因=${describeFailures(results, summary.subscriptions)}`,
      );
      continue;
    }

    if (outcome === 'give_up') {
      // 放弃必须留痕：这条提醒再也不会出现在推送里了
      await markReminderSent(env.DB, reminder.id, now);
      summary.givenUp += 1;
      console.error(
        `[cron] 放弃 reminder=${reminder.id} todo=${reminder.todo_id} kind=${reminder.kind} ` +
          `attempts=${reminder.attempts + 1} 迟到=${Math.max(0, now - reminder.fire_at)}ms ` +
          `原因=${describeFailures(results, summary.subscriptions)}`,
      );
      continue;
    }

    await markReminderSent(env.DB, reminder.id, now);
    summary.sent += 1;
  }

  // 每轮都打汇总行（即使 scanned=0），否则排错时会误判「Cron 没跑」
  console.log(
    `[cron] now=${new Date(now).toISOString()} scanned=${summary.scanned} sent=${summary.sent} ` +
      `retried=${summary.retried} givenUp=${summary.givenUp} pushed=${summary.pushed} ` +
      `failed=${summary.failed} subs=${summary.subscriptions}`,
  );
  return summary;
}
