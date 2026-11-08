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

/**
 * 一行历史记录。
 *
 * **整行点击不做任何事**，只有右侧「恢复」按钮可点（选择模式下点行 = 切换选中）。
 * 理由：主页里点整行是「进编辑」，历史页里点整行如果变成「恢复」，同一个手势在两个
 * 页面做语义完全不同的事，而且恢复出来的待办会突然出现在主页列表里 ——
 * 用户不理解发生了什么。一个动作要么有明确的视觉提示（按钮），要么不要。
 */
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

  const title = <p className="break-words text-[13px] leading-snug text-faint line-through">{todo.title}</p>;
  const meta = (
    <p className="mt-1 text-xs text-faint">
      {completedText}
      {deadlineText}
    </p>
  );

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

      {selectionMode ? (
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          aria-pressed={selected}
          aria-label={`${selected ? '取消选择' : '选择'}：${todo.title}`}
          onClick={() => {
            if (press.consumeClick()) {
              return;
            }
            onToggleSelection(todo);
          }}
        >
          {title}
          {meta}
        </button>
      ) : (
        // 非选择模式：整行只是文字，不做任何动作（唯一可点是右侧「恢复」）
        <div className="min-w-0 flex-1">
          {title}
          {meta}
        </div>
      )}

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
