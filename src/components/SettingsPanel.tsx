import { useEffect, useState } from 'react';
import { useInstallPrompt } from '../lib/useInstallPrompt';
import {
  checkPushEnvironment,
  hasPushSubscription,
  subscribeToPush,
  unsubscribeFromPush,
} from '../lib/push';

export interface SettingsPanelProps {
  /** 当前已保存的 token */
  token: string;
  /** 保存 token 后通知父组件刷新 */
  onTokenSaved: (value: string) => void;
  /** 是否默认展开 */
  defaultOpen: boolean;
}

type Notice = { kind: 'ok' | 'error'; text: string };

/**
 * 设置面板（可折叠）：通知开关、API Token、安装到桌面。
 * 环境不支持时给出明确中文提示，不静默失败。
 */
export function SettingsPanel({ token, onTokenSaved, defaultOpen }: SettingsPanelProps): JSX.Element {
  const [open, setOpen] = useState<boolean>(defaultOpen);
  const [draftToken, setDraftToken] = useState<string>(token);
  const [env] = useState(() => checkPushEnvironment());
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const install = useInstallPrompt();

  useEffect(() => {
    setDraftToken(token);
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!env.ok) {
        return;
      }
      const active = await hasPushSubscription();
      if (!cancelled) {
        setSubscribed(active);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [env.ok, token]);

  const handleTogglePush = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      if (subscribed) {
        await unsubscribeFromPush();
        setSubscribed(false);
        setNotice({ kind: 'ok', text: '已关闭通知提醒。' });
      } else {
        await subscribeToPush();
        setSubscribed(true);
        setPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
        setNotice({ kind: 'ok', text: '已开启，提醒会推送到这台手机上。' });
      }
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '操作失败，请重试' });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveToken = (): void => {
    const trimmed = draftToken.trim();
    if (trimmed.length === 0) {
      setNotice({ kind: 'error', text: 'API Token 不能为空' });
      return;
    }
    onTokenSaved(trimmed);
    setNotice({ kind: 'ok', text: 'Token 已保存。' });
  };

  const handleInstall = async (): Promise<void> => {
    const accepted = await install.promptInstall();
    setNotice(
      accepted
        ? { kind: 'ok', text: '已开始安装，请确认系统弹窗。' }
        : { kind: 'error', text: '安装被取消。你也可以用浏览器菜单里的「添加到主屏幕」。' },
    );
  };

  const pushStatusText = !env.ok
    ? (env.reason ?? '当前环境不支持推送')
    : permission === 'denied'
      ? '通知权限被拒绝：请到浏览器设置里允许本站通知'
      : subscribed
        ? '已开启：截止前的六档提醒会推送到这台手机'
        : '未开启：开启后才能收到提醒';

  return (
    <section className="card mt-4 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="text-sm font-medium text-ink-300">设置</span>
        <span className="text-xs text-ink-500">{open ? '收起' : '展开'}</span>
      </button>

      {open ? (
        <div className="space-y-5 border-t border-white/5 px-4 py-4">
          {/* 通知 */}
          <div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-white">通知提醒</p>
                <p className={`mt-1 text-xs ${env.ok ? 'text-ink-500' : 'text-amber-300'}`}>{pushStatusText}</p>
              </div>
              <button
                type="button"
                className={subscribed ? 'btn-ghost shrink-0 !px-3 !py-2 text-xs' : 'btn-primary shrink-0 !px-3 !py-2 text-xs'}
                onClick={() => void handleTogglePush()}
                disabled={busy || !env.ok}
              >
                {busy ? '处理中…' : subscribed ? '关闭通知' : '开启通知'}
              </button>
            </div>
            {permission === 'default' && env.ok ? (
              <p className="mt-2 text-[11px] text-ink-500">
                首次开启会弹出系统授权框，请选择「允许」，否则收不到提醒。
              </p>
            ) : null}
          </div>

          {/* API Token */}
          <div>
            <label className="block">
              <span className="text-sm font-medium text-white">API Token</span>
              <span className="mt-1 block text-xs text-ink-500">与服务端 API_TOKEN secret 一致，只保存在本机。</span>
              <div className="mt-2 flex gap-2">
                <input
                  className="field flex-1 !py-2 text-sm"
                  type="password"
                  autoComplete="off"
                  placeholder="粘贴 API_TOKEN"
                  value={draftToken}
                  onChange={(event) => setDraftToken(event.target.value)}
                />
                <button type="button" className="btn-ghost shrink-0 !px-3 !py-2 text-xs" onClick={handleSaveToken}>
                  保存
                </button>
              </div>
            </label>
          </div>

          {/* 安装到桌面 */}
          <div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-white">安装到桌面</p>
                <p className="mt-1 text-xs text-ink-500">
                  {install.installed
                    ? '已作为应用运行。'
                    : install.canInstall
                      ? '点右侧按钮安装，之后从桌面图标启动。'
                      : '当前浏览器没有提供安装按钮：Android 请用 Firefox 的菜单「添加到主屏幕」。'}
                </p>
              </div>
              <button
                type="button"
                className="btn-ghost shrink-0 !px-3 !py-2 text-xs"
                onClick={() => void handleInstall()}
                disabled={install.installed}
              >
                {install.installed ? '已安装' : '安装'}
              </button>
            </div>
          </div>

          {notice ? (
            <p
              className={`rounded-xl px-3 py-2 text-xs leading-relaxed ${
                notice.kind === 'ok' ? 'bg-brand-500/10 text-brand-300' : 'bg-red-500/10 text-red-300'
              }`}
            >
              {notice.text}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
