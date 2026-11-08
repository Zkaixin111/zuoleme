import { formatRemaining } from '../../shared/format';
import type { Todo } from '../../shared/types';
import { groupTodos } from '../lib/group-todos';
import { PinnedCard, type PinnedTodo } from './PinnedCard';
import { SelectionFooter, SelectionHeader } from './SelectionToolbar';
import { TodoRow } from './TodoRow';

export interface HomeViewProps {
  /** 全部待办（主页只显示未完成的，已完成的进历史页） */
  todos: Todo[];
  now: number;
  /** 最近一件有截止时间的未完成事项 */
  pinned: PinnedTodo | null;
  /** 常驻卡片上的「还有几档提醒」 */
  pinnedReminderCount: number;
  /** 未完成且没有截止时间的事项数量（空状态提示用） */
  undatedCount: number;
  loading: boolean;
  busyId: string | null;
  /** 已完成总数（「历史任务 · N」入口上的数字） */
  doneCount: number;
  selectionMode: boolean;
  selectedIds: ReadonlySet<string>;
  deleting: boolean;
  onCreate: () => void;
  onOpen: (todo: Todo) => void;
  onToggle: (todo: Todo) => void;
  onLongPress: (todo: Todo) => void;
  onToggleSelection: (todo: Todo) => void;
  onSelectAll: () => void;
  onCancelSelection: () => void;
  onDeleteSelected: () => void;
  onOpenHistory: () => void;
}

/** 「11月8日 周日」 */
function formatTodayHeader(now: number): string {
  const date = new Date(now);
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `${date.getMonth() + 1}月${date.getDate()}日 ${weekdays[date.getDay()]}`;
}

/**
 * 首页：日期 + 常驻卡 + 未完成的分组列表 + 历史入口。
 *
 * **只渲染未完成的待办**：完成的事落到「历史任务」页，
 * 否则做主清单时会被已完成项干扰（尤其是「以后」组会越堆越长）。
 */
export function HomeView({
  todos,
  now,
  pinned,
  pinnedReminderCount,
  undatedCount,
  loading,
  busyId,
  doneCount,
  selectionMode,
  selectedIds,
  deleting,
  onCreate,
  onOpen,
  onToggle,
  onLongPress,
  onToggleSelection,
  onSelectAll,
  onCancelSelection,
  onDeleteSelected,
  onOpenHistory,
}: HomeViewProps): JSX.Element {
  const pending = todos.filter((todo) => !todo.done);
  const groups = groupTodos(pending, now);

  return (
    <div className={selectionMode ? 'pb-32' : 'pb-28'}>
      <header className="mb-5 flex items-end justify-between px-1">
        <div>
          <p className="text-xs text-faint">{formatTodayHeader(now)}</p>
          <h1 className="mt-1 text-[26px] font-semibold leading-none text-ink">今天</h1>
        </div>
        <p className="text-xs text-soft">{pending.length} 件待办</p>
      </header>

      {selectionMode ? (
        <SelectionHeader
          count={selectedIds.size}
          total={pending.length}
          onSelectAll={onSelectAll}
          onCancel={onCancelSelection}
        />
      ) : null}

      {selectionMode ? null : (
        <PinnedCard
          todo={pinned}
          now={now}
          reminderCount={pinnedReminderCount}
          undatedCount={undatedCount}
          busy={busyId === pinned?.id}
          onDone={onToggle}
          onOpen={onOpen}
          onCreate={onCreate}
        />
      )}

      <div className="mt-6">
        {loading && pending.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm text-faint">正在读取本机数据</p>
        ) : null}

        {!loading && pending.length === 0 ? (
          <p className="card px-4 py-6 text-center text-sm leading-relaxed text-soft">
            还没有待办。点下面的按钮加一件，写上标题、内容和截止时间。
          </p>
        ) : null}

        {groups.map((group) => (
          <section key={group.key} className="mb-5">
            <div className="mb-1 flex items-center justify-between px-1">
              <h2 className={`text-[13px] font-medium ${group.key === 'overdue' ? 'text-alert' : 'text-soft'}`}>
                {group.label}
              </h2>
              <span className="text-[11px] text-faint">{group.todos.length}</span>
            </div>
            <ul className="card px-1 py-1">
              {group.todos.map((todo) => (
                <TodoRow
                  key={todo.id}
                  todo={todo}
                  now={now}
                  busy={busyId === todo.id}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(todo.id)}
                  onToggle={onToggle}
                  onOpen={onOpen}
                  onLongPress={onLongPress}
                  onToggleSelection={onToggleSelection}
                />
              ))}
            </ul>
          </section>
        ))}

        {pinned ? (
          <p className="px-1 text-[11px] leading-relaxed text-faint">
            最近一件事还剩 {formatRemaining(pinned.deadline - now)}，
            {pinned.advanceReminder ? '到期前会按档位静音提醒。' : '只在到点那一刻静音提醒一次。'}
          </p>
        ) : null}
      </div>

      {selectionMode ? (
        <SelectionFooter count={selectedIds.size} onDelete={onDeleteSelected} busy={deleting} />
      ) : (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 mx-auto max-w-md px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            className="pointer-events-auto mb-2 flex h-11 w-full items-center justify-center rounded-control border border-line bg-surface text-[13px] text-soft"
            onClick={onOpenHistory}
          >
            历史任务 · {doneCount}
          </button>
          <button type="button" className="btn-primary pointer-events-auto w-full" onClick={onCreate}>
            新建待办
          </button>
        </div>
      )}
    </div>
  );
}
