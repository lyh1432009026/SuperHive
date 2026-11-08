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

/** 收起时卡片上的内容：一行标签（委派 / 子任务回执 · 状态 · 结果见 #N）和露出前两行的正文 */
export function machinePreview(message: ChatMessage): { label: string; text: string } {
  if (message.kind === "receipt") {
    const status = /^状态：(.+)$/m.exec(message.content)?.[1]?.trim();
    const result = /结果（#(\d+)）：?\n?([\s\S]*?)(?:\n子任务 ID：|$)/.exec(message.content);
    const note = /^说明：(.+)$/m.exec(message.content)?.[1]?.trim();
    return {
      label: [t("子任务回执"), status, result?.[1] ? t("结果见 #{0}", { 0: result[1] }) : undefined]
        .filter(Boolean)
        .join(" · "),
      text: (result?.[2] ?? note ?? "").trim(),
    };
  }
  // 委派：去掉开头的 @对方，正文就是任务说明
  return { label: t("委派"), text: message.content.replace(/^\s*(?:@[\w.-]+\s*)+/, "").trim() };
}
