/**
 * preload 在 html 上打的桌面端标记。网页的 CSS 只认这些属性，浏览器里打开时一个都没有，样式完全不受影响：
 * - data-desktop="mac" | "win" | "linux"：在桌面端里；
 * - data-titlebar="mac" | "overlay"：系统标题栏去掉了，网页要给窗口按钮让位、顶栏可拖动（native 时不加）；
 * - data-fullscreen：全屏（macOS 全屏时红黄绿按钮隐藏，让出的位置收回来）。
 */
import { desktopPlatform, type TitlebarMode } from "./titlebar.js";

type DatasetHost = { dataset: Record<string, string | undefined> };

export function applyDesktopMarks(
  root: DatasetHost,
  marks: { platform: string; mode: TitlebarMode; fullscreen?: boolean },
): void {
  root.dataset.desktop = desktopPlatform(marks.platform);
  if (marks.mode === "native") delete root.dataset.titlebar;
  else root.dataset.titlebar = marks.mode;
  setFullscreenMark(root, Boolean(marks.fullscreen));
}

export function setFullscreenMark(root: DatasetHost, fullscreen: boolean): void {
  if (fullscreen) root.dataset.fullscreen = "";
  else delete root.dataset.fullscreen;
}

/** preload 里传给页面的标题栏模式参数 */
export const TITLEBAR_ARG_PREFIX = "--superhive-titlebar=";

export function parseTitlebarArg(argv: readonly string[]): TitlebarMode {
  const value = argv
    .find((arg) => arg.startsWith(TITLEBAR_ARG_PREFIX))
    ?.slice(TITLEBAR_ARG_PREFIX.length);
  return value === "mac" || value === "overlay" ? value : "native";
}
