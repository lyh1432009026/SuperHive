/** 主进程与 preload 共用的 IPC 通道名和数据形状（preload 只引类型和常量，打包时内联） */
export const IPC = {
  terminalCreate: "superhive:terminal:create",
  terminalWrite: "superhive:terminal:write",
  terminalResize: "superhive:terminal:resize",
  terminalKill: "superhive:terminal:kill",
  terminalData: "superhive:terminal:data",
  terminalExit: "superhive:terminal:exit",
  /** 主进程菜单「新建终端」通知页面 */
  terminalNewRequest: "superhive:terminal:new-request",
} as const;

export type TerminalCreateRequest = {
  /** 房间工作区目录；没有或不存在时用用户主目录。允许 ~ 开头 */
  cwd?: string | null;
  cols?: number;
  rows?: number;
};

export type TerminalCreateResult = {
  id: string;
  shell: string;
  cwd: string;
};

export type TerminalExitEvent = { id: string; exitCode: number; signal?: number };

/** preload 读到的、允许暴露能力的页面来源，经 additionalArguments 传入 */
export const ORIGIN_ARG_PREFIX = "--superhive-origin=";
