import { formatDeadline, formatRemaining } from '../../shared/format';
import type { Todo } from '../../shared/types';

export interface TodoListProps {
  todos: Todo[];
  /** 当前时间（每秒推进） */
  now: number;
  /** 正在提交的待办 id */
  busyId: string | null;
  /** 加载中 */
  loading: boolean;
  onToggle: (todo: Todo) => void;
  onDelete: (todo: Todo) => void;
}

/**
 * 待办列表：未完成在前、按截止时间升序（顺序由后端保证）。
 */
export function TodoList({ todos, now, busyId, loading, onToggle, onDelete }: TodoListProps): JSX.Element {
  if (loading && todos.length === 0) {
    return <p className="px-1 py-6 text-center text-sm text-ink-500">加载中…</p>;
  }

  if (todos.length === 0) {
    return <p className="px-1 py-6 text-center text-sm text-ink-500">还没有待办。点下面的按钮新建一条。</p>;
  }

  const pendingCount = todos.filter((todo) => !todo.done).length;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between px-1">
        <h3 className="text-sm font-medium text-ink-300">全部待办</h3>
        <span className="text-xs text-ink-500">
          待完成 {pendingCount} / 共 {todos.length}
        </span>
      </div>

      <ul className="space-y-2">
        {todos.map((todo) => {
          const remaining = todo.deadline - now;
          const busy = busyId === todo.id;
          return (
            <li
              key={todo.id}
              className={`card flex items-start gap-3 p-3 transition ${todo.done ? 'opacity-55' : ''}`}
            >
              <button
                type="button"
                disabled={busy}
                onClick={() => onToggle(todo)}
                aria-label={todo.done ? `取消完成：${todo.title}` : `标记完成：${todo.title}`}
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${
                  todo.done
                    ? 'border-brand-500 bg-brand-600 text-white'
                    : 'border-white/25 text-transparent hover:border-brand-400'
                } ${busy ? 'opacity-50' : ''}`}
              >
                ✓
              </button>

              <div className="min-w-0 flex-1">
                <p className={`break-words text-[15px] leading-snug ${todo.done ? 'line-through text-ink-500' : 'text-white'}`}>
                  {todo.title}
                </p>
                <p className="mt-1 text-xs text-ink-500">
                  {formatDeadline(todo.deadline, now)} ·{' '}
                  <span className={!todo.done && remaining <= 0 ? 'text-red-300' : undefined}>
                    {todo.done ? '已完成' : formatRemaining(remaining)}
                  </span>
                </p>
              </div>

              <button
                type="button"
                disabled={busy}
                onClick={() => onDelete(todo)}
                aria-label={`删除：${todo.title}`}
                className="shrink-0 rounded-lg px-2 py-1 text-xs text-ink-500 transition hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"
              >
                删除
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
