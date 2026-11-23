/**
 * 预加载脚本：沙箱里运行，只经 contextBridge 暴露一个很窄的 window.superhiveDesktop。
 * 只有页面来源是主进程告诉我们的本机 Hive 地址时才暴露；跳到别的地方（本来也会被拦下）什么都拿不到。
 * 地址在页面加载时同步问主进程（窗口在本机 Hive 起好之前就建出来显示加载动画，建窗口时还不知道地址）；
 * 主进程只回答自己的主窗口顶层框架，别的一律回 null。IPC 每次还会再按 senderFrame 校验一次，这里只是第一道。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  IPC,
  TERMINAL_LAYOUT_ACTIONS,
  type TerminalAttachResult,
  type TerminalCreateRequest,
  type TerminalCreateResult,
  type TerminalExitEvent,
  type TerminalLayoutAction,
  type TerminalSessionInfo,
} from "./ipc-contract.js";
import { applyDesktopMarks, parseTitlebarArg, setFullscreenMark } from "./titlebar-dom.js";

function queryOrigin(): string | undefined {
  if (window.top !== window) return undefined;
  try {
    const value: unknown = ipcRenderer.sendSync(IPC.originQuery);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

const allowedOrigin = queryOrigin();

if (allowedOrigin && window.location.origin === allowedOrigin && window.top === window) {
  const titlebarMode = parseTitlebarArg(process.argv);
  let fullscreen = false;
  // 标记尽早打上（preload 跑在文档解析之前，html 元素可能还没有），免得页面先按普通网页排一遍再跳
  const mark = () => {
    const root = document.documentElement;
    if (root)
      applyDesktopMarks(root, { platform: process.platform, mode: titlebarMode, fullscreen });
    return Boolean(root);
  };
  if (!mark()) document.addEventListener("readystatechange", mark, { once: true });
  ipcRenderer.on(IPC.windowFullscreen, (_event: IpcRendererEvent, value: unknown) => {
    fullscreen = value === true;
    if (document.documentElement) setFullscreenMark(document.documentElement, fullscreen);
  });

  const api = {
    /** 网页用来判断能力的版本号，接口有不兼容的变化时加 1 */
    version: 1,
    platform: process.platform,
    /** 网页首屏画好了，收起桌面端的启动加载画面（重复调用无害） */
    ready: (): void => {
      ipcRenderer.send(IPC.appReady);
    },
    titlebar: {
      /** "mac"：红黄绿按钮在左上；"overlay"：系统按钮在右上；"native"：系统标题栏 */
      mode: titlebarMode,
      setAppearance: (appearance: {
        height: number;
        color: string;
        symbolColor: string;
        inactiveSymbolColor: string;
      }): void => {
        ipcRenderer.send(IPC.titlebarAppearance, {
          height: Number(appearance?.height),
          color: String(appearance?.color),
          symbolColor: String(appearance?.symbolColor),
          inactiveSymbolColor: String(appearance?.inactiveSymbolColor),
        });
      },
    },
    terminal: {
      create: (request: TerminalCreateRequest): Promise<TerminalCreateResult> =>
        ipcRenderer.invoke(IPC.terminalCreate, {
          cwd: typeof request?.cwd === "string" ? request.cwd : null,
          cols: Number(request?.cols) || undefined,
          rows: Number(request?.rows) || undefined,
        }),
      write: (id: string, data: string): void => {
        ipcRenderer.send(IPC.terminalWrite, String(id), String(data));
      },
      resize: (id: string, cols: number, rows: number): void => {
        ipcRenderer.send(IPC.terminalResize, String(id), Number(cols), Number(rows));
      },
      kill: (id: string): void => {
        ipcRenderer.send(IPC.terminalKill, String(id));
      },
      /** 页面刷新后：这个窗口里还在跑的终端 */
      list: (): Promise<TerminalSessionInfo[]> => ipcRenderer.invoke(IPC.terminalList),
      /** 接回一个终端，拿到最近的输出用来回放；终端已经没了时是 null */
      attach: (id: string): Promise<TerminalAttachResult | null> =>
        ipcRenderer.invoke(IPC.terminalAttach, String(id)),
      onData: (listener: (id: string, data: string) => void): (() => void) => {
        const handler = (_event: IpcRendererEvent, id: string, data: string) => listener(id, data);
        ipcRenderer.on(IPC.terminalData, handler);
        return () => ipcRenderer.removeListener(IPC.terminalData, handler);
      },
      onExit: (listener: (event: TerminalExitEvent) => void): (() => void) => {
        const handler = (_event: IpcRendererEvent, payload: TerminalExitEvent) => listener(payload);
        ipcRenderer.on(IPC.terminalExit, handler);
        return () => ipcRenderer.removeListener(IPC.terminalExit, handler);
      },
      /** 菜单里的「新建终端」 */
      onNewRequest: (listener: () => void): (() => void) => {
        const handler = () => listener();
        ipcRenderer.on(IPC.terminalNewRequest, handler);
        return () => ipcRenderer.removeListener(IPC.terminalNewRequest, handler);
      },
      /** 菜单里的「最大化 / 还原终端」「终端移到右侧 / 底部」 */
      onLayoutRequest: (listener: (action: TerminalLayoutAction) => void): (() => void) => {
        const handler = (_event: IpcRendererEvent, action: unknown) => {
          if (TERMINAL_LAYOUT_ACTIONS.includes(action as TerminalLayoutAction))
            listener(action as TerminalLayoutAction);
        };
        ipcRenderer.on(IPC.terminalLayoutRequest, handler);
        return () => ipcRenderer.removeListener(IPC.terminalLayoutRequest, handler);
      },
    },
  };
  contextBridge.exposeInMainWorld("superhiveDesktop", Object.freeze(api));
}
