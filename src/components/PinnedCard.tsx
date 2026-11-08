import { formatDeadline, formatRemaining } from '../../shared/format';
import { repeatLabel } from '../../shared/repeat';
import type { Todo } from '../../shared/types';

/** 剩余不足 1 小时视为「临近」 */
const URGENT_THRESHOLD_MS = 3_600_000;

/** 常驻卡片只关心「有截止时间」的待办：没有时间就没有倒计时可显示 */
export type PinnedTodo = Todo & { deadline: number };

export interface PinnedCardProps {
  /** 最近一件有截止时间且未完成的事，没有则为 null */
  todo: PinnedTodo | null;
  /** 当前时间（每秒推进） */
  now: number;
  /** 当前这一次还剩几档提醒 */
  reminderCount: number;
  /** 另有几件「无期限」的待办（只用于空状态提示） */
  undatedCount: number;
  /** 正在提交 */
  busy: boolean;
  /** 标记完成（重复任务 = 推进到下一次） */
  onDone: (todo: Todo) => void;
  /** 打开详情 */
  onOpen: (todo: Todo) => void;
  /** 打开新建 */
  onCreate: () => void;
}

/**
 * 顶部常驻卡片：始终显示「最近一件有截止时间的事」+ 剩余时间。
 *
 * 只显示标题，不显示内容——内容在详情页里看。
 *
 * 逾期时**不显示角标**：大字已经是「已逾期 40 分钟」，角标再写一遍「已逾期」
 * 就是同一句话说两次，还把视觉重心从倒计时上抢走。
 */
export function PinnedCard({
  todo,
  now,
  reminderCount,
  undatedCount,
  busy,
  onDone,
  onOpen,
  onCreate,
}: PinnedCardProps): JSX.Element {
  if (!todo) {
    return (
      <section className="card p-5" aria-label="最近一件事">
        <p className="text-xs text-faint">最近一件事</p>
        <p className="mt-3 text-[15px] text-soft">
          {undatedCount > 0 ? '没有带截止时间的待办' : '现在没有待办。'}
        </p>
        {undatedCount > 0 ? (
          <p className="mt-1 text-xs text-faint">另有 {undatedCount} 件无期限</p>
        ) : null}
        <button type="button" className="btn-primary mt-4 w-full" onClick={onCreate}>
          加一件要做的事
        </button>
      </section>
    );
  }

  const remaining = todo.deadline - now;
  const overdue = remaining <= 0;
  const urgent = !overdue && remaining <= URGENT_THRESHOLD_MS;
  const reminderText = reminderCount > 0 ? `还有 ${reminderCount} 档提醒` : '提醒已全部发出';

  return (
    <section className="card p-5" aria-label="最近一件事">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-faint">最近一件事</p>
        {overdue ? null : (
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
              urgent ? 'bg-accent-soft text-accent' : 'text-faint'
            }`}
          >
            {urgent ? '临近' : repeatLabel(todo.repeat)}
          </span>
        )}
      </div>

      <h2 className="mt-3 break-words text-[19px] font-semibold leading-snug text-ink">{todo.title}</h2>

      <p className={`mt-2 text-[27px] font-semibold leading-none ${overdue ? 'text-alert' : 'text-accent'}`}>
        {formatRemaining(remaining)}
      </p>

      <p className="mt-2 text-xs text-soft">
        {formatDeadline(todo.deadline, now)} 截止 · {reminderText}
      </p>

      <div className="mt-4 flex gap-2">
        <button type="button" className="btn-ghost flex-1" disabled={busy} onClick={() => onDone(todo)}>
          {todo.repeat.kind === 'none' ? '完成' : '完成这次'}
        </button>
        <button type="button" className="btn-primary flex-1" onClick={() => onOpen(todo)}>
          看内容
        </button>
      </div>
    </section>
  );
}
