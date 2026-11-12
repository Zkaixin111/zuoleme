import { useEffect } from 'react';

/** 确认框的语气：决定「确认」按钮是绿框还是红框 */
export type ConfirmTone = 'default' | 'danger';

export interface ConfirmDialogProps {
  /** 是否显示（受控） */
  open: boolean;
  /** 一句话问清楚要做什么，例如「删除「吃药」？」 */
  title: string;
  /** 补充后果，可以留空 */
  description?: string;
  /** 确认按钮文案，默认「确定」——**必须是动词**，不要用「是 / 否」 */
  confirmLabel?: string;
  /** 取消按钮文案 */
  cancelLabel?: string;
  /** `danger` = 不可撤销的操作（红框），`default` = 普通确认（绿框） */
  tone?: ConfirmTone;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 应用内确认对话框。
 *
 * **为什么不用 `window.confirm`**（这是它存在的唯一理由）：
 * 1. 系统弹窗的按钮文字由 WebView 自己的 locale 决定，跟页面 `lang="zh-CN"` 无关 ——
 *    真机上显示的是英文 `CANCEL / OK`，而整页界面都是中文；
 * 2. 系统弹窗是两个蓝字 + 白底方块，没有任何边框与语义色，和纸感配色完全不是一套东西。
 *
 * **「区分颜色要有框」**：两个按钮都是 44px 描边框，取消是灰框
 * （`border-line-strong`），确认按 `tone` 分：普通是深豆绿框（`border-action`），
 * 不可撤销的操作是砖红框（`border-alert`）。这套语言与编辑页的
 * 「标记完成 / 删除这件事」完全一致，用户在同一个应用里只学一次。
 *
 * 两个容易被忽略的细节：
 * - **点遮罩 = 取消**（危险操作的默认结果必须是「不做」）；
 * - **Esc = 取消**：桌面浏览器调试时手不用离开键盘，且与系统弹窗习惯一致。
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确定',
  cancelLabel = '取消',
  tone = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element | null {
  // Esc 取消：只在打开时挂监听，关闭就摘掉，避免全局常驻一个键盘处理器
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!open) {
    return null;
  }

  const confirmClass =
    tone === 'danger'
      ? 'border-alert text-alert'
      : 'border-action text-action';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-6"
      // 点遮罩 = 取消（危险操作的默认结果必须是「不做」）
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={description ? 'confirm-description' : undefined}
        className="card w-full max-w-[19rem] p-5"
        // 阻止冒泡：点卡片内部不该被当成「点遮罩」
        onClick={(event) => event.stopPropagation()}
      >
        <p id="confirm-title" className="text-[15px] font-semibold leading-snug text-ink">
          {title}
        </p>
        {description ? (
          <p id="confirm-description" className="mt-2 text-[12.5px] leading-relaxed text-soft">
            {description}
          </p>
        ) : null}

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            autoFocus
            className="flex h-11 flex-1 items-center justify-center rounded-[10px] border border-line-strong bg-surface text-[14px] font-medium text-soft active:opacity-60"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`flex h-11 flex-1 items-center justify-center rounded-[10px] border bg-transparent text-[14px] font-medium active:opacity-60 ${confirmClass}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
