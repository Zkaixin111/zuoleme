import { useEffect, useState } from 'react';
import { toDateTimeLocalValue } from '../../shared/format';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const TITLE_MAX_LENGTH = 200;

export interface AddTodoPanelProps {
  open: boolean;
  onClose: () => void;
  /** 提交：返回 Promise 以便面板展示错误 */
  onSubmit: (input: { title: string; deadline: number }) => Promise<void>;
}

/** 默认截止时间：1 小时后（取整到 5 分钟） */
function defaultDeadline(): number {
  const base = Date.now() + HOUR_MS;
  const rounded = Math.ceil(base / (5 * MINUTE_MS)) * 5 * MINUTE_MS;
  return rounded;
}

/**
 * 新建待办面板（底部抽屉）。
 */
export function AddTodoPanel({ open, onClose, onSubmit }: AddTodoPanelProps): JSX.Element | null {
  const [title, setTitle] = useState<string>('');
  const [deadlineValue, setDeadlineValue] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  // 每次打开重置表单
  useEffect(() => {
    if (open) {
      setTitle('');
      setDeadlineValue(toDateTimeLocalValue(defaultDeadline()));
      setError(null);
      setBusy(false);
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const applyPreset = (offsetMs: number): void => {
    setDeadlineValue(toDateTimeLocalValue(Date.now() + offsetMs));
  };

  const applyTomorrowMorning = (): void => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    setDeadlineValue(toDateTimeLocalValue(tomorrow.getTime()));
  };

  const handleSubmit = async (): Promise<void> => {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      setError('请填写待办内容');
      return;
    }
    if (trimmed.length > TITLE_MAX_LENGTH) {
      setError(`内容不能超过 ${TITLE_MAX_LENGTH} 字`);
      return;
    }
    // datetime-local 的值按本地时区解析
    const deadline = new Date(deadlineValue).getTime();
    if (!Number.isFinite(deadline)) {
      setError('请选择截止时间');
      return;
    }
    if (deadline <= Date.now()) {
      setError('截止时间必须晚于现在');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await onSubmit({ title: trimmed, deadline });
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '保存失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4">
      <div className="w-full max-w-md rounded-t-3xl bg-ink-800 p-5 pb-8 shadow-card ring-1 ring-white/10 sm:rounded-3xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">新建待办</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-sm text-ink-500 hover:text-white"
            aria-label="关闭"
          >
            关闭
          </button>
        </div>

        <label className="mt-4 block">
          <span className="text-xs text-ink-500">要做什么</span>
          <input
            autoFocus
            className="field mt-1"
            placeholder="例如：交周报"
            value={title}
            maxLength={TITLE_MAX_LENGTH}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleSubmit();
              }
            }}
          />
        </label>

        <label className="mt-4 block">
          <span className="text-xs text-ink-500">截止时间</span>
          <input
            type="datetime-local"
            className="field mt-1"
            value={deadlineValue}
            onChange={(event) => setDeadlineValue(event.target.value)}
          />
        </label>

        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn-ghost !px-3 !py-2 text-xs" onClick={() => applyPreset(30 * MINUTE_MS)}>
            30 分钟后
          </button>
          <button type="button" className="btn-ghost !px-3 !py-2 text-xs" onClick={() => applyPreset(HOUR_MS)}>
            1 小时后
          </button>
          <button type="button" className="btn-ghost !px-3 !py-2 text-xs" onClick={() => applyPreset(3 * HOUR_MS)}>
            3 小时后
          </button>
          <button type="button" className="btn-ghost !px-3 !py-2 text-xs" onClick={applyTomorrowMorning}>
            明天 9:00
          </button>
        </div>

        <p className="mt-3 text-[11px] leading-relaxed text-ink-500">
          提醒时间：截止前 7 天 / 3 天 / 1 天 / 3 小时 / 1 小时，以及到点各一次；已经过去的档位不会补发。
        </p>

        {error ? <p className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p> : null}

        <div className="mt-4 flex gap-2">
          <button type="button" className="btn-ghost flex-1" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn-primary flex-[2]" onClick={() => void handleSubmit()} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
