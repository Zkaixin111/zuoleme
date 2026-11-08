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
    // 底栏现在只剩「历史任务」一行（≈65 + safe），所以是 4.5rem 而不是之前两行时的 9rem
    expect(HOME).toContain('pb-[calc(4.5rem+env(safe-area-inset-bottom))]');
  });

  it('底栏本身带安全区（全面屏手势条不会压住按钮）', () => {
    expect(HOME).toContain('pb-[max(0.75rem,env(safe-area-inset-bottom))]');
  });
});

describe('版面：新建按钮上移到常驻卡下方，底栏只留历史任务', () => {
  it('新建按钮在 PinnedCard 之后（同一块 `selectionMode ? null` 分支里）', () => {
    const pinned = HOME.indexOf('<PinnedCard');
    const create = HOME.indexOf('新建待办');

    expect(pinned).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(pinned);
  });

  it('新建按钮包在 `mt-3` 容器里，与卡片同宽（不额外内缩）', () => {
    expect(HOME).toContain('<div className="mt-3">');
    // 允许出现的只有 w-full，不能出现 mx- 之类的额外内缩
    const createBlock = HOME.slice(HOME.indexOf('<div className="mt-3">'), HOME.indexOf('新建待办'));
    expect(createBlock).toContain('w-full');
    expect(createBlock).not.toMatch(/\b(?:mx-|ml-|mr-|w-\[calc)/);
  });

  it('底栏容器里只有「历史任务」，没有「新建待办」', () => {
    const bar = HOME.slice(HOME.indexOf('fixed inset-x-0 bottom-0 z-20'));

    expect(bar).toContain('历史任务 ·');
    expect(bar).not.toContain('新建待办');
  });

  it('历史任务是实底按钮：44px、白底、描边、10px 圆角', () => {
    expect(HOME).toContain(
      'flex h-11 w-full items-center justify-center rounded-[10px] border border-line bg-surface text-[13px] text-soft',
    );
  });

  it('历史任务上的数字用 faint 弱化（它是次要信息）', () => {
    expect(HOME).toContain('<span className="ml-1 text-faint">{doneCount}</span>');
  });

  it('主按钮靠尺寸/字重/深绿实底取得重量，仍然零阴影零渐变', () => {
    expect(HOME).toContain('btn-primary h-[52px] w-full rounded-[12px] text-[15px] font-semibold');
    expect(HOME).not.toMatch(/\bshadow-/);
    expect(HOME).not.toMatch(/bg-gradient-/);
  });

  it('空状态文案跟着改（按钮不在下面了）', () => {
    expect(HOME).toContain('点上面的「新建待办」加一件');
    expect(HOME).not.toContain('点下面的按钮加一件');
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
