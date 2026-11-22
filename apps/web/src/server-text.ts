import {
  questionBodyText,
  renderServerText,
  type ChatMessage,
  type WireServerText,
} from "@superhive/protocol";
import { getLocale } from "./i18n";

/**
 * 服务端发来的文字按当前界面语言显示：服务端在中文字段旁边带一份结构化文案（见 protocol 的
 * server-text.ts），这里用它覆盖中文字段。键不认识（服务端比网页新）时保留原文。
 * 结构化字段本身保留，切换语言后再走一遍就能换成新语言。
 */
function isServerText(value: unknown): value is WireServerText {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { key?: unknown }).key === "string"
  );
}

export function serverString(text: unknown, fallback: string): string;
export function serverString(text: unknown, fallback?: string): string | undefined;
export function serverString(text: unknown, fallback?: string): string | undefined {
  return (isServerText(text) ? renderServerText(text, getLocale()) : undefined) ?? fallback;
}

/** 结构化字段 → 它覆盖的中文字段 */
const PAIRS: Array<[text: string, plain: string]> = [
  ["detailText", "detail"],
  ["progressText", "progress"],
  ["noteText", "note"],
  ["reasonText", "reason"],
];

/** 深度遍历服务端返回的数据（REST 响应、WebSocket 事件），把带结构化文案的字段换成当前语言 */
export function localizeServerPayload<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => localizeServerPayload(item)) as T;
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    result[key] = typeof item === "object" && item !== null ? localizeServerPayload(item) : item;
  }
  for (const [textKey, plainKey] of PAIRS) {
    if (typeof source[plainKey] === "string" && isServerText(source[textKey])) {
      result[plainKey] = serverString(source[textKey], source[plainKey]);
    }
  }
  // 消息（content）、HTTP 错误体（error）、WebSocket error 事件（message）共用 text 字段
  if (isServerText(source.text)) {
    for (const plainKey of ["content", "error", "message"]) {
      if (typeof source[plainKey] === "string") {
        result[plainKey] = serverString(source.text, source[plainKey]);
      }
    }
  }
  // 权限申请的两个选项是服务端定的，按选项键（A 允许 / B 拒绝）换成当前语言
  if (source.approval && isQuestionWithOptions(result.question)) {
    result.question = {
      ...result.question,
      options: result.question.options.map((option) => {
        const key = APPROVAL_OPTIONS[option.key];
        return key ? { ...option, label: serverString({ key }, option.label) } : option;
      }),
    };
  }
  return result as T;
}

const APPROVAL_OPTIONS: Record<string, string> = { A: "approval.allow", B: "approval.deny" };

function isQuestionWithOptions(
  value: unknown,
): value is { options: Array<{ key: string; label: string }> } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { options?: unknown }).options)
  );
}

/**
 * 气泡里显示的正文：带选项卡片的提问只留问题本身（选项和作答提示由卡片显示），其余照旧。
 * 只改显示；复制、导出、引用仍用 message.content 的完整原文。
 */
export function messageBodyContent(message: ChatMessage): string {
  if (!message.question?.options.length) return message.content;
  return serverString(questionBodyText(message.text), message.content);
}

/** 失败响应的说明：优先用结构化文案 */
export function serverError(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { error, text } = body as { error?: unknown; text?: unknown };
  return typeof error === "string" ? serverString(text, error) : undefined;
}
