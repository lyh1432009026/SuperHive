import type { ChatMessage } from "@superhive/protocol";
import { t } from "./i18n";

/**
 * Agent 之间往来的「机器消息」：hive_invoke 派出的委派、服务端代发的子任务回执。
 * 只在对象全是 Agent 时弱化（回执 @ 的是人时，比如定时任务没完成，仍照常显示）。
 */
export function isMachineMessage(
  message: ChatMessage,
  isAgent: (name: string) => boolean,
): boolean {
  if (message.kind !== "receipt" && message.kind !== "delegation") return false;
  return message.mentions.length > 0 && message.mentions.every(isAgent);
}

/** 收起时显示的一行摘要 */
export function machineSummary(message: ChatMessage): string {
  if (message.kind === "receipt") {
    const status = /^状态：(.+)$/m.exec(message.content)?.[1]?.trim();
    const result = /结果（#(\d+)）/.exec(message.content)?.[1];
    return [t("子任务回执"), status, result ? t("结果见 #{0}", { 0: result }) : undefined]
      .filter(Boolean)
      .join(" · ");
  }
  const firstLine = message.content
    .replace(/^\s*(?:@[\w.-]+\s*)+/, "")
    .split("\n")
    .find((line) => line.trim())
    ?.trim();
  const text = firstLine ?? "";
  return `${t("委派")} · ${text.length > 80 ? `${text.slice(0, 79)}…` : text}`;
}
