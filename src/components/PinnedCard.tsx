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
  /** 打开编辑页 */
  onOpen: (todo: Todo) => void;
}

/**
 * 顶部常驻卡片。
 *
 * **视觉层级（这是重做过的部分）**：用户第一眼要读到「是什么事」，而不是「还有多久」。
 * 所以标题 22px 是卡片里最大的字，倒计时降为第二行的一部分（14px），
 * 不再有比标题更大的数字。原来那个 27px 的倒计时大字已经删掉 ——
 * 它把重量从「事情」抢到了「数字」上，用户扫一眼只记住「2 小时」，想不起是哪件事。
 *
 * 逾期时不再显示角标：第二行整行转成 `alert` 色并带一个小圆点，
 * 信息已经够明确，再加一个「已逾期」角标就是同一句话说两遍。
 */
export function PinnedCard({
  todo,
  now,
  reminderCount,
  undatedCount,
  busy,
  onDone,
  onOpen,
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
      </section>
    );
  }

  const remaining = todo.deadline - now;
  const overdue = remaining <= 0;
  const urgent = !overdue && remaining <= URGENT_THRESHOLD_MS;

  return (
    <section className="card p-5" aria-label="最近一件事">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-faint">最近一件事</p>
        {overdue ? (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-alert" aria-hidden="true" />
        ) : (
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
              urgent ? 'bg-accent-soft text-accent' : 'text-faint'
            }`}
          >
            {urgent ? '临近' : repeatLabel(todo.repeat)}
          </span>
        )}
      </div>

      <h2 className="mt-2 break-words text-[22px] font-semibold leading-snug text-ink">{todo.title}</h2>

      <p className={`mt-1.5 text-[14px] leading-snug ${overdue ? 'text-alert' : 'text-soft'}`}>
        {formatDeadline(todo.deadline, now)} 截止 · {formatRemaining(remaining)}
      </p>

      <p className="mt-1 text-[11px] text-faint">
        {reminderCount > 0 ? `还有 ${reminderCount} 档提醒` : '提醒已全部发出'}
      </p>

      {/*
       * 三个按钮按优先级分色（用户定的规格）：
       * 「完成这次」是低优先级次要操作 → 暖米色描边的**空心**按钮；
       * 「打开」是中优先级 → 浅蓝灰实底；
       * 更高一级的「新建待办」在卡片外，用 `btn-primary`（深豆绿 `action`）。
       */}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          className="btn h-10 flex-1 !py-0 border border-sand bg-transparent text-sand-deep"
          disabled={busy}
          onClick={() => onDone(todo)}
        >
          {todo.repeat.kind === 'none' ? '完成' : '完成这次'}
        </button>
        <button type="button" className="btn h-10 flex-1 !py-0 bg-info text-white" onClick={() => onOpen(todo)}>
          打开
        </button>
      </div>
    </section>
  );
}
