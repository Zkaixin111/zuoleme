import { formatDeadline, formatRemaining } from '../../shared/format';
import { repeatLabel } from '../../shared/repeat';
import type { Todo } from '../../shared/types';
import { useLongPress } from '../lib/use-long-press';

export interface TodoRowProps {
  todo: Todo;
  now: number;
  busy: boolean;
  /** 处于批量选择模式 */
  selectionMode: boolean;
  /** 这一行是否被选中 */
  selected: boolean;
  /** 点左侧圆圈：直接完成（选择模式下 = 切换选中） */
  onToggle: (todo: Todo) => void;
  /** 点整行：进编辑页（选择模式下 = 切换选中） */
  onOpen: (todo: Todo) => void;
  /** 长按整行：进入选择模式并选中这一行 */
  onLongPress: (todo: Todo) => void;
  /** 切换选中状态 */
  onToggleSelection: (todo: Todo) => void;
}

/**
 * 列表里的一行。
 *
 * 交互矩阵（三条路径互不打架）：
 * - **单击圆圈** → 直接完成 / 取消完成，不进编辑页（列表可以当清单用）；
 * - **单击整行** → 进编辑页（详情页已删除，编辑页是唯一入口）；
 * - **长按整行** → 进入批量选择模式。
 *
 * 长按之后浏览器还会补发一次 `click`，所以两个 `onClick` 都以
 * `press.consumeClick()` 开场：刚触发过长按就直接返回，否则长按会立刻被
 * 「点击进编辑」覆盖，表现为「长按没反应」。
 *
 * 第二行的拼接顺序：时间 →（重复）→（仅到点提醒）→ 状态。
 * **逾期文案不在这里加前缀**：`formatRemaining` 负区间已经返回「已逾期 40 分钟」，
 * 外面再拼一个「逾期」就会出现「逾期 已逾期」。
 */
export function TodoRow({
  todo,
  now,
  busy,
  selectionMode,
  selected,
  onToggle,
  onOpen,
  onLongPress,
  onToggleSelection,
}: TodoRowProps): JSX.Element {
  const press = useLongPress(() => onLongPress(todo));

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

  const circleClass = selectionMode
    ? selected
      ? 'border-accent bg-accent text-white'
      : 'border-line-strong bg-surface text-transparent'
    : todo.done
      ? 'border-accent bg-accent text-white'
      : 'border-line-strong bg-surface text-transparent';

  return (
    <li
      {...press.handlers}
      className={`flex items-start gap-3 border-b border-line px-2 py-3 last:border-b-0 ${
        selected ? 'bg-accent-soft' : ''
      }`}
    >
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (press.consumeClick()) {
            return;
          }
          if (selectionMode) {
            onToggleSelection(todo);
            return;
          }
          onToggle(todo);
        }}
        aria-label={
          selectionMode
            ? `${selected ? '取消选择' : '选择'}：${todo.title}`
            : todo.done
              ? `取消完成：${todo.title}`
              : `完成：${todo.title}`
        }
        aria-pressed={selectionMode ? selected : todo.done}
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[13px] leading-none ${circleClass} ${
          busy ? 'opacity-40' : ''
        }`}
      >
        ✓
      </button>

      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={() => {
          if (press.consumeClick()) {
            return;
          }
          if (selectionMode) {
            onToggleSelection(todo);
            return;
          }
          onOpen(todo);
        }}
      >
        <p className={`break-words text-[13px] leading-snug ${todo.done ? 'text-faint line-through' : 'text-ink'}`}>
          {todo.title}
        </p>
        <p className={`mt-1 text-xs ${overdue ? 'text-alert' : 'text-faint'}`}>{metaParts.join(' · ')}</p>
      </button>
    </li>
  );
}
