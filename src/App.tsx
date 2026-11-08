import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatDeadline } from '../shared/format';
import type { RepeatRule, Todo } from '../shared/types';
import { DetailView } from './components/DetailView';
import { HealthPanel } from './components/HealthPanel';
import { HomeView } from './components/HomeView';
import { type PinnedTodo } from './components/PinnedCard';
import { TodoEditor } from './components/TodoEditor';
import { api, sortTodos } from './lib/api';
import { remainingReminderCount } from './lib/alarms';
import {
  consumePendingOpen,
  isNativePlatform,
  openNotificationSettings,
  readPermissionState,
  requestNotificationPermission,
  syncAlarms,
  type PermissionSnapshot,
} from './lib/reminder-bridge';
import { useNow } from './lib/useNow';

/** 当前视图（不引路由库，一个 state 足够） */
type View = { kind: 'home' } | { kind: 'detail'; id: string } | { kind: 'editor'; id?: string };

/** 新建/编辑提交的数据 */
interface EditorInput {
  title: string;
  content: string;
  /** null = 用户选择「不设时间」 */
  deadline: number | null;
  advanceReminder: boolean;
  repeat: RepeatRule;
}

/**
 * 应用容器：只负责数据、排程、权限与视图切换。
 *
 * 数据流（全部在本机）：
 *   localStorage ⇄ api（仓储层） → App 状态 → 视图
 *                             ↘ compileAlarmsWithStats → 原生 AlarmManager（静音横幅）
 *
 * 任何一次数据变化都会**全量重排**提醒，不存在「删了待办但提醒还在」的残留。
 */
