import { useCallback, useEffect, useState } from 'react';
import {
  openBatterySettings,
  openExactAlarmSettings,
  readPermissionState,
  requestNotificationPermission,
  type PermissionSnapshot,
} from '../lib/reminder-bridge';

export interface HealthPanelProps {
  /** 当前已排程的系统闹钟条数（由 App 同步后传入） */
  scheduledCount: number;
}

/** 单项检查的展示状态 */
type CheckState = 'ok' | 'warn' | 'unknown';

/** 一行检查项的渲染数据 */
interface CheckRow {
  key: string;
  title: string;
  state: CheckState;
  /** 右侧按钮文案，null 表示不需要按钮 */
  actionLabel: string | null;
  onAction: (() => void) | null;
  /** 状态说明 */
  detail: string;
}

/** 状态 → 圆点颜色 */
function dotClass(state: CheckState): string {
  if (state === 'ok') {
    return 'bg-brand-400';
  }
  if (state === 'warn') {
    return 'bg-amber-400';
  }
  return 'bg-white/30';
}

/**
 * 运行检查面板。
 *
 * 为什么必须有这个面板：Android 上「闹钟会不会响」不只取决于应用本身，
 * 还取决于三项系统授权（通知、精确闹钟、电池优化）以及国产 ROM 的自启动白名单。
 * 用户看不到这些开关，就只能靠猜；这里逐项显示状态并给一键跳转。
 */
export function HealthPanel({ scheduledCount }: HealthPanelProps): JSX.Element {
  const [open, setOpen] = useState<boolean>(false);
  const [state, setState] = useState<PermissionSnapshot | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [notice, setNotice] = useState<string | null>(null);

  /** 重新读取三项授权状态 */
  const refresh = useCallback(async (): Promise<void> => {
    const snapshot = await readPermissionState();
    setState(snapshot);
  }, []);

  // 首次挂载时读一次，之后每次展开面板再刷新
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (open) {
      void refresh();
    }
  }, [open, refresh]);

  // 从系统设置页返回时（界面重新可见）再读一次
  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [refresh]);

  const handleRequestNotifications = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const granted = await requestNotificationPermission();
      await refresh();
      setNotice(granted ? '通知权限已允许。' : '仍未允许通知：请到系统设置 → 应用 → 做了么 → 通知 里手动打开。');
    } finally {
      setBusy(false);
    }
  };

  const handleOpenExactAlarm = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await openExactAlarmSettings();
      setNotice('已跳转系统设置：请打开「闹钟和提醒」或「允许设置精确闹钟」。授权后返回本页会自动刷新。');
    } finally {
      setBusy(false);
    }
  };

  const handleOpenBattery = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await openBatterySettings();
      setNotice('已跳转电池优化设置：请找到「做了么」并选择「不限制 / 不优化」。');
    } finally {
      setBusy(false);
    }
  };

  const supported = state?.supported === true;
  const notificationsOk = state?.notifications === true;
  const exactAlarmOk = state?.exactAlarm === true;
  const batteryOk = state !== null && state.batteryOptimized === false;

  const rows: CheckRow[] = [
    {
      key: 'notifications',
      title: '通知权限',
      state: state === null ? 'unknown' : notificationsOk ? 'ok' : 'warn',
      actionLabel: notificationsOk ? null : '去授权',
      onAction: notificationsOk ? null : () => void handleRequestNotifications(),
      detail: notificationsOk ? '已允许：到点会弹出通知' : '未允许：闹钟响了也不会显示任何东西',
    },
    {
      key: 'exact-alarm',
      title: '精确闹钟（Android 12+）',
      state: state === null ? 'unknown' : exactAlarmOk ? 'ok' : 'warn',
      actionLabel: exactAlarmOk ? null : '去开启',
      onAction: exactAlarmOk ? null : () => void handleOpenExactAlarm(),
      detail: exactAlarmOk
        ? '已允许：能在准确的分钟触发'
        : '未开启：系统会把提醒推迟到省电窗口，可能晚十几分钟',
    },
    {
      key: 'battery',
      title: '电池优化',
      state: state === null ? 'unknown' : batteryOk ? 'ok' : 'warn',
      actionLabel: batteryOk ? null : '去设置',
      onAction: batteryOk ? null : () => void handleOpenBattery(),
      detail: batteryOk ? '已忽略电池优化：后台不会被清理' : '仍受限制：长时间未使用可能收不到提醒',
    },
  ];

  return (
    <section className="card mt-4 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="text-sm font-medium text-ink-300">运行检查</span>
        <span className="text-xs text-ink-500">{open ? '收起' : '展开'}</span>
      </button>

      {open ? (
        <div className="space-y-4 border-t border-white/5 px-4 py-4">
          <p className="rounded-xl bg-amber-400/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
            国产系统（realme / OPPO / vivo / 小米等）还需在系统设置里把本应用的「自启动」打开，
            并把「耗电管理 / 电池使用」设为「不限制」，否则息屏清后台后提醒会被拦下。
          </p>

          {!supported ? (
            <p className="rounded-xl bg-white/5 px-3 py-2 text-[11px] leading-relaxed text-ink-500">
              当前是浏览器环境，系统闹钟不可用。请安装 APK 后再查看这里的授权状态。
            </p>
          ) : null}

          {supported ? (
            <>
              <ul className="space-y-3">
                {rows.map((row) => (
                  <li key={row.key} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-medium text-white">
                        <span
                          className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotClass(row.state)}`}
                          aria-hidden="true"
                        />
                        {row.title}
                      </p>
                      <p className="mt-1 text-[11px] leading-relaxed text-ink-500">{row.detail}</p>
                    </div>
                    {row.actionLabel && row.onAction ? (
                      <button
                        type="button"
                        className="btn-ghost shrink-0 !px-3 !py-2 text-xs"
                        onClick={row.onAction}
                        disabled={busy}
                      >
                        {row.actionLabel}
                      </button>
                    ) : (
                      <span className="shrink-0 rounded-full bg-brand-500/15 px-2 py-0.5 text-[11px] text-brand-300">
                        正常
                      </span>
                    )}
                  </li>
                ))}
              </ul>

              <div className="flex items-center justify-between border-t border-white/5 pt-3">
                <p className="text-[11px] text-ink-500">已排程系统闹钟：{scheduledCount} 条</p>
                <button
                  type="button"
                  className="btn-ghost !px-3 !py-2 text-xs"
                  onClick={() => void refresh()}
                  disabled={busy}
                >
                  重新检查
                </button>
              </div>
            </>
          ) : null}

          {notice ? (
            <p className="rounded-xl bg-brand-500/10 px-3 py-2 text-[11px] leading-relaxed text-brand-300">{notice}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
