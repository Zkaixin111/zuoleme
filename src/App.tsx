import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SwClientMessage, Todo } from '../shared/types';
import { AddTodoPanel } from './components/AddTodoPanel';
import { ConfirmDialog } from './components/ConfirmDialog';
import { PinnedCard } from './components/PinnedCard';
import { SettingsPanel } from './components/SettingsPanel';
import { TodoList } from './components/TodoList';
import { api, getToken, setToken } from './lib/api';
import { ensurePushSubscriptionSynced } from './lib/push';
import { useNow } from './lib/useNow';

/** 待确认的操作（完成 / 删除都走应用内中文弹窗，不再用浏览器原生 confirm） */
type PendingConfirm = { action: 'complete' | 'delete'; todo: Todo };

/** 前台时列表刷新间隔（推送到达/切回前台也会刷新） */
const POLL_INTERVAL_MS = 30_000;

/** 服务端已按「未完成在前、截止升序」排序，这里再做一次兜底排序 */
function sortTodos(todos: Todo[]): Todo[] {
  return [...todos].sort((a, b) => {
    if (a.done !== b.done) {
      return a.done ? 1 : -1;
    }
    if (a.deadline !== b.deadline) {
      return a.deadline - b.deadline;
    }
    return a.createdAt - b.createdAt;
  });
}

/**
 * 应用主界面：常驻卡片 + 列表 + 新建面板 + 设置。
 */
