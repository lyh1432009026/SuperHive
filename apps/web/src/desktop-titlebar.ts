/**
 * 桌面端去掉了系统标题栏：把网页顶栏的高度和主题颜色同步给窗口，
 * Windows / Linux 右上角的系统按钮底色、图标颜色和高度跟着主题、界面密度实时变；macOS 据此把红黄绿按钮垂直居中。
 * 浏览器里打开时没有桌面端接口，什么都不做。
 */
import {
  desktopBridge,
  type DesktopBridge,
  type DesktopTitlebarAppearance,
} from "./desktop-bridge";

/** 把 getComputedStyle 给的 rgb()/rgba()/#hex 颜色转成 #rrggbb；认不出来返回 undefined */
export function toHexColor(value: string): string | undefined {
  const text = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  if (/^#[0-9a-f]{3}$/.test(text)) return `#${[...text.slice(1)].map((c) => c + c).join("")}`;
  const match = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/.exec(text);
  if (!match) return undefined;
  return `#${match
    .slice(1, 4)
    .map((part) =>
      Math.min(255, Math.round(Number(part)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** 读当前主题下的顶栏外观：底色是右上角顶栏的背景，图标用次要文字色，失焦时用更淡的三级文字色 */
export function readTitlebarAppearance(
  root: HTMLElement = document.documentElement,
): DesktopTitlebarAppearance | undefined {
  const probe = document.createElement("span");
  probe.style.cssText =
    "position:absolute;visibility:hidden;pointer-events:none;background-color:var(--bg-main);color:var(--text-secondary);border-top:1px solid var(--text-tertiary);height:var(--header-height)";
  root.appendChild(probe);
  try {
    const style = getComputedStyle(probe);
    const color = toHexColor(style.backgroundColor);
    const symbolColor = toHexColor(style.color);
    const inactiveSymbolColor = toHexColor(style.borderTopColor);
    const height = Number.parseFloat(style.height);
    if (!color || !symbolColor || !inactiveSymbolColor || !(height > 0)) return undefined;
    return { height, color, symbolColor, inactiveSymbolColor };
  } finally {
    probe.remove();
  }
}

/** 开始同步：主题（data-theme）或界面密度（data-density）一变就重新发一次；返回停止函数 */
export function syncDesktopTitlebar(
  bridge: DesktopBridge | undefined = desktopBridge(),
  root: HTMLElement = document.documentElement,
  read: (root: HTMLElement) => DesktopTitlebarAppearance | undefined = readTitlebarAppearance,
): () => void {
  const titlebar = bridge?.titlebar;
  if (!titlebar || titlebar.mode === "native") return () => undefined;
  let last = "";
  const push = () => {
    const appearance = read(root);
    if (!appearance) return;
    const key = JSON.stringify(appearance);
    if (key === last) return;
    last = key;
    titlebar.setAppearance(appearance);
  };
  push();
  const observer = new MutationObserver(push);
  observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-density"] });
  return () => observer.disconnect();
}
