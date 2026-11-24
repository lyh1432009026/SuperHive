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

/** 盖住整个窗口、带遮罩的弹层：打开时右上角系统按钮那块也要跟着变暗 */
export const MODAL_SELECTOR =
  'dialog[open], [aria-modal="true"], .activity-layer, .file-preview-backdrop, .attachment-lightbox';

type Rgba = { r: number; g: number; b: number; a: number };

function parseRgba(value: string): Rgba | undefined {
  const match =
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(
      value.trim(),
    );
  if (!match) return undefined;
  const alpha = match[4];
  const a =
    alpha === undefined
      ? 1
      : alpha.endsWith("%")
        ? Number.parseFloat(alpha) / 100
        : Number.parseFloat(alpha);
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a };
}

/**
 * 把从上到下叠着的几层背景色合成一个不透明的颜色（最底下垫 base）。
 * layers[0] 是最上面那层；遇到不透明的层就不再往下看。
 */
export function compositeColors(layers: string[], base: string): string | undefined {
  const parsed: Rgba[] = [];
  for (const layer of layers) {
    const color = parseRgba(layer);
    if (!color || color.a <= 0) continue;
    parsed.push(color);
    if (color.a >= 1) break;
  }
  const bottom = toHexColor(base);
  if (!bottom) return undefined;
  let r = Number.parseInt(bottom.slice(1, 3), 16);
  let g = Number.parseInt(bottom.slice(3, 5), 16);
  let b = Number.parseInt(bottom.slice(5, 7), 16);
  for (const color of parsed.reverse()) {
    r = color.r * color.a + r * (1 - color.a);
    g = color.g * color.a + g * (1 - color.a);
    b = color.b * color.a + b * (1 - color.a);
  }
  return toHexColor(`rgb(${r}, ${g}, ${b})`);
}

/**
 * 弹窗打开时右上角那块实际画出来的颜色：取窗口右上角那个点上叠着的所有元素的背景色，从上往下合成。
 * 系统按钮盖在网页上面，网页的遮罩画不到它们身上，只能把这个颜色告诉窗口，让按钮底色跟着变暗。
 */
export function readCornerColor(base: string): string | undefined {
  if (typeof document.elementsFromPoint !== "function") return undefined;
  const stack = document.elementsFromPoint(Math.max(0, window.innerWidth - 2), 2);
  return compositeColors(
    stack.map((element) => getComputedStyle(element).backgroundColor),
    base,
  );
}

/** 遮罩淡入的时长（--duration）过后再取一次颜色，取到的是淡入完的样子 */
const SCRIM_SETTLE_MS = 260;

/**
 * 开始同步：主题（data-theme）或界面密度（data-density）一变就重新发一次；
 * Windows / Linux 上弹窗打开、关上时，把右上角那块的颜色换成遮罩下的颜色 / 换回来。返回停止函数。
 */
export function syncDesktopTitlebar(
  bridge: DesktopBridge | undefined = desktopBridge(),
  root: HTMLElement = document.documentElement,
  read: (root: HTMLElement) => DesktopTitlebarAppearance | undefined = readTitlebarAppearance,
  readCorner: (base: string) => string | undefined = readCornerColor,
): () => void {
  const titlebar = bridge?.titlebar;
  if (!titlebar || titlebar.mode === "native") return () => undefined;
  let last = "";
  let modalOpen = false;
  const push = () => {
    const appearance = read(root);
    if (!appearance) return;
    const scrim = modalOpen ? readCorner(appearance.color) : undefined;
    const next = scrim && scrim !== appearance.color ? { ...appearance, scrim } : appearance;
    const key = JSON.stringify(next);
    if (key === last) return;
    last = key;
    titlebar.setAppearance(next);
  };
  push();
  const observer = new MutationObserver(push);
  observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-density"] });
  if (titlebar.mode !== "overlay" || !document.body) return () => observer.disconnect();

  // 只在「有没有弹窗」变了的时候取色：消息流在弹窗后面刷新不会每帧都去量
  let frame = 0;
  let settle: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    frame = 0;
    const open = document.querySelector(MODAL_SELECTOR) !== null;
    if (open === modalOpen) return;
    modalOpen = open;
    push();
    clearTimeout(settle);
    if (open) settle = setTimeout(push, SCRIM_SETTLE_MS);
  };
  const modalObserver = new MutationObserver(() => {
    if (!frame) frame = requestAnimationFrame(check);
  });
  modalObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["open", "aria-modal"],
  });
  return () => {
    observer.disconnect();
    modalObserver.disconnect();
    if (frame) cancelAnimationFrame(frame);
    clearTimeout(settle);
  };
}
