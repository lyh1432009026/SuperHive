/**
 * 全局快捷键：表驱动，帮助面板和按键处理用同一份定义，新增快捷键只改这里。
 */

export type ShortcutId = "search" | "goto" | "next-attention" | "help";

export type Shortcut = {
  /** 按键序列；Mod 在 macOS 上显示为 ⌘，其它系统显示为 Ctrl */
  keys: string[];
  /** 中文说明，经 t() 翻译 */
  label: string;
  group: "全局" | "输入框" | "房间列表" | "面板和弹窗";
  /** 只在说明里列出、由各组件自己处理的快捷键没有 id */
  id?: ShortcutId;
};

export const SHORTCUTS: Shortcut[] = [
  { id: "goto", keys: ["Mod", "P"], label: "跳转到房间、Agent 或任务", group: "全局" },
  { id: "next-attention", keys: ["Mod", "J"], label: "跳到下一个要你处理的任务", group: "全局" },
  { id: "search", keys: ["Mod", "K"], label: "搜索所有房间的消息", group: "全局" },
  { id: "help", keys: ["?"], label: "显示快捷键（焦点不在输入框时）", group: "全局" },
  { id: "help", keys: ["Mod", "/"], label: "显示快捷键（任何时候）", group: "全局" },
  { keys: ["Mod", "Enter"], label: "发送消息（不管设置成哪种发送方式都能用）", group: "输入框" },
  { keys: ["Enter"], label: "按设置里的发送方式：发送，或换行", group: "输入框" },
  { keys: ["Shift", "Enter"], label: "换行", group: "输入框" },
  { keys: ["@"], label: "选择要 @ 的成员，Tab 或 Enter 选中", group: "输入框" },
  { keys: ["↑", "↓"], label: "输入框为空时翻看自己发过的消息", group: "输入框" },
  { keys: ["Esc"], label: "收起 @ 候选，或退出翻看历史", group: "输入框" },
  { keys: ["Alt", "↑"], label: "把选中的置顶房间上移一格", group: "房间列表" },
  { keys: ["Alt", "↓"], label: "把选中的置顶房间下移一格", group: "房间列表" },
  { keys: ["Esc"], label: "拖动置顶房间时取消，房间回到原位", group: "房间列表" },
  { keys: ["↑", "↓"], label: "在列表里移动", group: "面板和弹窗" },
  { keys: ["Enter"], label: "打开选中的一项", group: "面板和弹窗" },
  { keys: ["Esc"], label: "关闭面板或弹窗", group: "面板和弹窗" },
];

export function isMacPlatform(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

export function keyLabel(key: string, mac = isMacPlatform()): string {
  if (key === "Mod") return mac ? "⌘" : "Ctrl";
  if (key === "Alt") return mac ? "⌥" : "Alt";
  if (key === "Shift") return mac ? "⇧" : "Shift";
  return key;
}

/**
 * 一组按键写成一个标签：macOS 用符号连写（⌘↵、⇧↵），其它系统用 + 连接（Ctrl+Enter）。
 * 输入框底部的发送提示和设置里的发送方式都用它，两处写法一致。
 */
export function keyCombo(keys: string[], mac = isMacPlatform()): string {
  const parts = keyParts(keys, mac);
  return mac ? parts.join("") : parts.join("+");
}

/** 一组按键逐个的显示名：macOS 用符号（⌘ ⇧ ⌥ ↵），其它系统用文字（Ctrl Shift Alt Enter） */
export function keyParts(keys: string[], mac = isMacPlatform()): string[] {
  if (!mac) return keys.map((key) => keyLabel(key, false));
  const symbols: Record<string, string> = { Mod: "⌘", Shift: "⇧", Alt: "⌥", Enter: "↵" };
  return keys.map((key) => symbols[key] ?? key);
}

/** 焦点在可输入的地方：单键快捷键（比如 ?）不能抢用户在打的字 */
export function isTypingTarget(target: EventTarget | null): boolean {
  let element = target instanceof Element ? target : null;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  if (!element) return false;
  if (element instanceof HTMLElement && element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (element as HTMLInputElement).type;
  return !["button", "checkbox", "radio", "range", "submit", "reset", "color", "file"].includes(
    type,
  );
}

/**
 * 按键对应的全局快捷键。按物理键位（code）判断字母，输入法或 Alt 组合改了 key 也能认出来；
 * IME 组字中的按键一律忽略。
 */
export function matchShortcut(event: KeyboardEvent): ShortcutId | undefined {
  if (event.isComposing || event.keyCode === 229) return undefined;
  const mod = event.metaKey || event.ctrlKey;
  if (mod && !event.altKey && !event.shiftKey) {
    if (event.code === "KeyK" || event.key.toLowerCase() === "k") return "search";
    if (event.code === "KeyP" || event.key.toLowerCase() === "p") return "goto";
    if (event.code === "KeyJ" || event.key.toLowerCase() === "j") return "next-attention";
    if (event.code === "Slash" || event.key === "/") return "help";
  }
  if (
    event.key === "?" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !isTypingTarget(event.target)
  ) {
    return "help";
  }
  return undefined;
}
