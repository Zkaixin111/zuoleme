import { useCallback, useEffect, useMemo, useState } from 'react';
import { earliestFireAt, planReminders } from '../shared/reminders';
import type { Todo } from '../shared/types';
import { AddTodoPanel } from './components/AddTodoPanel';
import { HealthPanel } from './components/HealthPanel';
import { PinnedCard } from './components/PinnedCard';
import { TodoList } from './components/TodoList';
import { api, sortTodos } from './lib/api';
import { isNativePlatform, syncAlarms } from './lib/reminder-bridge';
import { useNow } from './lib/useNow';

/**
 * 应用主界面：常驻卡片 + 列表 + 新建面板 + 运行检查。
 *
 * 数据流（全部在本机）：
 *   localStorage ⇄ api（仓储层） → App 状态 → 渲染
 *                             ↘ compileAlarms → 原生 AlarmManager
 *
 * 任何一次数据变化（新建 / 完成 / 删除）都会**全量重排**系统闹钟，
 * 这样不存在「删了待办但闹钟还在」的残留问题。
 */
export default function App(): JSX.Element {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [alarmError, setAlarmError] = useState<string | null>(null);
  const [scheduledCount, setScheduledCount] = useState<number>(0);
  const [addOpen, setAddOpen] = useState<boolean>(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const now = useNow(1000);

  /**
   * 把一批待办落到界面，并同步系统闹钟。
   *
   * @param list 最新的待办全集
   */
  const applyTodos = useCallback(async (list: readonly Todo[]): Promise<void> => {
    const sorted = sortTodos(list);
    setTodos(sorted);
    const result = await syncAlarms(sorted);
    setScheduledCount(result.scheduled);
    setAlarmError(result.ok ? null : result.error);
  }, []);

  /** 从本机存储重新加载并重排闹钟 */
  const load = useCallback(async (): Promise<void> => {
    try {
      const list = await api.listTodos();
      await applyTodos(list);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '读取本机数据失败');
    } finally {
      setLoading(false);
    }
  }, [applyTodos]);

  // 首次进入：读本机数据 + 排钟
  useEffect(() => {
    void load();
  }, [load]);

  // 回到前台时重新读一次并重排：用户可能刚在系统设置里授权，或改过系统时间
  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void load();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [load]);

  /** 新建 */
  const handleCreate = async (input: { title: string; deadline: number }): Promise<void> => {
    await api.createTodo(input);
    setAddOpen(false);
    await load();
  };

  /** 勾选完成 / 取消完成 */
  const handleToggle = async (todo: Todo): Promise<void> => {
    setBusyId(todo.id);
    try {
      await api.updateTodo(todo.id, { done: !todo.done });
      await load();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : '更新失败');
    } finally {
      setBusyId(null);
    }
  };

  /** 常驻卡片上的「完成」 */
  const handlePinDone = async (todo: Todo): Promise<void> => {
    await handleToggle(todo);
  };

  /** 删除 */
  const handleDelete = async (todo: Todo): Promise<void> => {
    if (!window.confirm(`删除「${todo.title}」？该事项的提醒会一起取消。`)) {
      return;
    }
    setBusyId(todo.id);
    try {
      await api.deleteTodo(todo.id);
      await load();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除失败');
    } finally {
      setBusyId(null);
    }
  };

  /** 最近一件未完成的事（列表已按截止时间升序，取第一条即可） */
  const pinned = useMemo<Todo | null>(() => todos.find((todo) => !todo.done) ?? null, [todos]);

  /** 常驻卡片展示的「下次提醒」：由纯函数现算，不持久化 */
  const pinnedNextFireAt = useMemo<number | null>(() => {
    if (!pinned) {
      return null;
    }
    return earliestFireAt(planReminders(pinned.deadline, now));
  }, [pinned, now]);

  const native = isNativePlatform();

  return (
    <div className="mx-auto flex min-h-full w-full max-w-md flex-col px-4 pb-24 pt-6">
      <header className="mb-4 flex items-center justify-between px-1">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">做了么</h1>
          <p className="mt-0.5 text-xs text-ink-500">六档提醒，不漏事。</p>
        </div>
        <span className="rounded-full bg-white/5 px-3 py-1 text-[11px] text-ink-500">
          {native ? '本机版' : '浏览器'}
        </span>
      </header>

      {error ? (
        <div className="mb-4 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>
      ) : null}

      {alarmError ? (
        <div className="mb-4 rounded-xl bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-300">
          系统闹钟设置失败：{alarmError}
          <span className="mt-1 block text-amber-200/70">请到下方「运行检查」逐项授权后重试。</span>
        </div>
      ) : null}

      <PinnedCard
        todo={pinned}
        now={now}
        nextFireAt={pinnedNextFireAt}
        busy={busyId === pinned?.id}
        onDone={(todo) => void handlePinDone(todo)}
        onCreate={() => setAddOpen(true)}
      />

      <div className="mt-6">
        <TodoList
          todos={todos}
          now={now}
          busyId={busyId}
          loading={loading}
          onToggle={(todo) => void handleToggle(todo)}
          onDelete={(todo) => void handleDelete(todo)}
        />
      </div>

      <HealthPanel scheduledCount={scheduledCount} />

      <p className="mt-6 px-1 text-center text-[11px] leading-relaxed text-ink-500">
        提醒由手机系统闹钟在到点时直接弹出：不联网、不经过服务器，关机重启后也会自动重建。
      </p>

      {/* 底部固定新建按钮 */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 mx-auto max-w-md px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          className="btn-primary pointer-events-auto w-full shadow-card"
          onClick={() => setAddOpen(true)}
        >
          + 新建待办
        </button>
      </div>

      <AddTodoPanel open={addOpen} onClose={() => setAddOpen(false)} onSubmit={handleCreate} />
    </div>
  );
}
