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
      label: [
        // 交给谁：回执正文里的 @ 被转成了全角，这里按消息的 mentions 标出来
        `${t("子任务回执")} → ${message.mentions.map((name) => `@${name}`).join(" ")}`,
        status,
        result?.[1] ? t("结果见 #{0}", { 0: result[1] }) : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
      text: (result?.[2] ?? note ?? "").trim(),
    };
  }
  // 委派：正文就是「@对方 任务说明」，@ 谁照原样露出
  return { label: t("委派"), text: message.content.trim() };
}

/** 和消息正文一致：邮箱里的 @ 不算提及 */
const mentionPattern = /(?<![A-Za-z0-9_.])@[\p{L}\p{N}_.-]+/gu;

/** 把一段纯文本切成普通文字和 @提及，卡片里给 @ 上和正文一样的高亮 */
export function splitMentions(text: string): Array<{ text: string; mention: boolean }> {
  const parts: Array<{ text: string; mention: boolean }> = [];
  let cursor = 0;
  for (const match of text.matchAll(mentionPattern)) {
    if (match.index > cursor) parts.push({ text: text.slice(cursor, match.index), mention: false });
    parts.push({ text: match[0], mention: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), mention: false });
  return parts;
}
