import { formatDeadline, formatRemaining } from '../../shared/format';
import { repeatLabel } from '../../shared/repeat';
import type { Todo } from '../../shared/types';

export interface TodoRowProps {
  todo: Todo;
  now: number;
  busy: boolean;
  /** 点左侧圆圈：直接完成，不进详情 */
  onToggle: (todo: Todo) => void;
  /** 点整行：进详情 */
  onOpen: (todo: Todo) => void;
}

/**
 * 列表里的一行。
 *
 * 左侧圆圈是「完成」的快捷入口，点它不会进详情页；
 * 点整行其它区域才进详情。这样列表可以当清单用，不必每次都点进去。
 *
 * 第二行的拼接顺序：时间 →（重复）→（仅到点提醒）→ 状态。
 * **逾期文案不在这里加前缀**：`formatRemaining` 负区间已经返回「已逾期 40 分钟」，
 * 外面再拼一个「逾期」就会出现「逾期 已逾期」。
 */
export function TodoRow({ todo, now, busy, onToggle, onOpen }: TodoRowProps): JSX.Element {
  const hasDeadline = todo.deadline !== null;
  const remaining = todo.deadline === null ? 0 : todo.deadline - now;
  const overdue = !todo.done && hasDeadline && remaining <= 0;

  const metaParts: string[] = [hasDeadline ? formatDeadline(todo.deadline as number, now) : '无期限'];
  if (todo.repeat.kind !== 'none') {
    metaParts.push(repeatLabel(todo.repeat));
  }
  if (hasDeadline && !todo.advanceReminder) {
    metaParts.push('仅到点提醒');
  }
  if (todo.done) {
    metaParts.push('已完成');
  } else if (hasDeadline) {
    metaParts.push(formatRemaining(remaining));
  }

  return (
    <li className="flex items-start gap-3 border-b border-line px-1 py-3 last:border-b-0">
      <button
        type="button"
        disabled={busy}
        onClick={() => onToggle(todo)}
        aria-label={todo.done ? `取消完成：${todo.title}` : `完成：${todo.title}`}
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[13px] leading-none ${
          todo.done ? 'border-accent bg-accent text-white' : 'border-line-strong bg-surface text-transparent'
        } ${busy ? 'opacity-40' : ''}`}
      >
        ✓
      </button>

      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(todo)}>
        <p className={`break-words text-[13px] leading-snug ${todo.done ? 'text-faint line-through' : 'text-ink'}`}>
          {todo.title}
        </p>
        <p className={`mt-1 text-xs ${overdue ? 'text-alert' : 'text-faint'}`}>{metaParts.join(' · ')}</p>
      </button>
    </li>
  );
}
