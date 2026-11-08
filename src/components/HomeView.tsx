import { formatRemaining } from '../../shared/format';
import { groupTodos } from '../lib/group-todos';
import type { Todo } from '../../shared/types';
import { PinnedCard, type PinnedTodo } from './PinnedCard';
import { TodoRow } from './TodoRow';

export interface HomeViewProps {
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
  onCreate: () => void;
  onOpen: (todo: Todo) => void;
  onToggle: (todo: Todo) => void;
}

/** 「11月8日 周日」 */
function formatTodayHeader(now: number): string {
  const date = new Date(now);
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `${date.getMonth() + 1}月${date.getDate()}日 ${weekdays[date.getDay()]}`;
}

/**
 * 首页：日期 + 常驻卡 + 分组列表。
 */
export function HomeView({
  todos,
  now,
  pinned,
  pinnedReminderCount,
  undatedCount,
  loading,
  busyId,
  onCreate,
  onOpen,
  onToggle,
}: HomeViewProps): JSX.Element {
  const groups = groupTodos(todos, now);
  const pendingCount = todos.filter((todo) => !todo.done).length;

  return (
    <div className="pb-28">
      <header className="mb-5 flex items-end justify-between px-1">
        <div>
          <p className="text-xs text-faint">{formatTodayHeader(now)}</p>
          <h1 className="mt-1 text-[26px] font-semibold leading-none text-ink">今天</h1>
        </div>
        <p className="text-xs text-soft">{pendingCount} 件待办</p>
      </header>

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

      <div className="mt-6">
        {loading && todos.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm text-faint">正在读取本机数据</p>
        ) : null}

        {!loading && todos.length === 0 ? (
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
            <ul className="card px-3 py-1">
              {group.todos.map((todo) => (
                <TodoRow
                  key={todo.id}
                  todo={todo}
                  now={now}
                  busy={busyId === todo.id}
                  onToggle={onToggle}
                  onOpen={onOpen}
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

      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 mx-auto max-w-md px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <button type="button" className="btn-primary pointer-events-auto w-full" onClick={onCreate}>
          新建待办
        </button>
      </div>
    </div>
  );
}
