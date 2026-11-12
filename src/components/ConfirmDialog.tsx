export interface ConfirmDialogProps {
  open: boolean;
  /** 弹窗标题，例如「完成这件事？」 */
  title: string;
  /** 弹窗正文（补充说明） */
  message?: string;
  /** 确认按钮文案，默认「确认」 */
  confirmText?: string;
  /** 取消按钮文案，默认「取消」 */
  cancelText?: string;
  /**
   * 语气：danger = 红色确认按钮（删除等不可撤销操作）；
   * primary = 绿色确认按钮（完成等正向操作）。
   * 取消按钮始终为灰色描边，与确认按钮明确区分颜色。
   */
  tone?: 'danger' | 'primary';
  /** 提交中（禁用按钮，避免重复点击） */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 应用内确认弹窗（替代浏览器原生 window.confirm）。
 *
 * 原生 confirm 的按钮文案（CANCEL / OK）和样式由浏览器界面语言决定，
 * 网页无法改成中文、也无法改颜色。这里用自有弹窗：
 * 「取消」灰色描边框、「确认」绿色 / 红色实心带同色边框，弹窗本身带边框，
 * 颜色与框线在任何浏览器 / 系统语言下都一致。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  tone = 'primary',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element | null {
  if (!open) {
    return null;
  }

  const confirmClassName =
    tone === 'danger'
      ? 'border-red-400 bg-red-600 text-white hover:bg-red-500'
      : 'border-brand-400 bg-brand-600 text-white hover:bg-brand-500';

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onClick={() => {
        if (!busy) {
          onCancel();
        }
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-sm rounded-2xl border-2 border-white/25 bg-ink-800 p-5 shadow-card"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-base font-semibold leading-snug text-white">{title}</h2>
        {message ? <p className="mt-2 text-sm leading-relaxed text-ink-300">{message}</p> : null}

        <div className="mt-5 flex gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="flex-1 rounded-xl border-2 border-white/30 bg-white/5 px-4 py-3 text-sm font-medium text-ink-100 transition hover:bg-white/10 active:scale-[0.98] disabled:opacity-50"
          >
            {cancelText}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            autoFocus
            className={`flex-1 rounded-xl border-2 px-4 py-3 text-sm font-semibold transition active:scale-[0.98] disabled:opacity-50 ${confirmClassName}`}
          >
            {busy ? '处理中…' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
