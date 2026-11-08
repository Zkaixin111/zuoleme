import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatDeadline } from '../shared/format';
import type { RepeatRule, Todo } from '../shared/types';
import { HealthPanel } from './components/HealthPanel';
import { HistoryView } from './components/HistoryView';
import { HomeView } from './components/HomeView';
import { type PinnedTodo } from './components/PinnedCard';
import { TodoEditor } from './components/TodoEditor';
import { api, sortTodos } from './lib/api';
import { remainingReminderCount } from './lib/alarms';
import { decideBack, viewDepth, type View } from './lib/navigation';
import { pickOngoingItem } from './lib/ongoing';
import {
  consumePendingOpen,
  isNativePlatform,
  onBackRequested,
  openNotificationSettings,
  readPermissionState,
  requestNotificationPermission,
  setViewDepth,
  syncAlarms,
  updateOngoing,
  type PermissionSnapshot,
} from './lib/reminder-bridge';
import { useNow } from './lib/useNow';

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
 *
 * 视图只有三个（详情页已删除）：首页 / 编辑页 / 历史任务页。
 * 点待办直接进编辑页 —— 少一次点击，也少一个「只读页」和「编辑页」要同步的负担。
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
  /** 批量选择模式（主页与历史页共用一套状态） */
  const [selectionMode, setSelectionMode] = useState<boolean>(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState<boolean>(false);
  /** 编辑页是否有未保存改动（返回键据此决定是否确认） */
  const [editorDirty, setEditorDirty] = useState<boolean>(false);
  const permissionAsked = useRef<boolean>(false);
  const now = useNow(1000);

  /** 把一批待办落到界面，并同步系统提醒 */
  const applyTodos = useCallback(async (list: readonly Todo[]): Promise<void> => {
    const sorted = sortTodos(list);
    setTodos(sorted);
    // 常驻通知：显示「时间最快截止的下一件事」（不分一次性和重复），规则在 pickOngoingItem 里
    // （见该函数注释：原生只有闹钟列表，不知道哪条已完成 / 没设时间，所以这件事必须由 JS 算）
    void updateOngoing(pickOngoingItem(sorted));
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

  /** 用户点了通知 → 打开对应待办的编辑页（原生侧读一次即清空） */
  const openPendingNotification = useCallback(async (): Promise<void> => {
    const todoId = await consumePendingOpen();
    if (todoId !== null) {
      setView({ kind: 'editor', id: todoId });
    }
  }, []);

  const exitSelection = useCallback((): void => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  /**
   * 统一的「返回」入口：右下角浮动按钮、系统返回手势、编辑页的「取消」都走这里。
   *
   * 判定顺序（选择模式优先）在 `decideBack` 里，可单测。
   */
  const goBack = useCallback((): void => {
    const action = decideBack({ view, selectionMode, editorDirty });
    if (action === 'exit-selection') {
      exitSelection();
      return;
    }
    if (action === 'confirm-leave-editor' && !window.confirm('放弃本次修改？')) {
      return;
    }
    exitSelection();
    setEditorDirty(false);
    setView({ kind: 'home' });
  }, [view, selectionMode, editorDirty, exitSelection]);

  // 换页面时清掉临时状态：选择模式与「未保存改动」都只属于上一个页面
  useEffect(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setEditorDirty(false);
  }, [view.kind]);

  /**
   * 把视图深度上报给原生。
   *
   * 原生 `MainActivity.onBackPressed` 靠这个数字决定「拦下来交给 JS」还是「退出应用」。
   * 首页（depth 0）必须如实上报，否则用户按返回会被一个空动作卡住。
   */
  useEffect(() => {
    void setViewDepth(viewDepth(view));
  }, [view]);

  // 原生回调永远指向「最新的」goBack：用 ref 兜住，避免每次渲染都重新订阅
  const goBackRef = useRef<() => void>(goBack);
  goBackRef.current = goBack;

  /**
   * 订阅系统返回键 / 侧滑手势。
   *
   * 没有这个订阅时，Android 会直接销毁 Activity —— 用户在编辑页按返回就等于退出应用。
   */
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const off = await onBackRequested(() => goBackRef.current());
      if (cancelled) {
        off();
        return;
      }
      unsubscribe = off;
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
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
        // load → applyTodos 里会顺带刷新常驻通知：
        // 前台是唯一允许启动前台服务的时机（后台启动会被 Android 12+ 拒绝）
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
      setView({ kind: 'home' });
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

  /**
   * 编辑页里的「标记完成 / 完成这一次」。
   *
   * 与列表圆圈的区别只有两点：**要二次确认**（编辑页是认真操作的地方，
   * 误触代价更大），以及完成后**回到首页**（这条待办已经不在待办列表里了，
   * 留在编辑页会看到一个已完成的任务）。
   */
  const handleEditorDone = useCallback(
    async (todo: Todo): Promise<void> => {
      const question = todo.repeat.kind === 'none' ? '标记为已完成？' : '完成这一次，并推进到下一次？';
      if (!window.confirm(question)) {
        return;
      }
      await handleToggle(todo);
      setView({ kind: 'home' });
    },
    [handleToggle],
  );

  /** 删除（自带二次确认；编辑页与列表共用这一条路径） */
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

  /** 恢复一条已完成的待办（历史页「恢复」） */
  const handleRestore = useCallback(
    async (todo: Todo): Promise<void> => {
      setBusyId(todo.id);
      try {
        await api.updateTodo(todo.id, { done: false });
        await load();
        setNotice(`「${todo.title}」已恢复到待办列表`);
      } catch (restoreError) {
        setError(restoreError instanceof Error ? restoreError.message : '恢复失败');
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  /** 长按进入选择模式并选中这一条 */
  const handleLongPress = useCallback((todo: Todo): void => {
    setSelectionMode(true);
    setSelectedIds(new Set([todo.id]));
  }, []);

  /** 切换某一条的选中状态 */
  const handleToggleSelection = useCallback((todo: Todo): void => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(todo.id)) {
        next.delete(todo.id);
      } else {
        next.add(todo.id);
      }
      return next;
    });
  }, []);

  /** 当前页面上「看得见」的待办（全选的作用范围） */
  const visibleTodos = useMemo<readonly Todo[]>(
    () => (view.kind === 'history' ? todos.filter((todo) => todo.done) : todos.filter((todo) => !todo.done)),
    [todos, view.kind],
  );

  /** 全选当前页面上的可见项（已经在别处选中的 id 不受影响） */
  const handleSelectAll = useCallback((): void => {
    setSelectedIds(new Set(visibleTodos.map((todo) => todo.id)));
  }, [visibleTodos]);

  /**
   * 批量删除已选项。
   *
   * 逐条 `deleteTodo` 而不是新增批量接口：数据量是几十条级别，
   * 复用单条路径可以保证「删除即取消提醒」这条语义只有一份实现。
   */
  const handleDeleteSelected = useCallback(async (): Promise<void> => {
    const ids = [...selectedIds];
    if (ids.length === 0) {
      return;
    }
    if (!window.confirm(`删除 ${ids.length} 件事？提醒会一起取消。`)) {
      return;
    }
    setDeleting(true);
    try {
      for (const id of ids) {
        await api.deleteTodo(id);
      }
      await load();
      exitSelection();
      setNotice(`已删除 ${ids.length} 件`);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  }, [selectedIds, load, exitSelection]);

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
  /** 已完成总数（「历史任务 · N」入口） */
  const doneCount = useMemo<number>(() => todos.filter((todo) => todo.done).length, [todos]);

  const notificationBlocked = permissions?.supported === true && permissions.notifications === false;
  /** 磁盘上有旧提醒条解析不出来：提醒已经丢了，必须让用户看见 */
  const droppedAlarms = permissions?.droppedAlarmCount ?? 0;

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

      {view.kind === 'editor' ? (
        <TodoEditor
          todo={editingTodo}
          onCancel={goBack}
          onDirtyChange={setEditorDirty}
          onSubmit={(input) => (editingTodo ? handleUpdate(editingTodo.id, input) : handleCreate(input))}
          onDone={editingTodo ? handleEditorDone : undefined}
          onDelete={editingTodo ? handleDelete : undefined}
        />
      ) : null}

      {view.kind === 'history' ? (
        <HistoryView
          todos={todos}
          now={now}
          busyId={busyId}
          selectionMode={selectionMode}
          selectedIds={selectedIds}
          deleting={deleting}
          onBack={goBack}
          onRestore={(todo) => void handleRestore(todo)}
          onLongPress={handleLongPress}
          onToggleSelection={handleToggleSelection}
          onSelectAll={handleSelectAll}
          onCancelSelection={exitSelection}
          onDeleteSelected={() => void handleDeleteSelected()}
        />
      ) : null}

      {view.kind === 'home' ? (
        <HomeView
          todos={todos}
          now={now}
          pinned={pinned}
          pinnedReminderCount={pinnedReminderCount}
          undatedCount={undatedCount}
          loading={loading}
          busyId={busyId}
          doneCount={doneCount}
          selectionMode={selectionMode}
          selectedIds={selectedIds}
          deleting={deleting}
          onCreate={() => setView({ kind: 'editor' })}
          onOpen={(todo) => setView({ kind: 'editor', id: todo.id })}
          onToggle={(todo) => void handleToggle(todo)}
          onLongPress={handleLongPress}
          onToggleSelection={handleToggleSelection}
          onSelectAll={handleSelectAll}
          onCancelSelection={exitSelection}
          onDeleteSelected={() => void handleDeleteSelected()}
          onOpenHistory={() => setView({ kind: 'history' })}
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
