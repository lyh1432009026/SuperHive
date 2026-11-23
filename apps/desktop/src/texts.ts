/** 桌面端原生界面（菜单、对话框、启动页）的中英文案；网页里的文案在 apps/web 的 i18n 里 */
const texts = {
  starting: { zh: "正在启动 SuperHive…", en: "Starting SuperHive…" },
  startFailedTitle: { zh: "SuperHive 没能启动", en: "SuperHive couldn't start" },
  startFailedDetail: {
    zh: "本机 Hive 没能启动：{reason}\n\n日志在：{log}",
    en: "The local Hive failed to start: {reason}\n\nLog: {log}",
  },
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
  newTerminal: { zh: "新建终端", en: "New Terminal" },
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
