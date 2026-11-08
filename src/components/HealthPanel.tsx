import { useCallback, useEffect, useState } from 'react';
import {
  openBatterySettings,
  openExactAlarmSettings,
  openNotificationSettings,
  readPermissionState,
  requestNotificationPermission,
  type PermissionSnapshot,
} from '../lib/reminder-bridge';

export interface HealthPanelProps {
  /** 当前已排程的系统提醒条数（由 App 同步后传入） */
  scheduledCount: number;
  /** 因上限被丢弃的条数，> 0 时提示用户 */
  truncatedCount: number;
  /** 面板是否展开（受控：App 在通知未授权时会强制展开） */
  open: boolean;
  onToggle: () => void;
  /** 读到新的授权状态时上报给 App（顶部提示条与面板共用一份真相） */
  onPermissionsChanged?: (snapshot: PermissionSnapshot) => void;
}

/** 单项检查的展示状态 */
type CheckState = 'ok' | 'warn' | 'unknown';

/** 一行检查项 */
interface CheckRow {
  key: string;
  title: string;
  state: CheckState;
  actionLabel: string | null;
  onAction: (() => void) | null;
  altActionLabel: string | null;
  onAltAction: (() => void) | null;
  detail: string;
}

/** 状态 → 圆点颜色 */
function dotClass(state: CheckState): string {
  if (state === 'ok') {
    return 'bg-accent';
  }
  if (state === 'warn') {
    return 'bg-alert';
  }
  return 'bg-faint';
}

/**
 * 运行检查面板。
 *
 * Android 上「提醒会不会弹出来」不只取决于应用本身，还取决于三项系统授权
 * （通知、准时触发、电池优化）以及国产 ROM 的自启动白名单。用户看不到这些开关，
 * 就只能靠猜；这里逐项显示状态并给一键跳转。
 */
export function HealthPanel({
  scheduledCount,
  truncatedCount,
  open,
  onToggle,
  onPermissionsChanged,
}: HealthPanelProps): JSX.Element {
  const [state, setState] = useState<PermissionSnapshot | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const snapshot = await readPermissionState();
    setState(snapshot);
    onPermissionsChanged?.(snapshot);
  }, [onPermissionsChanged]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (open) {
      void refresh();
    }
  }, [open, refresh]);

  // 从系统设置页返回时再读一次
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
      setNotice(granted ? '通知权限已允许。' : '仍未允许通知：系统不会再弹授权框，请点「去设置」手动打开。');
    } finally {
      setBusy(false);
    }
  };

  const handleOpenNotificationSettings = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await openNotificationSettings();
      setNotice('已跳转通知设置：请打开「允许通知」。返回本页会自动刷新。');
    } finally {
      setBusy(false);
    }
  };

  const handleOpenExactAlarm = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await openExactAlarmSettings();
      setNotice('已跳转系统设置：请允许「准时触发」，否则提醒会被推迟到省电窗口。返回本页会自动刷新。');
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
      altActionLabel: notificationsOk ? null : '去设置',
      onAltAction: notificationsOk ? null : () => void handleOpenNotificationSettings(),
      detail: notificationsOk ? '已允许：到点会弹出提醒' : '未允许：提醒触发了也不会显示任何东西',
    },
    {
      key: 'exact-alarm',
      title: '准时触发（Android 12+）',
      state: state === null ? 'unknown' : exactAlarmOk ? 'ok' : 'warn',
      actionLabel: exactAlarmOk ? null : '去开启',
      onAction: exactAlarmOk ? null : () => void handleOpenExactAlarm(),
      altActionLabel: null,
      onAltAction: null,
      detail: exactAlarmOk ? '已允许：能在准确的分钟触发' : '未开启：系统会把它推迟到省电窗口，可能晚十几分钟',
    },
    {
      key: 'battery',
      title: '电池优化',
      state: state === null ? 'unknown' : batteryOk ? 'ok' : 'warn',
      actionLabel: batteryOk ? null : '去设置',
      onAction: batteryOk ? null : () => void handleOpenBattery(),
      altActionLabel: null,
      onAltAction: null,
      detail: batteryOk ? '已忽略电池优化：后台不会被清理' : '仍受限制：长时间未使用可能收不到提醒',
    },
  ];

  return (
    <section className="card mt-6 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="text-[13px] font-medium text-ink">运行检查</span>
        <span className="text-xs text-faint">{open ? '收起' : '展开'}</span>
      </button>

      {open ? (
        <div className="space-y-4 border-t border-line px-4 py-4">
          <p className="rounded-control bg-accent-soft px-3 py-2 text-[11px] leading-relaxed text-accent">
            国产系统（realme / OPPO / vivo / 小米等）还需在系统设置里把本应用的「自启动」打开，
            并把「耗电管理」设为「不限制」，否则息屏清后台后提醒会被拦下。
          </p>

          {!supported ? (
            <p className="rounded-control bg-paper px-3 py-2 text-[11px] leading-relaxed text-soft">
              当前是浏览器环境，系统提醒不可用。请安装 APK 后再查看这里的授权状态。
            </p>
          ) : null}

          {supported ? (
            <>
              <ul className="space-y-3">
                {rows.map((row) => (
                  <li key={row.key} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
                        <span
                          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(row.state)}`}
                          aria-hidden="true"
                        />
                        {row.title}
                      </p>
                      <p className="mt-1 text-[11px] leading-relaxed text-faint">{row.detail}</p>
                    </div>
                    {row.actionLabel && row.onAction ? (
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <button
                          type="button"
                          className="btn-ghost !px-3 !py-2 text-xs"
                          onClick={row.onAction}
                          disabled={busy}
                        >
                          {row.actionLabel}
                        </button>
                        {row.altActionLabel && row.onAltAction ? (
                          <button
                            type="button"
                            className="px-2 py-1 text-[11px] text-faint underline decoration-line-strong"
                            onClick={row.onAltAction}
                            disabled={busy}
                          >
                            {row.altActionLabel}
                          </button>
                        ) : null}
                      </span>
                    ) : (
                      <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent">
                        正常
                      </span>
                    )}
                  </li>
                ))}
              </ul>

              <div className="flex items-center justify-between border-t border-line pt-3">
                <p className="text-[11px] leading-relaxed text-faint">
                  已排程提醒：{scheduledCount} 条
                  {truncatedCount > 0
                    ? `（另有 ${truncatedCount} 条更晚或更密的提醒本次没排，打开应用会继续续排）`
                    : ''}
                </p>
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
            <p className="rounded-control bg-accent-soft px-3 py-2 text-[11px] leading-relaxed text-accent">{notice}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
