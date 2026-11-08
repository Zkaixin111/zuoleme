import { useEffect, useState } from 'react';
import { toDateTimeLocalValue } from '../../shared/format';
import type { RepeatRule, Todo } from '../../shared/types';
import { RepeatPicker } from './RepeatPicker';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const TITLE_MAX_LENGTH = 100;
const CONTENT_MAX_LENGTH = 2000;

export interface TodoEditorProps {
  /** 编辑既有待办时传入；新建时为 null */
  todo: Todo | null;
  onCancel: () => void;
  onSubmit: (input: { title: string; content: string; deadline: number; repeat: RepeatRule }) => Promise<void>;
}

/** 默认截止时间：1 小时后，取整到 5 分钟 */
function defaultDeadline(): number {
  const base = Date.now() + HOUR_MS;
  return Math.ceil(base / (5 * MINUTE_MS)) * 5 * MINUTE_MS;
}

/** 今晚 20:00（已过则顺延到明天 20:00） */
function tonightAt20(): number {
  const date = new Date();
  date.setHours(20, 0, 0, 0);
  if (date.getTime() <= Date.now()) {
    date.setDate(date.getDate() + 1);
  }
  return date.getTime();
}

/** 明天 9:00 */
function tomorrowAt9(): number {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

/**
 * 新建 / 编辑待办（全屏页）。
 *
 * 字段顺序刻意固定：标题 → 内容 → 截止时间 → 重复。
 * 标题是必填的「一句话」，内容是可选的长文本，只在详情页展示。
 */
export function TodoEditor({ todo, onCancel, onSubmit }: TodoEditorProps): JSX.Element {
  const [title, setTitle] = useState<string>(todo?.title ?? '');
  const [content, setContent] = useState<string>(todo?.content ?? '');
  const [deadlineValue, setDeadlineValue] = useState<string>(() =>
    toDateTimeLocalValue(todo?.deadline ?? defaultDeadline()),
  );
  const [repeat, setRepeat] = useState<RepeatRule>(todo?.repeat ?? { kind: 'none' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  // 切换到另一条待办编辑时同步表单
  useEffect(() => {
    setTitle(todo?.title ?? '');
    setContent(todo?.content ?? '');
    setDeadlineValue(toDateTimeLocalValue(todo?.deadline ?? defaultDeadline()));
    setRepeat(todo?.repeat ?? { kind: 'none' });
    setError(null);
  }, [todo]);

  const applyPreset = (timestamp: number): void => {
    setDeadlineValue(toDateTimeLocalValue(timestamp));
  };

  const handleSubmit = async (): Promise<void> => {
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) {
      setError('请填写标题');
      return;
    }
    if (trimmedTitle.length > TITLE_MAX_LENGTH) {
      setError(`标题不能超过 ${TITLE_MAX_LENGTH} 字`);
      return;
    }
    if (content.trim().length > CONTENT_MAX_LENGTH) {
      setError(`内容不能超过 ${CONTENT_MAX_LENGTH} 字`);
      return;
    }
    const deadline = new Date(deadlineValue).getTime();
    if (!Number.isFinite(deadline)) {
      setError('请选择截止时间');
      return;
    }
    if (deadline <= Date.now()) {
      setError('截止时间必须晚于现在');
      return;
    }
    if (repeat.kind === 'weekly' && repeat.weekdays.length === 0) {
      setError('每周重复至少要选一天');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await onSubmit({ title: trimmedTitle, content: content.trim(), deadline, repeat });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '保存失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pb-28">
      <div className="mb-5 flex items-center justify-between">
        <button type="button" className="btn-quiet -ml-2" onClick={onCancel}>
          取消
        </button>
        <h1 className="text-[15px] font-medium text-ink">{todo ? '编辑待办' : '新建待办'}</h1>
        <span className="w-12" aria-hidden="true" />
      </div>

      <label className="block">
        <span className="label">标题</span>
        <input
          autoFocus={!todo}
          className="field mt-1"
          placeholder="要做什么"
          value={title}
          maxLength={TITLE_MAX_LENGTH}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>

      <label className="mt-4 block">
        <span className="label">内容</span>
        <textarea
          className="field mt-1 resize-none"
          rows={3}
          placeholder="补充说明，可以留空"
          value={content}
          maxLength={CONTENT_MAX_LENGTH}
          onChange={(event) => setContent(event.target.value)}
        />
        <span className="mt-1 block text-right text-[11px] text-faint">
          {content.length} / {CONTENT_MAX_LENGTH}
        </span>
      </label>

      <label className="mt-2 block">
        <span className="label">截止时间</span>
        <input
          type="datetime-local"
          className="field mt-1"
          value={deadlineValue}
          onChange={(event) => setDeadlineValue(event.target.value)}
        />
      </label>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="button" className="btn-ghost !px-3 !py-2 text-xs" onClick={() => applyPreset(Date.now() + 30 * MINUTE_MS)}>
          30 分钟后
        </button>
        <button type="button" className="btn-ghost !px-3 !py-2 text-xs" onClick={() => applyPreset(Date.now() + HOUR_MS)}>
          1 小时后
        </button>
        <button type="button" className="btn-ghost !px-3 !py-2 text-xs" onClick={() => applyPreset(Date.now() + 3 * HOUR_MS)}>
          3 小时后
        </button>
        <button type="button" className="btn-ghost !px-3 !py-2 text-xs" onClick={() => applyPreset(tonightAt20())}>
          今晚 20:00
        </button>
        <button type="button" className="btn-ghost !px-3 !py-2 text-xs" onClick={() => applyPreset(tomorrowAt9())}>
          明天 9:00
        </button>
      </div>

      <div className="mt-5">
        <span className="label">重复</span>
        <div className="mt-1">
          <RepeatPicker value={repeat} onChange={setRepeat} />
        </div>
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-faint">
        提醒只在截止前分档弹出，不会发出声音；已过去的档位不补发。
      </p>

      {error ? <p className="mt-3 rounded-control bg-alert/10 px-3 py-2 text-[13px] text-alert">{error}</p> : null}

      <div className="mt-6 flex gap-2">
        <button type="button" className="btn-ghost flex-1" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button type="button" className="btn-primary flex-[2]" onClick={() => void handleSubmit()} disabled={busy}>
          {busy ? '保存中' : '保存'}
        </button>
      </div>
    </div>
  );
}
