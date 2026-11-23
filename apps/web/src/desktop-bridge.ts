/**
 * 桌面端（Electron）经 preload 暴露的能力。只在 SuperHive 桌面端、并且页面是本机 Hive 时才有；
 * 浏览器里打开（包括局域网、远程访问）时 window.superhiveDesktop 不存在，终端入口完全不出现。
 */
export type DesktopTerminalCreateResult = { id: string; shell: string; cwd: string };
export type DesktopTerminalExit = { id: string; exitCode: number; signal?: number };
export type DesktopTerminalSession = { id: string; shell: string; cwd: string };
export type DesktopTerminalAttach = DesktopTerminalSession & { replay: string };
export type DesktopTerminalLayoutAction = "maximize" | "position";

export type DesktopTerminalApi = {
  create(request: {
    cwd?: string | null;
    cols?: number;
    rows?: number;
  }): Promise<DesktopTerminalCreateResult>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string): void;
  onData(listener: (id: string, data: string) => void): () => void;
  onExit(listener: (event: DesktopTerminalExit) => void): () => void;
  onNewRequest(listener: () => void): () => void;
  /** 页面刷新后这个窗口里还在跑的终端（老版本桌面端没有，刷新就会结束终端） */
  list?(): Promise<DesktopTerminalSession[]>;
  /** 接回一个终端，拿到最近的输出用来回放；已经没了时是 null */
  attach?(id: string): Promise<DesktopTerminalAttach | null>;
  /** 菜单「最大化 / 还原终端」「终端移到右侧 / 底部」（老版本桌面端没有） */
  onLayoutRequest?(listener: (action: DesktopTerminalLayoutAction) => void): () => void;
};

export type DesktopTitlebarAppearance = {
  height: number;
  color: string;
  symbolColor: string;
  inactiveSymbolColor: string;
};

/** 系统标题栏去掉后，网页把顶栏高度和主题颜色同步给窗口（老版本桌面端没有这一项） */
export type DesktopTitlebarApi = {
  mode: "mac" | "overlay" | "native";
  setAppearance(appearance: DesktopTitlebarAppearance): void;
};

export type DesktopBridge = {
  version: number;
  platform: string;
  terminal: DesktopTerminalApi;
  titlebar?: DesktopTitlebarApi;
  /** 网页首屏画好了，桌面端收起启动加载画面（老版本桌面端没有这一项） */
  ready?: () => void;
};

declare global {
  interface Window {
    superhiveDesktop?: unknown;
  }
}

const TERMINAL_METHODS = [
  "create",
  "write",
  "resize",
  "kill",
  "onData",
  "onExit",
  "onNewRequest",
] as const;

/** 读取并校验桌面端能力；形状不对（版本不兼容、被别的脚本冒充）就当作不在桌面端 */
export function desktopBridge(
  source: unknown = globalThis.window?.superhiveDesktop,
): DesktopBridge | undefined {
  if (!source || typeof source !== "object") return undefined;
  const value = source as Partial<DesktopBridge>;
  if (value.version !== 1 || typeof value.platform !== "string") return undefined;
  const terminal = value.terminal as Partial<DesktopTerminalApi> | undefined;
  if (!terminal || TERMINAL_METHODS.some((name) => typeof terminal[name] !== "function")) {
    return undefined;
  }
  // 新加的可选能力形状不对就只去掉那一项（reattach 要 list 和 attach 都在）
  const optional = ["list", "attach", "onLayoutRequest"] as const;
  if (optional.some((name) => name in terminal && typeof terminal[name] !== "function")) {
    const cleaned: Partial<DesktopTerminalApi> = { ...terminal };
    for (const name of optional) if (typeof cleaned[name] !== "function") delete cleaned[name];
    return desktopBridge({ ...value, terminal: cleaned });
  }
  const titlebar = value.titlebar as Partial<DesktopTitlebarApi> | undefined;
  if (titlebar !== undefined && (!titlebar || typeof titlebar.setAppearance !== "function")) {
    // 标题栏接口形状不对只丢掉这一项，终端照常可用
    return { ...value, titlebar: undefined } as DesktopBridge;
  }
  return value as DesktopBridge;
}
