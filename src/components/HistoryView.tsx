import { formatDeadline } from '../../shared/format';
import type { Todo } from '../../shared/types';
import { formatCompletedAt, sortCompleted } from '../lib/history';
import { useLongPress } from '../lib/use-long-press';
import { FloatingBack } from './FloatingBack';
import { SelectionFooter, SelectionHeader } from './SelectionToolbar';

export interface HistoryViewProps {
  todos: Todo[];
  now: number;
  busyId: string | null;
  selectionMode: boolean;
  selectedIds: ReadonlySet<string>;
  deleting: boolean;
  onBack: () => void;
  /** 恢复到主页（done = false） */
  onRestore: (todo: Todo) => void;
  onLongPress: (todo: Todo) => void;
  onToggleSelection: (todo: Todo) => void;
  onSelectAll: () => void;
  onCancelSelection: () => void;
  onDeleteSelected: () => void;
}

/** 一行历史记录 */
function HistoryRow({
  todo,
  now,
  selectionMode,
  selected,
  onRestore,
  onLongPress,
  onToggleSelection,
}: {
  todo: Todo;
  now: number;
  selectionMode: boolean;
  selected: boolean;
  onRestore: (todo: Todo) => void;
  onLongPress: (todo: Todo) => void;
  onToggleSelection: (todo: Todo) => void;
}): JSX.Element {
  const press = useLongPress(() => onLongPress(todo));

  const completedText = todo.completedAt === null ? '已完成' : `完成于 ${formatCompletedAt(todo.completedAt, now)}`;
  const deadlineText = todo.deadline === null ? '' : ` · 原定 ${formatDeadline(todo.deadline, now)}`;

  return (
    <li
      {...press.handlers}
      className={`flex items-start gap-3 border-b border-line px-2 py-3 last:border-b-0 ${
        selected ? 'bg-accent-soft' : ''
      }`}
    >
      {selectionMode ? (
        <span
          aria-hidden="true"
          className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[13px] leading-none ${
            selected ? 'border-accent bg-accent text-white' : 'border-line-strong bg-surface text-transparent'
          }`}
        >
          ✓
        </span>
      ) : null}

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
          onRestore(todo);
        }}
      >
        <p className="break-words text-[13px] leading-snug text-faint line-through">{todo.title}</p>
        <p className="mt-1 text-xs text-faint">
          {completedText}
          {deadlineText}
        </p>
      </button>

      {selectionMode ? null : (
        <button
          type="button"
          className="mt-0.5 shrink-0 text-[13px] text-accent"
          onClick={() => {
            if (press.consumeClick()) {
              return;
            }
            onRestore(todo);
          }}
        >
          恢复
        </button>
      )}
    </li>
  );
}

/**
 * 历史任务页：已完成的待办，按完成时间倒序。
 *
 * 支持长按进入批量选择后删除 —— 与主页共用 `useLongPress` 与 `SelectionToolbar`，
 * 避免出现「主页能批量删、历史页不能」这种两套实现的不一致。
 */
export function HistoryView({
  todos,
  now,
  busyId,
  selectionMode,
  selectedIds,
  deleting,
  onBack,
  onRestore,
  onLongPress,
  onToggleSelection,
  onSelectAll,
  onCancelSelection,
  onDeleteSelected,
}: HistoryViewProps): JSX.Element {
  const completed = sortCompleted(todos.filter((todo) => todo.done));

  return (
    <div className={selectionMode ? 'pb-32' : 'pb-40'}>
      <header className="mb-5 flex items-end justify-between px-1">
        <h1 className="text-[22px] font-semibold leading-none text-ink">历史任务</h1>
        <p className="text-xs text-soft">{completed.length} 件</p>
      </header>

      {selectionMode ? (
        <SelectionHeader
          count={selectedIds.size}
          total={completed.length}
          onSelectAll={onSelectAll}
          onCancel={onCancelSelection}
        />
      ) : null}

      {completed.length === 0 ? (
        <p className="card px-4 py-6 text-center text-sm leading-relaxed text-soft">还没有完成的任务</p>
      ) : (
        <ul className="card px-1 py-1">
          {completed.map((todo) => (
            <HistoryRow
              key={todo.id}
              todo={todo}
              now={now}
              selectionMode={selectionMode}
              selected={selectedIds.has(todo.id)}
              onRestore={onRestore}
              onLongPress={onLongPress}
              onToggleSelection={onToggleSelection}
            />
          ))}
        </ul>
      )}

      {busyId !== null ? <p className="mt-3 px-1 text-[11px] text-faint">处理中…</p> : null}

      {selectionMode ? (
        <SelectionFooter count={selectedIds.size} onDelete={onDeleteSelected} busy={deleting} />
      ) : (
        <FloatingBack onBack={onBack} />
      )}
    </div>
  );
}
