import { formatDeadline, formatRemaining } from '../../shared/format';
import type { Todo } from '../../shared/types';

/** 剩余不足 1 小时视为「紧急」，图标与文案变色 */
const URGENT_THRESHOLD_MS = 3_600_000;

export interface PinnedCardProps {
  /** 最近一件未完成的事（按截止时间升序第一条），没有则为 null */
  todo: Todo | null;
  /** 当前时间（由 useNow 每秒推进） */
  now: number;
  /** 正在提交的待办 id，用于禁用按钮 */
  busy: boolean;
  /** 标记完成 */
  onDone: (todo: Todo) => void;
  /** 打开新建面板 */
  onCreate: () => void;
}

/**
 * 顶部常驻卡片：产品核心视图，始终显示「最近一件事」+ 倒计时。
 */
export function PinnedCard({ todo, now, busy, onDone, onCreate }: PinnedCardProps): JSX.Element {
  if (!todo) {
    return (
      <section className="card p-5" aria-label="最近一件事">
        <p className="text-xs font-medium uppercase tracking-widest text-ink-500">常驻 · 最近一件事</p>
        <p className="mt-3 text-base text-ink-300">现在没有待办。</p>
        <button type="button" className="btn-primary mt-4 w-full" onClick={onCreate}>
          加一件要做的事
        </button>
      </section>
    );
  }

  const remaining = todo.deadline - now;
  const urgent = remaining <= URGENT_THRESHOLD_MS;
  const overdue = remaining <= 0;
  const nextFireText =
    todo.nextFireAt !== null && todo.nextFireAt > now ? formatRemaining(todo.nextFireAt - now) : null;

  return (
    <section
      className={`card p-5 ${overdue ? 'ring-red-500/40' : urgent ? 'ring-amber-400/40' : 'ring-brand-500/30'}`}
      aria-label="最近一件事"
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-widest text-ink-500">常驻 · 最近一件事</p>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
            overdue ? 'bg-red-500/15 text-red-300' : urgent ? 'bg-amber-400/15 text-amber-300' : 'bg-brand-500/15 text-brand-300'
          }`}
        >
          {overdue ? '已到点' : urgent ? '临近' : '进行中'}
        </span>
      </div>

      <h2 className="mt-3 break-words text-xl font-semibold leading-snug text-white">{todo.title}</h2>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <p
            className={`text-3xl font-bold tabular-nums ${
              overdue ? 'text-red-300' : urgent ? 'text-amber-300' : 'text-white'
            }`}
          >
            {formatRemaining(remaining)}
          </p>
          <p className="mt-1 text-xs text-ink-500">截止 {formatDeadline(todo.deadline, now)}</p>
          {nextFireText ? <p className="mt-0.5 text-xs text-ink-500">下次提醒：{nextFireText}后</p> : null}
        </div>

        <button
          type="button"
          className="btn-ghost shrink-0"
          disabled={busy}
          onClick={() => onDone(todo)}
          aria-label={`标记完成：${todo.title}`}
        >
          <span aria-hidden="true">✓</span> 完成
        </button>
      </div>
    </section>
  );
}
