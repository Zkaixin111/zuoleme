import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { earliestFireAt, planReminders } from '../shared/reminders';
import type { Todo } from '../shared/types';
import { AddTodoPanel } from './components/AddTodoPanel';
import { HealthPanel } from './components/HealthPanel';
import { PinnedCard } from './components/PinnedCard';
import { TodoList } from './components/TodoList';
import { api, sortTodos } from './lib/api';
import {
  isNativePlatform,
  openNotificationSettings,
  readPermissionState,
  requestNotificationPermission,
  syncAlarms,
  type PermissionSnapshot,
} from './lib/reminder-bridge';
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
 *
 * 通知权限是这个应用的生命线：没有通知权限，闹钟照样触发但系统会把通知丢掉，
 * 用户看到的就是「什么都没发生」。所以首次冷启动会主动申请一次，
 * 被拒后立刻用红色提示条 + 自动展开的运行检查面板把问题摆到用户眼前。
 */
export default function App(): JSX.Element {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [alarmError, setAlarmError] = useState<string | null>(null);
  const [scheduledCount, setScheduledCount] = useState<number>(0);
  const [addOpen, setAddOpen] = useState<boolean>(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<PermissionSnapshot | null>(null);
  const [checkOpen, setCheckOpen] = useState<boolean>(false);
  const [notice, setNotice] = useState<string | null>(null);
  const permissionAsked = useRef<boolean>(false);
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

  /** 重读三项系统授权状态（浏览器环境下 supported=false，永远不会误报） */
  const refreshPermissions = useCallback(async (): Promise<PermissionSnapshot> => {
    const snapshot = await readPermissionState();
    setPermissions(snapshot);
    return snapshot;
  }, []);

  // 首次进入：读本机数据 → 排钟 → 缺通知权限就主动申请一次（每次冷启动最多一次）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await load();
      if (cancelled || permissionAsked.current || !isNativePlatform()) {
        return;
      }
      const snapshot = await refreshPermissions();
      if (cancelled || !snapshot.supported || snapshot.notifications) {
        return;
      }

      permissionAsked.current = true;
      await requestNotificationPermission();
      if (cancelled) {
        return;
      }
      const after = await refreshPermissions();
      if (!after.notifications) {
        // 被拒：把问题摆到明面上，而不是让用户等到「到点没有提醒」才发现
        setCheckOpen(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [load, refreshPermissions]);

  // 回到前台时重新读一次：用户可能刚在系统设置里授权，或改过系统时间
  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void load();
        void refreshPermissions();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [load, refreshPermissions]);

  /** 顶部提示条上的「去允许」 */
  const handleAllowNotifications = useCallback(async (): Promise<void> => {
    setNotice(null);
    await requestNotificationPermission();
    const snapshot = await refreshPermissions();
    if (snapshot.notifications) {
      setNotice('通知权限已允许，六档提醒会正常弹出。');
    } else {
      setCheckOpen(true);
      setNotice('仍未允许通知：系统不会再弹授权框，请点「去系统设置」手动打开。');
    }
  }, [refreshPermissions]);

  /** 顶部提示条上的「去系统设置」 */
  const handleOpenNotificationSettings = useCallback(async (): Promise<void> => {
    await openNotificationSettings();
  }, []);

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
  // 只在「原生环境 + 明确读到了状态 + 确实没授权」时报警，浏览器环境不会误报
  const notificationBlocked = permissions?.supported === true && permissions.notifications === false;

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

      {notificationBlocked ? (
        <div
          className="mb-4 rounded-xl bg-red-500/15 px-3 py-3 ring-1 ring-red-500/40"
          role="alert"
          aria-live="assertive"
        >
          <p className="flex items-center gap-2 text-sm font-semibold text-red-200">
            <span aria-hidden="true">⚠</span> 通知未授权，六档提醒不会响
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-red-200/70">
            系统闹钟会按时触发，但没有通知权限时通知会被直接丢弃 —— 你什么都看不到。
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="btn-primary flex-1 !py-2 text-xs"
              onClick={() => void handleAllowNotifications()}
            >
              去允许
            </button>
            <button
              type="button"
              className="btn-ghost flex-1 !py-2 text-xs"
              onClick={() => void handleOpenNotificationSettings()}
            >
              去系统设置
            </button>
          </div>
        </div>
      ) : null}

      {notice ? (
        <div className="mb-4 rounded-xl bg-brand-500/10 px-3 py-2 text-xs leading-relaxed text-brand-300">
          {notice}
        </div>
      ) : null}

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

      <HealthPanel
        scheduledCount={scheduledCount}
        open={checkOpen}
        onToggle={() => setCheckOpen((value) => !value)}
        onPermissionsChanged={setPermissions}
      />

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
