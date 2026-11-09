import { zhText, type ServerText } from "@superhive/protocol";
import { HiveError } from "./database.js";

/** HTTP 错误体：error 是中文（旧客户端直接显示），text 给网页按语言渲染 */
export function errorText(text: ServerText): { error: string; text: ServerText } {
  return { error: zhText(text), text };
}

/** 把 HiveError 转成错误体，带上 code 和结构化文案（没有就只有中文） */
export function hiveErrorBody(error: HiveError): {
  error: string;
  code: string;
  text?: ServerText;
} {
  return { error: error.message, code: error.code, ...(error.text ? { text: error.text } : {}) };
}

/** WebSocket error 事件的正文：message 是中文，text 给网页按语言渲染；只有字符串时就只有 message */
export function wsText(text: ServerText | string): { message: string; text?: ServerText } {
  return typeof text === "string" ? { message: text } : { message: zhText(text), text };
}