export default function App(): JSX.Element {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [view, setView] = useState<View>({ kind: 'home' });
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [alarmError, setAlarmError] = useState<string | null>(null);
  const [scheduledCount, setScheduledCount] = useState<number>(0);
  const [truncatedCount, setTruncatedCount] = useState<number>(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<PermissionSnapshot | null>(null);
  const [checkOpen, setCheckOpen] = useState<boolean>(false);
  const [notice, setNotice] = useState<string | null>(null);
  const permissionAsked = useRef<boolean>(false);
  const now = useNow(1000);

  /** 把一批待办落到界面，并同步系统提醒 */
  const applyTodos = useCallback(async (list: readonly Todo[]): Promise<void> => {
    const sorted = sortTodos(list);
    setTodos(sorted);
    const result = await syncAlarms(sorted);
    setScheduledCount(result.scheduled);
    setTruncatedCount(result.truncated);
    setAlarmError(result.ok ? null : result.error);
  }, []);

  /** 从本机存储重新加载并重排提醒 */
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

  /** 重读三项系统授权状态 */
  const refreshPermissions = useCallback(async (): Promise<PermissionSnapshot> => {
    const snapshot = await readPermissionState();
    setPermissions(snapshot);
    return snapshot;
  }, []);

  /** 用户点了通知 → 打开对应详情页（原生侧读一次即清空） */
  const openPendingNotification = useCallback(async (): Promise<void> => {
    const todoId = await consumePendingOpen();
    if (todoId !== null) {
      setView({ kind: 'detail', id: todoId });
    }
  }, []);

  // 首次进入：读本机数据 → 排提醒 → 缺通知权限就主动申请一次（每次冷启动最多一次）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await load();
      void openPendingNotification();
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
        setCheckOpen(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [load, refreshPermissions, openPendingNotification]);

  // 回到前台：重读数据 / 权限，并处理「点通知进来」的情况
  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void load();
        void refreshPermissions();
        void openPendingNotification();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [load, refreshPermissions, openPendingNotification]);

  /** 顶部提示条上的「去允许」 */
  const handleAllowNotifications = useCallback(async (): Promise<void> => {
    setNotice(null);
    await requestNotificationPermission();
    const snapshot = await refreshPermissions();
    if (snapshot.notifications) {
      setNotice('通知权限已允许，提醒会正常弹出。');
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
  const handleCreate = useCallback(
    async (input: EditorInput): Promise<void> => {
      await api.createTodo(input);
      await load();
      setView({ kind: 'home' });
    },
    [load],
  );

  /** 编辑保存 */
  const handleUpdate = useCallback(
    async (id: string, input: EditorInput): Promise<void> => {
      await api.updateTodo(id, {
        title: input.title,
        content: input.content,
        deadline: input.deadline,
        advanceReminder: input.advanceReminder,
        repeat: input.repeat,
      });
      await load();
      setView({ kind: 'detail', id });
    },
    [load],
  );

  /**
   * 完成 / 取消完成。
   *
   * 重复任务的「完成」= 推进到下一次（仓储层负责），所以这里只处理提示文案。
   */
  const handleToggle = useCallback(
    async (todo: Todo): Promise<void> => {
      setBusyId(todo.id);
      try {
        const updated = await api.updateTodo(todo.id, { done: !todo.done });
        await load();
        if (!todo.done && updated.done === false && updated.repeat.kind !== 'none' && updated.deadline !== null) {
          setNotice(`已完成这一次，下次 ${formatDeadline(updated.deadline, Date.now())}`);
        } else if (!todo.done && updated.done === false) {
          setNotice('已完成这一次');
        } else if (updated.done) {
          setNotice('已标记完成');
        } else {
          setNotice(null);
        }
      } catch (toggleError) {
        setError(toggleError instanceof Error ? toggleError.message : '更新失败');
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  /** 删除 */
  const handleDelete = useCallback(
    async (todo: Todo): Promise<void> => {
      if (!window.confirm(`删除「${todo.title}」？它之后的提醒会一起取消。`)) {
        return;
      }
      setBusyId(todo.id);
      try {
        await api.deleteTodo(todo.id);
        await load();
        setView({ kind: 'home' });
      } catch (deleteError) {
        setError(deleteError instanceof Error ? deleteError.message : '删除失败');
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  /** 最近一件**有截止时间**的未完成的事（无期限的没有倒计时可显示） */
  const pinned = useMemo<PinnedTodo | null>(() => {
    const candidate = todos.find((todo) => !todo.done && todo.deadline !== null);
    return candidate === undefined ? null : { ...candidate, deadline: candidate.deadline as number };
  }, [todos]);
  const pinnedReminderCount = useMemo<number>(
    () => (pinned ? remainingReminderCount(pinned, now) : 0),
    [pinned, now],
  );
  /** 未完成且没有截止时间的待办数量（常驻卡空状态提示用） */
  const undatedCount = useMemo<number>(
    () => todos.filter((todo) => !todo.done && todo.deadline === null).length,
    [todos],
  );

  const notificationBlocked = permissions?.supported === true && permissions.notifications === false;
  /** 磁盘上有旧提醒条解析不出来：提醒已经丢了，必须让用户看见 */
  const droppedAlarms = permissions?.droppedAlarmCount ?? 0;

  const activeTodo = view.kind === 'detail' ? todos.find((todo) => todo.id === view.id) ?? null : null;
  const editingTodo = view.kind === 'editor' && view.id ? todos.find((todo) => todo.id === view.id) ?? null : null;

  return (
    <div className="mx-auto min-h-full w-full max-w-md px-4 pt-5">
      {notificationBlocked ? (
        <div
          className="mb-4 rounded-card border border-alert-line bg-alert-soft px-3 py-3"
          role="alert"
          aria-live="assertive"
        >
          <p className="text-[13px] font-medium text-alert">通知未授权，提醒不会弹出</p>
          <p className="mt-1 text-[11px] leading-relaxed text-soft">
            提醒时间到了也不会显示任何东西。请在系统里允许本应用发送通知。
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" className="btn-primary flex-1 !py-2 text-xs" onClick={() => void handleAllowNotifications()}>
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

      {droppedAlarms > 0 ? (
        <div className="mb-4 rounded-card border border-alert-line bg-alert-soft px-3 py-2" role="status">
          <p className="text-[13px] font-medium text-alert">有 {droppedAlarms} 条旧提醒未能恢复</p>
          <p className="mt-1 text-[11px] leading-relaxed text-soft">
            这些提醒的待办如果还在列表里，打开一次应用就会重新排上；否则请重新创建。
          </p>
        </div>
      ) : null}

      {notice ? (
        <div className="mb-4 rounded-card border border-line bg-accent-soft px-3 py-2 text-[11px] leading-relaxed text-accent">
          {notice}
        </div>
      ) : null}

      {error ? (
        <div className="mb-4 rounded-card border border-alert-line bg-alert-soft px-3 py-2 text-[11px] text-alert">
          {error}
        </div>
      ) : null}

      {alarmError ? (
        <div className="mb-4 rounded-card border border-alert-line bg-alert-soft px-3 py-2 text-[11px] leading-relaxed text-alert">
          提醒设置失败：{alarmError}
          <span className="mt-1 block text-soft">请到下方「运行检查」逐项授权后重试。</span>
        </div>
      ) : null}

      {view.kind === 'detail' && activeTodo ? (
        <DetailView
          todo={activeTodo}
          now={now}
          busy={busyId === activeTodo.id}
          onBack={() => setView({ kind: 'home' })}
          onDone={(todo) => void handleToggle(todo)}
          onEdit={(todo) => setView({ kind: 'editor', id: todo.id })}
          onDelete={(todo) => void handleDelete(todo)}
        />
      ) : null}

      {view.kind === 'editor' ? (
        <TodoEditor
          todo={editingTodo}
          onCancel={() =>
            setView(editingTodo ? { kind: 'detail', id: editingTodo.id } : { kind: 'home' })
          }
          onSubmit={(input) =>
            editingTodo ? handleUpdate(editingTodo.id, input) : handleCreate(input)
          }
        />
      ) : null}

      {view.kind === 'home' || (view.kind === 'detail' && activeTodo === null) ? (
        <HomeView
          todos={todos}
          now={now}
          pinned={pinned}
          pinnedReminderCount={pinnedReminderCount}
          undatedCount={undatedCount}
          loading={loading}
          busyId={busyId}
          onCreate={() => setView({ kind: 'editor' })}
          onOpen={(todo) => setView({ kind: 'detail', id: todo.id })}
          onToggle={(todo) => void handleToggle(todo)}
        />
      ) : null}

      {view.kind === 'home' ? (
        <HealthPanel
          scheduledCount={scheduledCount}
          truncatedCount={truncatedCount}
          open={checkOpen}
          onToggle={() => setCheckOpen((value) => !value)}
          onPermissionsChanged={setPermissions}
        />
      ) : null}

      <p className="mt-6 pb-6 text-center text-[11px] leading-relaxed text-faint">
        提醒由手机系统在到点时静音弹出：不联网、不经过服务器，关机重启后也会自动重建。
      </p>
    </div>
  );
}
