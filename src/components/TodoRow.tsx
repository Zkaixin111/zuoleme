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
 */
export function TodoRow({ todo, now, busy, onToggle, onOpen }: TodoRowProps): JSX.Element {
  const remaining = todo.deadline - now;
  const overdue = !todo.done && remaining <= 0;
  const repeatText = todo.repeat.kind === 'none' ? '' : ` · ${repeatLabel(todo.repeat)}`;
  const timeText = formatDeadline(todo.deadline, now);
  const statusText = todo.done ? '已完成' : overdue ? `逾期 ${formatRemaining(-remaining)}` : formatRemaining(remaining);

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
        <p className={`mt-1 text-xs ${overdue ? 'text-alert' : 'text-faint'}`}>
          {timeText}
          {repeatText} · {statusText}
        </p>
      </button>
    </li>
  );
}
