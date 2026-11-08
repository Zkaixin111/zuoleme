export interface FloatingBackProps {
  /** 点击 / 手势返回统一走这一个入口 */
  onBack: () => void;
  /** 正在提交时禁用，避免文案与实际状态错位 */
  disabled?: boolean;
}

/**
 * 右下角浮动返回按钮。
 *
 * 为什么要单独做一个按钮：详情页被去掉之后，子页面（编辑 / 历史）只剩手势返回，
 * 而 Android 的侧滑手势在很多 ROM 上与「列表横向滑动」冲突，不能作为唯一入口。
 *
 * 位置：`bottom` 用 `calc` 压在底部操作栏**上方**，并叠加安全区，
 * 所以不会被操作栏遮住，也不会盖住全面屏的手势条。
 */
export function FloatingBack({ onBack, disabled = false }: FloatingBackProps): JSX.Element {
  return (
    <button
      type="button"
      aria-label="返回"
      disabled={disabled}
      onClick={onBack}
      style={{ bottom: 'calc(5.5rem + env(safe-area-inset-bottom))' }}
      className="fixed right-4 z-30 flex h-12 w-12 items-center justify-center rounded-full border border-line-strong bg-surface text-accent transition-transform active:scale-95 disabled:opacity-40"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M15 5l-7 7 7 7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
