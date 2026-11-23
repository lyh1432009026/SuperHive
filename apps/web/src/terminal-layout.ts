/**
 * 桌面端终端面板的位置和尺寸（参考 VS Code 的终端面板）：
 * - 停在对话区底部（默认）或右侧；任何位置都能最大化，铺满对话区，再按一次还原；
 * - 底部拖高度、右侧拖宽度，都有上下限，不会把对话挤没；对话区太窄放不下右侧时自动按底部显示（偏好不变，宽了再回右侧）；
 * - 位置、尺寸、是否最大化记在 localStorage，重启后保持。
 * 纯函数放这里，方便单测；浏览器里不会用到。
 */

export type TerminalPosition = "bottom" | "right";

export type TerminalLayout = {
  position: TerminalPosition;
  maximized: boolean;
  /** 在底部时的高度（px） */
  height: number;
  /** 在右侧时的宽度（px） */
  width: number;
};

export const TERMINAL_LAYOUT_KEY = "superhive.terminal-layout";
/** 老版本只记了高度 */
export const LEGACY_TERMINAL_HEIGHT_KEY = "superhive.terminal-height";

export const MIN_TERMINAL_HEIGHT = 140;
export const DEFAULT_TERMINAL_HEIGHT = 280;
export const MIN_TERMINAL_WIDTH = 320;
export const DEFAULT_TERMINAL_WIDTH = 560;
/** 终端在右侧时对话至少留这么宽（消息、输入框还能正常用） */
export const MIN_CHAT_WIDTH = 360;
/** 终端在底部时对话至少留这么高（输入框加几行消息） */
export const MIN_CHAT_HEIGHT = 180;

export const DEFAULT_TERMINAL_LAYOUT: TerminalLayout = {
  position: "bottom",
  maximized: false,
  height: DEFAULT_TERMINAL_HEIGHT,
  width: DEFAULT_TERMINAL_WIDTH,
};

function positiveInt(value: unknown, min: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) && number >= min ? Math.round(number) : fallback;
}

export function loadTerminalLayout(storage: Storage | undefined = safeStorage()): TerminalLayout {
  if (!storage) return { ...DEFAULT_TERMINAL_LAYOUT };
  let saved: Partial<Record<keyof TerminalLayout, unknown>> = {};
  try {
    const raw = storage.getItem(TERMINAL_LAYOUT_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") saved = parsed as typeof saved;
    }
  } catch {
    /* 坏数据：用默认值 */
  }
  const legacyHeight = storage.getItem(LEGACY_TERMINAL_HEIGHT_KEY);
  return {
    position: saved.position === "right" ? "right" : "bottom",
    maximized: saved.maximized === true,
    height: positiveInt(saved.height ?? legacyHeight, MIN_TERMINAL_HEIGHT, DEFAULT_TERMINAL_HEIGHT),
    width: positiveInt(saved.width, MIN_TERMINAL_WIDTH, DEFAULT_TERMINAL_WIDTH),
  };
}

export function saveTerminalLayout(
  layout: TerminalLayout,
  storage: Storage | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(TERMINAL_LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* 存储满了或被禁用：这次会话里照样生效 */
  }
}

/** 对话区放得下右侧终端吗：放不下时按底部显示 */
export function fitsRight(bodyWidth: number): boolean {
  return bodyWidth >= MIN_CHAT_WIDTH + MIN_TERMINAL_WIDTH;
}

/** 实际显示的位置：偏好是右侧但对话区太窄时按底部显示；还没量到尺寸（0）时照偏好 */
export function effectivePosition(position: TerminalPosition, bodyWidth: number): TerminalPosition {
  return position === "right" && bodyWidth > 0 && !fitsRight(bodyWidth) ? "bottom" : position;
}

/** 底部高度：不低于最小值，也不把对话挤到 MIN_CHAT_HEIGHT 以下；还没量到尺寸时只管下限 */
export function clampTerminalHeight(value: number, bodyHeight: number): number {
  const max =
    bodyHeight > 0 ? Math.max(MIN_TERMINAL_HEIGHT, bodyHeight - MIN_CHAT_HEIGHT) : Infinity;
  return Math.round(Math.min(max, Math.max(MIN_TERMINAL_HEIGHT, value)));
}

/** 右侧宽度：不窄于最小值，也不把对话挤到 MIN_CHAT_WIDTH 以下 */
export function clampTerminalWidth(value: number, bodyWidth: number): number {
  const max = bodyWidth > 0 ? Math.max(MIN_TERMINAL_WIDTH, bodyWidth - MIN_CHAT_WIDTH) : Infinity;
  return Math.round(Math.min(max, Math.max(MIN_TERMINAL_WIDTH, value)));
}

/** 刷新后恢复面板开着还是收着（只在这个窗口的会话里记，重启后终端进程本来就没了） */
export const TERMINAL_OPEN_KEY = "superhive.terminal-open";
export const TERMINAL_ACTIVE_KEY = "superhive.terminal-active";

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function sessionValue(key: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function setSessionValue(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.sessionStorage?.removeItem(key);
    else globalThis.sessionStorage?.setItem(key, value);
  } catch {
    /* 忽略 */
  }
}
