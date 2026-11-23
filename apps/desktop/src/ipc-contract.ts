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
  /** 网页把顶栏高度和主题颜色同步给主进程（overlay 配色、红黄绿按钮位置） */
  titlebarAppearance: "superhive:titlebar:appearance",
  /** 主进程通知页面进出全屏 */
  windowFullscreen: "superhive:window:fullscreen",
  /** preload 同步问主进程：这个页面能不能拿到桌面端能力（答本机 Hive 的地址，或 null） */
  originQuery: "superhive:origin:query",
  /** 网页首屏画好了：主进程收起启动加载画面 */
  appReady: "superhive:app:ready",
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
