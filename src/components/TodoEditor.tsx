import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toDateTimeLocalValue } from '../../shared/format';
import type { RepeatRule, Todo } from '../../shared/types';
import { NO_REPEAT } from '../../shared/types';
import { resolveDeadlineDraft } from '../lib/deadline-draft';
import { FloatingBack } from './FloatingBack';
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
  /** 标记完成（仅编辑未完成待办时可用） */
  onDone?: (todo: Todo) => Promise<void>;
  /** 删除（仅编辑时可用） */
  onDelete?: (todo: Todo) => Promise<void>;
  /** 表单是否有未保存改动（返回键要用它决定是否弹确认） */
  onDirtyChange?: (dirty: boolean) => void;
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
 * **详情页已被删除，这里是唯一的查看+编辑入口**，所以除了字段编辑还要承担
 * 「标记完成」「删除」两个危险操作（都放在底部操作栏上方的次要操作区，
 * 且都要二次确认 —— 它们在视觉上不是主按钮，但在数据上是不可逆的）。
 *
 * 三条「不打扰用户」的细节：
 * 1. **编辑时不动时间就不改时间**：`datetime-local` 只能精确到分钟，
 *    而待办可能带着秒（例如 23:45:37）。如果用户只是进来看看内容就保存，
 *    直接把输入框的值写回去会把 37 秒抹掉 —— 用 `initialDeadlineInput` 记住
 *    进页面时输入框的原始文本，只有真的变了才算「动过」。
 * 2. **逾期待办只改标题必须能保存**：判定在 `resolveDeadlineDraft` 里，
 *    没动过时间就沿用原始时间戳，不做「必须晚于现在」校验。
 * 3. **不设时间时把无意义的开关藏起来**：没有截止时间就没有重复与提前档位。
 */
export function TodoEditor({
  todo,
  onCancel,
  onSubmit,
  onDone,
  onDelete,
  onDirtyChange,
}: TodoEditorProps): JSX.Element {
  const [title, setTitle] = useState<string>(todo?.title ?? '');
  const [content, setContent] = useState<string>(todo?.content ?? '');
  const [hasDeadline, setHasDeadline] = useState<boolean>(todo === null || todo.deadline !== null);
  const [deadlineValue, setDeadlineValue] = useState<string>(() =>
    toDateTimeLocalValue(todo?.deadline ?? defaultDeadline()),
  );
  const [advanceReminder, setAdvanceReminder] = useState<boolean>(todo?.advanceReminder ?? true);
  const [repeat, setRepeat] = useState<RepeatRule>(todo?.repeat ?? NO_REPEAT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [secondaryBusy, setSecondaryBusy] = useState<boolean>(false);

  /** 原始截止时间（含秒）；编辑老待办时用它兜住「没动过就原样保存」 */
  const originalDeadline = useRef<number | null>(todo?.deadline ?? null);
  /**
   * 进页面时输入框里的原始文本。
   *
   * 用「文本是否变过」判断「用户动没动过时间」，而不是用 `onChange` 打标记：
   * 用户改了又改回原来那一分钟，应该算「没动过」（此时按原值保存，秒不会丢）。
   */
  const initialDeadlineInput = useRef<string>(deadlineValue);

  // 切换到另一条待办编辑时同步表单
  useEffect(() => {
    const nextInput = toDateTimeLocalValue(todo?.deadline ?? defaultDeadline());
    setTitle(todo?.title ?? '');
    setContent(todo?.content ?? '');
    setHasDeadline(todo === null || todo.deadline !== null);
    setDeadlineValue(nextInput);
    setAdvanceReminder(todo?.advanceReminder ?? true);
    setRepeat(todo?.repeat ?? NO_REPEAT);
    setError(null);
    originalDeadline.current = todo?.deadline ?? null;
    initialDeadlineInput.current = nextInput;
  }, [todo]);

  /** 用户是否动过时间输入框（含快捷按钮） */
  const deadlineTouched = deadlineValue !== initialDeadlineInput.current;

  /** 表单是否有未保存改动（新建时为空表单 = 没改动，返回可以直接走） */
  const dirty = useMemo<boolean>(() => {
    const baseRepeat = todo?.repeat ?? NO_REPEAT;
    return (
      title !== (todo?.title ?? '') ||
      content !== (todo?.content ?? '') ||
      hasDeadline !== (todo === null || todo.deadline !== null) ||
      (hasDeadline && deadlineTouched) ||
      advanceReminder !== (todo?.advanceReminder ?? true) ||
      JSON.stringify(repeat) !== JSON.stringify(baseRepeat)
    );
  }, [title, content, hasDeadline, deadlineTouched, advanceReminder, repeat, todo]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const changeDeadline = useCallback((value: string): void => {
    setDeadlineValue(value);
  }, []);

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
    const draft = resolveDeadlineDraft({
      isNew: todo === null,
      hasDeadline,
      dirty: deadlineTouched,
      originalDeadline: originalDeadline.current,
      inputValue: deadlineValue,
      now: Date.now(),
    });
    if (!draft.ok) {
      setError(draft.reason === 'past' ? '截止时间必须晚于现在' : '请选择截止时间');
      return;
    }
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
        deadline: draft.deadline,
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

  /** 标记完成 / 删除：二次确认在 App 侧统一做（与列表里的删除走同一条路径） */
  const runSecondary = async (action: () => Promise<void>): Promise<void> => {
    setSecondaryBusy(true);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : '操作失败');
    } finally {
      setSecondaryBusy(false);
    }
  };

  return (
    <div className="pb-44">
      <div className="mb-5 flex items-center">
        <h1 className="text-[22px] font-semibold leading-none text-ink">
          {todo ? '编辑' : '新建待办'}
        </h1>
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

      {/* 次要操作区：两个等宽描边按钮（绿=完成、红=删除），都不可逆，点击后都要二次确认 */}
      {todo ? (
        <div className="mt-5 border-t border-line pt-3">
          <div className="flex gap-2">
            {todo.done ? (
              <p className="flex h-11 flex-1 items-center justify-center text-[14px] text-faint">这件事已完成</p>
            ) : (
              <button
                type="button"
                className="flex h-11 flex-1 items-center justify-center rounded-[10px] border border-accent bg-transparent text-[14px] font-medium text-accent active:bg-accent-soft disabled:opacity-40"
                disabled={busy || secondaryBusy}
                onClick={() => (onDone ? void runSecondary(() => onDone(todo)) : undefined)}
              >
                {todo.repeat.kind === 'none' ? '标记完成' : '完成这一次'}
              </button>
            )}
            <button
              type="button"
              className="flex h-11 flex-1 items-center justify-center rounded-[10px] border border-alert bg-transparent text-[14px] font-medium text-alert active:bg-alert-soft disabled:opacity-40"
              disabled={busy || secondaryBusy}
              onClick={() => (onDelete ? void runSecondary(() => onDelete(todo)) : undefined)}
            >
              删除这件事
            </button>
          </div>
        </div>
      ) : null}

      {/* 底部固定操作栏：取消在左、保存在右（保存更宽，符合「这页主要是来改东西的」） */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 mx-auto max-w-md border-t border-line bg-paper px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        <div className="pointer-events-auto flex gap-2">
          <button type="button" className="btn-ghost flex-1" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn-primary flex-[2]"
            onClick={() => void handleSubmit()}
            disabled={busy}
          >
            {busy ? '保存中' : '保存'}
          </button>
        </div>
      </div>

      <FloatingBack onBack={onCancel} disabled={busy} />
    </div>
  );
}
