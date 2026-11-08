export interface SelectionToolbarProps {
  /** 已选条数 */
  count: number;
  /** 总条数（全选按钮的禁用条件） */
  total: number;
  /** 全选 */
  onSelectAll: () => void;
  /** 退出选择模式（不清数据） */
  onCancel: () => void;
  /** 删除已选 */
  onDelete: () => void;
  /** 正在删除 */
  busy?: boolean;
}

/**
 * 批量选择的顶部状态条 + 底部操作栏。
 *
 * 抽成共用组件是刻意的：主页和历史页都要「长按进入选择、批量删除」，
 * 两套实现迟早会出现「一边能全选、一边不能」这种不一致。
 */
export function SelectionHeader({
  count,
  total,
  onSelectAll,
  onCancel,
}: Pick<SelectionToolbarProps, 'count' | 'total' | 'onSelectAll' | 'onCancel'>): JSX.Element {
  return (
    <div className="mb-4 flex items-center justify-between rounded-card border border-line bg-surface px-3 py-2">
      <p className="text-[13px] text-ink">已选 {count} 项</p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="text-[13px] text-accent disabled:text-faint"
          onClick={onSelectAll}
          disabled={total === 0 || count === total}
        >
          全选
        </button>
        <button type="button" className="text-[13px] text-soft" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

/**
 * 底部删除操作栏（贴底，带安全区）。
 */
export function SelectionFooter({ count, onDelete, busy = false }: Pick<SelectionToolbarProps, 'count' | 'onDelete' | 'busy'>): JSX.Element {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 mx-auto max-w-md px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <button
        type="button"
        className="btn pointer-events-auto w-full bg-alert text-white disabled:opacity-40"
        onClick={onDelete}
        disabled={count === 0 || busy}
      >
        {busy ? '删除中' : `删除${count > 0 ? ` ${count} 项` : ''}`}
      </button>
    </div>
  );
}