export default function App(): JSX.Element {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [token, setTokenState] = useState<string>(() => getToken());
  const [addOpen, setAddOpen] = useState<boolean>(false);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const now = useNow(1000);

  /** 拉取列表 */
  const refresh = useCallback(async (): Promise<void> => {
    if (getToken().length === 0) {
      setTodos([]);
      setLoading(false);
      return;
    }
    try {
      const list = await api.listTodos();
      setTodos(sortTodos(list));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // token 变化后重新加载
  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh, token]);

  // 轮询 + 切回前台刷新
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    }, POLL_INTERVAL_MS);

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refresh]);

  // 打开应用 / 切回前台时自检推送订阅：浏览器轮换订阅、或后端订阅已被清理时自动修复，
  // 避免出现「设置里显示已开启、实际再也收不到通知」。失败只打日志，不弹错误打扰用户。
  useEffect(() => {
    if (token.length === 0) {
      return;
    }
    const sync = (): void => {
      void ensurePushSubscriptionSynced().catch((syncError: unknown) => {
        console.warn('[push] 订阅自检同步失败，下次打开应用时重试', syncError);
      });
    };
    sync();
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        sync();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [token]);

  // 监听 Service Worker 通知点击
  useEffect(() => {
    if (!('serviceWorker' in navigator)) {
      return;
    }
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as SwClientMessage | undefined;
      if (data?.type === 'notification-clicked' || data?.type === 'todo-completed') {
        void refresh();
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [refresh]);

  /** 新建 */
  const handleCreate = async (input: { title: string; deadline: number }): Promise<void> => {
    await api.createTodo(input);
    await refresh();
    setAddOpen(false);
  };

  /** 实际执行完成状态切换（确认弹窗点「确认完成」后，或取消完成时直接调用） */
  const applyToggle = async (todo: Todo): Promise<void> => {
    setBusyId(todo.id);
    try {
      const updated = await api.updateTodo(todo.id, { done: !todo.done });
      setTodos((current) => sortTodos(current.map((item) => (item.id === updated.id ? updated : item))));
      // 完成状态可能改变了待发提醒，重新拉一遍拿到准确的 nextFireAt
      await refresh();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : '更新失败');
    } finally {
      setBusyId(null);
    }
  };

  /**
   * 勾选完成 / 取消完成。
   * 标记完成先弹应用内中文确认弹窗（原生 confirm 的 CANCEL / OK 是英文且无法改样式）；
   * 取消完成是可逆操作，直接执行。
   */
  const handleToggle = (todo: Todo): void => {
    if (!todo.done) {
      setPendingConfirm({ action: 'complete', todo });
      return;
    }
    void applyToggle(todo);
  };

  /** 顶点卡片上的「完成」 */
  const handlePinDone = (todo: Todo): void => {
    handleToggle(todo);
  };

  /** 删除（先弹应用内中文确认弹窗） */
  const handleDelete = (todo: Todo): void => {
    setPendingConfirm({ action: 'delete', todo });
  };

  /** 确认弹窗点确认后执行对应操作 */
  const handleConfirm = async (): Promise<void> => {
    if (!pendingConfirm) {
      return;
    }
    const { action, todo } = pendingConfirm;
    if (action === 'complete') {
      await applyToggle(todo);
      setPendingConfirm(null);
      return;
    }
    setBusyId(todo.id);
    try {
      await api.deleteTodo(todo.id);
      setTodos((current) => current.filter((item) => item.id !== todo.id));
      await refresh();
      setPendingConfirm(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除失败');
    } finally {
      setBusyId(null);
    }
  };

  const handleTokenSaved = (value: string): void => {
    setToken(value);
    setTokenState(value);
  };

  /** 最近一件未完成的事 */
  const pinned = useMemo<Todo | null>(() => todos.find((todo) => !todo.done) ?? null, [todos]);
  const needsToken = token.length === 0;

  return (
    <div className="mx-auto flex min-h-full w-full max-w-md flex-col px-4 pb-24 pt-6">
      <header className="mb-4 flex items-center justify-between px-1">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">做了么</h1>
          <p className="mt-0.5 text-xs text-ink-500">六档提醒，不漏事。</p>
        </div>
        <span className="rounded-full bg-white/5 px-3 py-1 text-[11px] text-ink-500">MVP</span>
      </header>

      {needsToken ? (
        <div className="card mb-4 p-4">
          <p className="text-sm font-medium text-white">先填写 API Token</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            这个应用的数据存在你自己的 Cloudflare Worker 里。请在下方「设置 → API Token」填入部署时设置的
            API_TOKEN，然后就能新建待办。
          </p>
        </div>
      ) : null}

      {error ? (
        <div className="mb-4 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
          {error.includes('Token') ? (
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => {
                setToken('');
                setTokenState('');
              }}
            >
              去填写
            </button>
          ) : null}
        </div>
      ) : null}

      <PinnedCard todo={pinned} now={now} busy={busyId === pinned?.id} onDone={(todo) => void handlePinDone(todo)} onCreate={() => setAddOpen(true)} />

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

      <SettingsPanel token={token} onTokenSaved={handleTokenSaved} defaultOpen={needsToken} />

      <p className="mt-6 px-1 text-center text-[11px] leading-relaxed text-ink-500">
        提醒由服务器每分钟派发：到达时间点才推送，手机上不必保持应用打开。
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

      <ConfirmDialog
        open={pendingConfirm !== null}
        title={
          pendingConfirm?.action === 'delete'
            ? `删除「${pendingConfirm.todo.title}」？`
            : `完成「${pendingConfirm?.todo.title ?? ''}」？`
        }
        message={
          pendingConfirm?.action === 'delete'
            ? '该事项的所有提醒会一起删除，删了就找不回来。'
            : '完成后将不再提醒这件事。'
        }
        confirmText={pendingConfirm?.action === 'delete' ? '确认删除' : '确认完成'}
        cancelText="取消"
        tone={pendingConfirm?.action === 'delete' ? 'danger' : 'primary'}
        busy={pendingConfirm !== null && busyId === pendingConfirm.todo.id}
        onConfirm={() => void handleConfirm()}
        onCancel={() => setPendingConfirm(null)}
      />

      <AddTodoPanel open={addOpen} onClose={() => setAddOpen(false)} onSubmit={handleCreate} />
    </div>
  );
}
