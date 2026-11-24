/** 桌面端原生界面（菜单、对话框、启动页）的中英文案；网页里的文案在 apps/web 的 i18n 里 */
const texts = {
  splashStarting: { zh: "正在启动本机 Hive…", en: "Starting the local Hive…" },
  splashConnecting: { zh: "正在连接本机 Hive…", en: "Connecting to the local Hive…" },
  splashLoading: { zh: "正在打开界面…", en: "Opening SuperHive…" },
  splashSlow: {
    zh: "比平时慢一些，第一次启动要准备数据，请稍等",
    en: "Taking longer than usual — the first launch sets up your data",
  },
  splashLog: { zh: "日志：{log}", en: "Log: {log}" },
  serverStopped: {
    zh: "本机 Hive 已停止运行（退出码 {code}）。",
    en: "The local Hive stopped running (exit code {code}).",
  },
  pageFailed: {
    zh: "界面没能加载：{reason}",
    en: "Couldn't load the app: {reason}",
  },
  startFailedTitle: { zh: "SuperHive 没能启动", en: "SuperHive couldn't start" },
  retry: { zh: "重试", en: "Retry" },
  quit: { zh: "退出", en: "Quit" },
  openLogs: { zh: "打开日志目录", en: "Open Log Folder" },
  docs: { zh: "使用文档", en: "Documentation" },
  issues: { zh: "反馈问题", en: "Report an Issue" },
  openInBrowser: { zh: "在浏览器中打开", en: "Open in Browser" },
  file: { zh: "文件", en: "File" },
  edit: { zh: "编辑", en: "Edit" },
  view: { zh: "视图", en: "View" },
  window: { zh: "窗口", en: "Window" },
  help: { zh: "帮助", en: "Help" },
  pickAttachments: { zh: "添加附件", en: "Add Attachments" },
  newTerminal: { zh: "新建终端", en: "New Terminal" },
  toggleTerminalMaximized: { zh: "最大化 / 还原终端", en: "Maximize / Restore Terminal" },
  toggleTerminalPosition: {
    zh: "终端移到右侧 / 底部",
    en: "Move Terminal Right / Bottom",
  },
  connectedExisting: {
    zh: "已连上本机正在运行的 Hive（{origin}）。退出桌面端不会停止它。",
    en: "Connected to the Hive already running on this computer ({origin}). Quitting the app won't stop it.",
  },
} satisfies Record<string, { zh: string; en: string }>;

export type TextKey = keyof typeof texts;
export type Lang = "zh" | "en";

export function langFor(locale: string): Lang {
  return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function text(lang: Lang, key: TextKey, params: Record<string, string> = {}): string {
  return texts[key][lang].replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);
}
