/**
 * 应用根组件（骨架阶段）。
 * 后续阶段接入：顶部常驻卡片 + 待办列表 + 新建面板 + 设置。
 */
export default function App(): JSX.Element {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-md flex-col px-4 pb-24 pt-6">
      <header className="mb-4 px-1">
        <h1 className="text-2xl font-bold tracking-tight text-white">做了么</h1>
        <p className="mt-0.5 text-xs text-ink-500">六档提醒，不漏事。</p>
      </header>

      <section className="card p-5">
        <p className="text-xs font-medium uppercase tracking-widest text-ink-500">常驻 · 最近一件事</p>
        <p className="mt-3 text-base text-ink-300">工程骨架已就绪，正在接入待办与提醒调度。</p>
      </section>
    </div>
  );
}
