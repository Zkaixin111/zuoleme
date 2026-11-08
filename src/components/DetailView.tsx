import { formatDeadline, formatRemaining } from '../../shared/format';
import { reminderOffsetsFor } from '../../shared/reminders';
import { repeatLabel } from '../../shared/repeat';
import type { Todo } from '../../shared/types';

export interface DetailViewProps {
  todo: Todo;
  now: number;
  busy: boolean;
  onBack: () => void;
  onDone: (todo: Todo) => void;
  onEdit: (todo: Todo) => void;
  onDelete: (todo: Todo) => void;
}

/**
 * 提醒档位的中文摘要，例如「提前 3 小时、1 小时、到点」。
 *
 * 三种取值：不设时间 → 不提醒；关掉提前提醒 → 仅到点一次；否则按档位列表。
 *
 * @param todo 待办
 */
function reminderSummary(todo: Todo): string {
  if (todo.deadline === null) {
    return '不提醒（未设时间）';
  }
  if (!todo.advanceReminder) {
    return '仅到点提醒';
  }
  const labels = reminderOffsetsFor(todo.repeat, true).map((offset) =>
    offset.kind === 'due' ? '到点' : offset.label,
  );
  return `提前 ${labels.join('、')}`;
}

/** 一行右对齐的信息 */
function InfoRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <span className="shrink-0 text-xs text-faint">{label}</span>
      <span className="text-right text-[13px] leading-snug text-ink">{value}</span>
    </div>
  );
}

/**
 * 详情页：标题 + 剩余时间 + 内容正文 + 三项信息 + 操作。
 *
 * 这一页是「内容」唯一的展示位置——通知里只有标题和剩余时间。
 */
export function DetailView({ todo, now, busy, onBack, onDone, onEdit, onDelete }: DetailViewProps): JSX.Element {
  const hasDeadline = todo.deadline !== null;
  const remaining = todo.deadline === null ? 0 : todo.deadline - now;
  const overdue = !todo.done && hasDeadline && remaining <= 0;
  const statusText = todo.done ? '已完成' : !hasDeadline ? '待办' : overdue ? '已逾期' : '进行中';

  return (
    <div className="pb-28">
      <button type="button" className="btn-quiet -ml-2 mb-3" onClick={onBack}>
        返回
      </button>

      <h1 className="break-words text-[22px] font-semibold leading-snug text-ink">{todo.title}</h1>

      <p className={`mt-2 text-[15px] ${overdue ? 'text-alert' : hasDeadline ? 'text-accent' : 'text-soft'}`}>
        {todo.done ? '这件事已完成' : hasDeadline ? formatRemaining(remaining) : '不设截止时间'}
      </p>
      <p className="mt-1 text-xs text-faint">
        {hasDeadline ? `${formatDeadline(todo.deadline as number, now)} 截止` : '不设截止时间'}
      </p>

      <div className="my-5 border-t border-line" />

      <p className="text-xs text-faint">内容</p>
      {todo.content.length > 0 ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink">{todo.content}</p>
      ) : (
        <p className="mt-2 text-[15px] text-faint">没有写具体内容。</p>
      )}

      <div className="my-5 border-t border-line" />

      <div className="divide-y divide-line">
        <InfoRow label="截止时间" value={hasDeadline ? formatDeadline(todo.deadline as number, now) : '未设置'} />
        <InfoRow label="重复" value={repeatLabel(todo.repeat)} />
        <InfoRow label="提醒" value={reminderSummary(todo)} />
        <InfoRow label="状态" value={statusText} />
      </div>

      <div className="mt-6 flex gap-2">
        <button type="button" className="btn-primary flex-1" disabled={busy} onClick={() => onDone(todo)}>
          {todo.done ? '标记未完成' : todo.repeat.kind === 'none' ? '标记完成' : '完成这次'}
        </button>
        <button type="button" className="btn-ghost flex-1" onClick={() => onEdit(todo)}>
          编辑
        </button>
      </div>

      <button
        type="button"
        className="mt-6 w-full py-3 text-center text-[13px] text-alert"
        onClick={() => onDelete(todo)}
      >
        删除这件事
      </button>
    </div>
  );
}
