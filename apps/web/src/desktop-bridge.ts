/**
 * 桌面端（Electron）经 preload 暴露的能力。只在 SuperHive 桌面端、并且页面是本机 Hive 时才有；
 * 浏览器里打开（包括局域网、远程访问）时 window.superhiveDesktop 不存在，终端入口完全不出现。
 */
export type DesktopTerminalCreateResult = { id: string; shell: string; cwd: string };
export type DesktopTerminalExit = { id: string; exitCode: number; signal?: number };

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
};

export type DesktopBridge = {
  version: number;
  platform: string;
  terminal: DesktopTerminalApi;
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
  return value as DesktopBridge;
}
