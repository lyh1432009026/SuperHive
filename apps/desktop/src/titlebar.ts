/**
 * 自定义标题栏：去掉系统那条标题栏，让网页自己的顶栏顶到窗口最上面。
 *
 * - macOS：titleBarStyle "hidden"，红黄绿按钮浮在左侧栏顶上那一行，垂直居中（位置随网页顶栏高度调整）；
 * - Windows / Linux：titleBarStyle "hidden" + titleBarOverlay，保留系统的最小化、最大化、关闭按钮
 *   （Win11 悬停最大化按钮的贴靠布局照常可用），按钮底色和图标颜色跟网页主题走；
 * - SUPERHIVE_DESKTOP_TITLEBAR=native：退回系统标题栏（某些 Linux 窗口管理器画不出 overlay 时用）。
 *
 * 这里只放纯函数，方便单测；和 Electron 打交道的部分在 main.ts。
 */
import type { BrowserWindowConstructorOptions } from "electron";
import { isTrustedSender, type SenderLike } from "./ipc-guard.js";

export type TitlebarMode = "mac" | "overlay" | "native";

/** 网页同步过来的顶栏外观 */
export type TitlebarAppearance = {
  /** 顶栏高度（CSS 像素），随界面密度变化 */
  height: number;
  /** overlay 底色：和右上角顶栏的背景一致 */
  color: string;
  /** 窗口按钮图标颜色 */
  symbolColor: string;
  /** 窗口失焦时的图标颜色（变淡，和系统其他窗口一样） */
  inactiveSymbolColor: string;
  /** 网页弹窗打开时，遮罩盖住右上角后那块的颜色：overlay 底色临时换成它，系统按钮跟着变暗 */
  scrim?: string;
};

export const DEFAULT_HEADER_HEIGHT = 52;

export function titlebarMode(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined> = {},
): TitlebarMode {
  if (env.SUPERHIVE_DESKTOP_TITLEBAR === "native") return "native";
  if (platform === "darwin") return "mac";
  if (platform === "win32" || platform === "linux") return "overlay";
  return "native";
}

/** 网页里 html 上的平台标记 */
export function desktopPlatform(platform: string): "mac" | "win" | "linux" | "other" {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "win";
  if (platform === "linux") return "linux";
  return "other";
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** 校验网页发来的外观：只接受 #rrggbb 和合理范围内的整数高度，别的一概不认 */
export function parseAppearance(input: unknown): TitlebarAppearance | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  const height = value.height;
  if (typeof height !== "number" || !Number.isFinite(height)) return undefined;
  const rounded = Math.round(height);
  if (rounded < 28 || rounded > 80) return undefined;
  const colors = [value.color, value.symbolColor, value.inactiveSymbolColor];
  if (!colors.every((color) => typeof color === "string" && HEX_COLOR.test(color)))
    return undefined;
  // 遮罩色可有可无；给了但不是 #rrggbb 就当没给，不影响其余外观
  const scrim =
    typeof value.scrim === "string" && HEX_COLOR.test(value.scrim)
      ? value.scrim.toLowerCase()
      : undefined;
  return {
    height: rounded,
    color: (value.color as string).toLowerCase(),
    symbolColor: (value.symbolColor as string).toLowerCase(),
    inactiveSymbolColor: (value.inactiveSymbolColor as string).toLowerCase(),
    ...(scrim ? { scrim } : {}),
  };
}

/** 红黄绿按钮组的高度（按钮本身 14px 左右），用来在顶栏里垂直居中 */
const MAC_BUTTONS_HEIGHT = 14;
/** 按钮组距窗口左边 */
export const MAC_BUTTONS_X = 18;

export function macButtonPosition(headerHeight: number): { x: number; y: number } {
  return { x: MAC_BUTTONS_X, y: Math.max(0, Math.round((headerHeight - MAC_BUTTONS_HEIGHT) / 2)) };
}

export function overlayOptions(
  appearance: TitlebarAppearance,
  focused: boolean,
): { color: string; symbolColor: string; height: number } {
  return {
    color: appearance.scrim ?? appearance.color,
    symbolColor: focused ? appearance.symbolColor : appearance.inactiveSymbolColor,
    height: appearance.height,
  };
}

/** 网页还没同步外观时用的默认值：和 tokens.css 的 --bg-main / --text-secondary 对齐 */
export function defaultAppearance(dark: boolean): TitlebarAppearance {
  return dark
    ? {
        height: DEFAULT_HEADER_HEIGHT,
        color: "#212121",
        symbolColor: "#b4b4b4",
        inactiveSymbolColor: "#6e6e6e",
      }
    : {
        height: DEFAULT_HEADER_HEIGHT,
        color: "#ffffff",
        symbolColor: "#5d5d5d",
        inactiveSymbolColor: "#ababab",
      };
}

/** 建主窗口时和标题栏有关的选项 */
export function titlebarWindowOptions(
  mode: TitlebarMode,
  appearance: TitlebarAppearance,
): Partial<BrowserWindowConstructorOptions> {
  if (mode === "mac") {
    return {
      titleBarStyle: "hidden",
      trafficLightPosition: macButtonPosition(appearance.height),
    };
  }
  if (mode === "overlay") {
    return { titleBarStyle: "hidden", titleBarOverlay: overlayOptions(appearance, true) };
  }
  return {};
}

/** 主进程收到网页同步的外观：来源不可信或数据不合法都返回 undefined，什么都不改 */
export function acceptAppearance(
  event: SenderLike,
  input: unknown,
  allowed: { origin: string | undefined; webContentsIds: ReadonlySet<number> },
): TitlebarAppearance | undefined {
  if (!isTrustedSender(event, allowed)) return undefined;
  return parseAppearance(input);
}
