/**
 * 预加载脚本：沙箱里运行，只经 contextBridge 暴露一个很窄的 window.superhiveDesktop。
 * 只有页面来源是主进程告诉我们的本机 Hive 地址时才暴露；跳到别的地方（本来也会被拦下）什么都拿不到。
 * 主进程那边还会再按 senderFrame 校验一次，这里只是第一道。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  IPC,
  ORIGIN_ARG_PREFIX,
  type TerminalCreateRequest,
  type TerminalCreateResult,
  type TerminalExitEvent,
} from "./ipc-contract.js";

const allowedOrigin = process.argv
  .find((arg) => arg.startsWith(ORIGIN_ARG_PREFIX))
  ?.slice(ORIGIN_ARG_PREFIX.length);

if (allowedOrigin && window.location.origin === allowedOrigin && window.top === window) {
  const api = {
    /** 网页用来判断能力的版本号，接口有不兼容的变化时加 1 */
    version: 1,
    platform: process.platform,
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
    },
  };
  contextBridge.exposeInMainWorld("superhiveDesktop", Object.freeze(api));
}
