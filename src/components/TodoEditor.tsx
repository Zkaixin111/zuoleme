import { useEffect, useRef, useState } from 'react';
import { toDateTimeLocalValue } from '../../shared/format';
import type { RepeatRule, Todo } from '../../shared/types';
import { resolveDeadlineDraft } from '../lib/deadline-draft';
import { RepeatPicker } from './RepeatPicker';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const TITLE_MAX_LENGTH = 100;
const CONTENT_MAX_LENGTH = 2000;

export interface TodoEditorProps {
  /** 编辑既有待办时传入；新建时为 null */
  todo: Todo | null;
  onCancel: () => void;
  onSubmit: (input: {
    title: string;
    content: string;
    deadline: number | null;
    advanceReminder: boolean;
    repeat: RepeatRule;
  }) => Promise<void>;
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
 * 字段顺序刻意固定：标题 → 内容 → 截止时间（含「不设时间」）→ 提前提醒 → 重复。
 * 标题是必填的「一句话」，内容是可选的长文本，只在详情页展示。
 *
 * 两个「不打扰用户」的细节：
 * 1. **编辑时不动时间就不改时间**：`datetime-local` 只能精确到分钟，
 *    而待办可能带着秒（例如 23:45:37）。如果用户只是进来看看内容就保存，
 *    直接把输入框的值写回去会把 37 秒抹掉 —— 所以用 `deadlineDirty` 记录
 *    「用户是否真的动过时间输入框」，没动过就沿用原始时间戳（含秒）。
 * 2. **不设时间时把无意义的开关藏起来**：没有截止时间就没有重复与提前档位。
 *
 * 还有一条规则容易被写错，已抽到 `resolveDeadlineDraft` 里：
 * **逾期待办只改标题必须能保存**。这条待办的原始时间当然在过去，
 * 如果无脑校验「必须晚于现在」，用户就再也改不了它的标题了。
 * 所以只有「新建」或「用户真的动过时间」才做这个校验。
 */
export function TodoEditor({ todo, onCancel, onSubmit }: TodoEditorProps): JSX.Element {
  const [title, setTitle] = useState<string>(todo?.title ?? '');
  const [content, setContent] = useState<string>(todo?.content ?? '');
  const [hasDeadline, setHasDeadline] = useState<boolean>(todo === null || todo.deadline !== null);
  const [deadlineValue, setDeadlineValue] = useState<string>(() =>
    toDateTimeLocalValue(todo?.deadline ?? defaultDeadline()),
  );
  const [advanceReminder, setAdvanceReminder] = useState<boolean>(todo?.advanceReminder ?? true);
  const [repeat, setRepeat] = useState<RepeatRule>(todo?.repeat ?? { kind: 'none' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  /** 原始截止时间（含秒）；编辑老待办时用它兜住「没动过就原样保存」 */
  const originalDeadline = useRef<number | null>(todo?.deadline ?? null);
  /** 用户是否真的动过时间输入框（含快捷按钮） */
  const deadlineDirty = useRef<boolean>(false);

  // 切换到另一条待办编辑时同步表单
  useEffect(() => {
    setTitle(todo?.title ?? '');
    setContent(todo?.content ?? '');
    setHasDeadline(todo === null || todo.deadline !== null);
    setDeadlineValue(toDateTimeLocalValue(todo?.deadline ?? defaultDeadline()));
    setAdvanceReminder(todo?.advanceReminder ?? true);
    setRepeat(todo?.repeat ?? { kind: 'none' });
    setError(null);
    originalDeadline.current = todo?.deadline ?? null;
    deadlineDirty.current = false;
  }, [todo]);

  /** 用户动过时间：记住脏标记 */
  const changeDeadline = (value: string): void => {
    deadlineDirty.current = true;
    setDeadlineValue(value);
  };

  /**
   * 取最终要提交的截止时间。
   *
   * 判定逻辑在 `resolveDeadlineDraft`（纯函数，可单测）：这里只负责把
   * 「用户到底动没动过时间」这层 UI 状态喂进去，并把不通过的原因翻译成人话。
   *
   * @returns 可以提交时给出时间戳（null = 不设时间），否则给出错误文案
   */
  const resolveDeadline = (): { deadline: number | null } | { error: string } => {
    const draft = resolveDeadlineDraft({
      isNew: todo === null,
      hasDeadline,
      dirty: deadlineDirty.current,
      originalDeadline: originalDeadline.current,
      inputValue: deadlineValue,
      now: Date.now(),
    });
    if (draft.ok) {
      return { deadline: draft.deadline };
    }
    return { error: draft.reason === 'past' ? '截止时间必须晚于现在' : '请选择截止时间' };
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

    // 逾期待办只改标题时必须能保存：没动过时间就沿用原始时间戳，不做「晚于现在」校验
    const resolved = resolveDeadline();
    if ('error' in resolved) {
      setError(resolved.error);
      return;
    }
    const deadline = resolved.deadline;
    if (hasDeadline && repeat.kind === 'weekly' && repeat.weekdays.length === 0) {
      setError('每周重复至少要选一天');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        title: trimmedTitle,
        content: content.trim(),
        deadline,
        // 没有截止时间时这两个开关都没有意义，交给存储层归位
        advanceReminder: hasDeadline ? advanceReminder : true,
        repeat: hasDeadline ? repeat : { kind: 'none' },
      });
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

      <div className="mt-5">
        <span className="label">截止时间</span>
        <div className="mt-1 flex gap-1.5">
          <button
            type="button"
            aria-pressed={hasDeadline}
            onClick={() => setHasDeadline(true)}
            className={`rounded-control border px-3 py-2 text-[13px] ${
              hasDeadline ? 'border-accent bg-accent-soft text-accent' : 'border-line-strong bg-surface text-soft'
            }`}
          >
            设置截止时间
          </button>
          <button
            type="button"
            aria-pressed={!hasDeadline}
            onClick={() => setHasDeadline(false)}
            className={`rounded-control border px-3 py-2 text-[13px] ${
              !hasDeadline ? 'border-accent bg-accent-soft text-accent' : 'border-line-strong bg-surface text-soft'
            }`}
          >
            不设时间
          </button>
        </div>

        {hasDeadline ? (
          <>
            <input
              type="datetime-local"
              className="field mt-2"
              value={deadlineValue}
              onChange={(event) => changeDeadline(event.target.value)}
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                className="btn-ghost !px-3 !py-2 text-xs"
                onClick={() => changeDeadline(toDateTimeLocalValue(Date.now() + 30 * MINUTE_MS))}
              >
                30 分钟后
              </button>
              <button
                type="button"
                className="btn-ghost !px-3 !py-2 text-xs"
                onClick={() => changeDeadline(toDateTimeLocalValue(Date.now() + HOUR_MS))}
              >
                1 小时后
              </button>
              <button
                type="button"
                className="btn-ghost !px-3 !py-2 text-xs"
                onClick={() => changeDeadline(toDateTimeLocalValue(Date.now() + 3 * HOUR_MS))}
              >
                3 小时后
              </button>
              <button
                type="button"
                className="btn-ghost !px-3 !py-2 text-xs"
                onClick={() => changeDeadline(toDateTimeLocalValue(tonightAt20()))}
              >
                今晚 20:00
              </button>
              <button
                type="button"
                className="btn-ghost !px-3 !py-2 text-xs"
                onClick={() => changeDeadline(toDateTimeLocalValue(tomorrowAt9()))}
              >
                明天 9:00
              </button>
            </div>
          </>
        ) : (
          <p className="mt-2 text-[11px] leading-relaxed text-faint">
            不设时间的待办不会有任何提醒，只作为清单记着。
          </p>
        )}
      </div>

      {hasDeadline ? (
        <div className="mt-5">
          <div className="flex items-center justify-between gap-3">
            <span className="label">提前提醒</span>
            <button
              type="button"
              role="switch"
              aria-checked={advanceReminder}
              aria-label="提前提醒"
              onClick={() => setAdvanceReminder((value) => !value)}
              className={`relative h-6 w-11 shrink-0 rounded-full border ${
                advanceReminder ? 'border-accent bg-accent' : 'border-line-strong bg-paper'
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface transition-all ${
                  advanceReminder ? 'left-[22px]' : 'left-0.5'
                }`}
                aria-hidden="true"
              />
            </button>
          </div>
          {advanceReminder ? (
            <p className="mt-1 text-[11px] leading-relaxed text-faint">
              截止前分档提醒（会按重复周期自动收窄档位）。
            </p>
          ) : (
            <p className="mt-1 text-[11px] leading-relaxed text-faint">关闭后只在到点那一刻提醒一次。</p>
          )}
        </div>
      ) : null}

      <div className="mt-5">
        <span className="label">重复</span>
        <div className="mt-1">
          <RepeatPicker value={repeat} onChange={setRepeat} disabled={!hasDeadline} />
        </div>
        {hasDeadline ? null : (
          <p className="mt-1 text-[11px] leading-relaxed text-faint">重复需要截止时间。</p>
        )}
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-faint">
        提醒只在相关时间内静音弹出，不会响铃；已过去的档位不补发。
      </p>

      {error ? (
        <p className="mt-3 rounded-control border border-alert-line bg-alert-soft px-3 py-2 text-[13px] text-alert">
          {error}
        </p>
      ) : null}

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
