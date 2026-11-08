import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 底部工具条的「实底」与主次层级（用户第 1、2 条反馈）。
 *
 * 问题不是定位坏了 —— 那两个按钮本来就在 `fixed` 容器里，祖先也没有 transform。
 * 问题在**视觉**：容器没有背景色，列表从按钮缝隙里透过去，看起来像「浮在内容流里」。
 * 所以这里锁三件事：
 * 1. 底栏有实底（`bg-paper`）+ 顶部发丝线，且**不再是** `pointer-events-none`；
 * 2. 内容区底部留白足够，最后一条待办不会被盖住；
 * 3. 主按钮（新建）比历史入口明显更重：52px vs 36px，深绿实底 vs 一行文字。
 */

const ROOT = new URL('../', import.meta.url);

/**
 * 读取仓库内的源码文件。
 *
 * @param relative 相对仓库根目录的路径
 */
function readSource(relative: string): string {
  return readFileSync(new URL(relative, ROOT), 'utf8');
}

const HOME = readSource('src/components/HomeView.tsx');
const SELECTION = readSource('src/components/SelectionToolbar.tsx');
const EDITOR = readSource('src/components/TodoEditor.tsx');

/** 底部工具条的外壳（主页与选择模式必须一致） */
const BAR_SHELL =
  'fixed inset-x-0 bottom-0 z-20 mx-auto max-w-md border-t border-line bg-paper px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]';

describe('底部工具条：实底 + 顶线，不再透出列表', () => {
  it('主页底栏是实底条（bg-paper + 顶部发丝线）', () => {
    expect(HOME).toContain(BAR_SHELL);
  });

  it('底栏容器不再是 pointer-events-none（否则背景色会挡住点击，按钮反而要单独放行）', () => {
    const bar = HOME.slice(HOME.indexOf('border-t border-line bg-paper px-3 pt-2'));
    expect(bar.slice(0, 2000)).not.toContain('pointer-events-none');
  });

  it('选择模式的删除栏用同一套外壳（两种模式下的底栏不能一个透一个不透）', () => {
    expect(SELECTION).toContain(BAR_SHELL);
    expect(SELECTION).not.toContain('pointer-events-none');
  });

  it('内容区底部留白按「底栏高度 + 安全区」算，不是拍脑袋的固定值', () => {
    expect(HOME).toContain('pb-[calc(9rem+env(safe-area-inset-bottom))]');
  });

  it('底栏本身带安全区（全面屏手势条不会压住按钮）', () => {
    expect(HOME).toContain('pb-[max(0.75rem,env(safe-area-inset-bottom))]');
  });
});

describe('主次分明：「新建待办」明显更重', () => {
  it('主按钮 52px 高、15px、半粗、12px 圆角、占满宽度', () => {
    expect(HOME).toContain('btn-primary h-[52px] w-full rounded-[12px] text-[15px] font-semibold');
  });

  it('历史任务降级成一行文字按钮（36px、13px、soft 色），不再是白底大块', () => {
    expect(HOME).toContain('mb-1.5 flex h-9 w-full items-center justify-center text-[13px] text-soft');
    // 不再有「历史任务」的白底卡片式按钮
    expect(HOME).not.toContain('rounded-control border border-line bg-surface text-[13px] text-soft');
  });

  it('历史任务上的数字用 faint 弱化（它是次要信息）', () => {
    expect(HOME).toContain('<span className="ml-1 text-faint">{doneCount}</span>');
  });

  it('两个按钮之间的间距是 6px（mb-1.5），并靠尺寸/字重取得层级而不是阴影', () => {
    expect(HOME).toContain('mb-1.5 flex h-9');
    expect(HOME).not.toMatch(/\bshadow-/);
    expect(HOME).not.toMatch(/bg-gradient-/);
  });

  it('主按钮确实比历史入口高（52 > 36）', () => {
    const primary = Number(HOME.match(/h-\[(\d+)px\] w-full rounded-\[12px\]/)?.[1]);
    const secondary = Number(HOME.match(/mb-1\.5 flex h-(\d+) /)?.[1]);

    expect(primary).toBe(52);
    // h-9 = 2.25rem = 36px
    expect(secondary).toBe(9);
    expect(primary).toBeGreaterThan(secondary * 4);
  });
});

describe('编辑页：「完成」「删除」是绿框/红框等宽按钮', () => {
  it('两个按钮等宽（flex-1）、44px 高、10px 圆角', () => {
    expect(EDITOR).toContain('flex gap-2');
    expect(EDITOR.match(/flex h-11 flex-1 items-center justify-center rounded-\[10px\]/g)).toHaveLength(2);
  });

  it('绿框：accent 描边 + accent 文字 + 透明底，按下态用 accent-soft', () => {
    expect(EDITOR).toContain(
      'border border-accent bg-transparent text-[14px] font-medium text-accent active:bg-accent-soft',
    );
  });

  it('红框：alert 描边 + alert 文字 + 透明底，按下态用 alert-soft', () => {
    expect(EDITOR).toContain(
      'border border-alert bg-transparent text-[14px] font-medium text-alert active:bg-alert-soft',
    );
  });

  it('不再是一行 justify-between 的文字链接', () => {
    expect(EDITOR).not.toContain('mt-6 flex items-center justify-between border-t border-line pt-3');
    // 分隔线还在，按钮组与上方内容分开
    expect(EDITOR).toContain('mt-5 border-t border-line pt-3');
  });

  it('二次确认仍由 App 统一做（编辑页只调 onDone / onDelete）', () => {
    expect(EDITOR).toContain('runSecondary(() => onDone(todo))');
    expect(EDITOR).toContain('runSecondary(() => onDelete(todo))');
    expect(EDITOR).not.toContain('window.confirm');
  });
});
