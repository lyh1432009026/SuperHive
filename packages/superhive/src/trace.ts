import { homedir } from "node:os";
import type { TraceStep } from "./hive-protocol.js";

/** 与 @superhive/protocol 的 LIMITS.maxTraceSummaryLength / maxTraceTextLength 保持一致 */
export const TRACE_SUMMARY_MAX = 300;
export const TRACE_TEXT_MAX = 2000;

const secretPatterns: Array<[RegExp, string]> = [
  // 常见的令牌前缀：OpenAI/Anthropic、GitHub、Slack、AWS、npm、Google
  [/\b(sk-(?:ant-)?[A-Za-z0-9_-]{8})[A-Za-z0-9_-]{8,}/g, "$1…"],
  [/\b(gh[pousr]_)[A-Za-z0-9]{16,}/g, "$1…"],
  [/\b(github_pat_)[A-Za-z0-9_]{16,}/g, "$1…"],
  [/\b(xox[abprs]-)[A-Za-z0-9-]{10,}/g, "$1…"],
  [/\b(AKIA)[A-Z0-9]{12,}/g, "$1…"],
  [/\b(npm_)[A-Za-z0-9]{16,}/g, "$1…"],
  [/\b(AIza)[A-Za-z0-9_-]{20,}/g, "$1…"],
  // Authorization: Bearer xxx / Basic xxx
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***"],
  // KEY=value / KEY: value，键名里带 token/secret/password/key 之类
  [
    /\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_.-]*)(\s*[=:]\s*|\s+)(["']?)[^\s"'&]{4,}\3/gi,
    "$1$2$3***$3",
  ],
  // URL 里的 user:password@
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi, "$1***@"],
  // --token xxx / --password=xxx 这类参数
  [
    /(--?(?:token|password|passwd|secret|api-key|apikey|auth)(?:=|\s+))(["']?)[^\s"']+\2/gi,
    "$1$2***$2",
  ],
];

/** 执行过程会推到网页上：遮掉常见的密钥写法，家目录换成 ~ */
export function redactTrace(text: string, home = homedir()): string {
  let result = text;
  for (const [pattern, replacement] of secretPatterns)
    result = result.replace(pattern, replacement);
  if (home && home.length > 1) result = result.split(home).join("~");
  return result;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 一行摘要：多行命令只留第一行，并标出还有几行 */
export function traceSummary(value: string): string {
  const lines = value.trim().split(/\r?\n/);
  const first = lines[0]!.replace(/\s+/g, " ").trim();
  const more = lines.length > 1 ? ` …（共 ${lines.length} 行）` : "";
  return clip(redactTrace(first) + more, TRACE_SUMMARY_MAX);
}

export function traceText(value: string): string {
  return clip(redactTrace(value.trim()), TRACE_TEXT_MAX);
}

/** 上报前统一脱敏、截断；各 Runtime 的解析只管拿到原始字段 */
export function sanitizeTraceStep(step: TraceStep): TraceStep {
  return {
    ...step,
    id: step.id.slice(0, 120),
    ...(step.name ? { name: step.name.slice(0, 64) } : {}),
    ...(step.summary !== undefined ? { summary: traceSummary(step.summary) } : {}),
    ...(step.text !== undefined ? { text: traceText(step.text) } : {}),
  };
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

/** Claude Code 工具调用的一行摘要：命令、文件路径、搜索词…… */
export function claudeToolSummary(name: string, input: Record<string, unknown>): string {
  const pick =
    str(input.command) ??
    str(input.file_path) ??
    str(input.notebook_path) ??
    str(input.pattern) ??
    str(input.query) ??
    str(input.url) ??
    str(input.path) ??
    str(input.description) ??
    str(input.prompt);
  if (name === "Grep" && str(input.pattern)) {
    return `${input.pattern}${str(input.path) ? `  in ${input.path}` : ""}`;
  }
  if (name.startsWith("mcp__")) {
    const [, server, tool] = name.split("__");
    // Hive 自己的工具不必再带服务名
    const label = server === "hive" ? tool! : `${server}.${tool}`;
    return pick ? `${label}  ${pick}` : label;
  }
  return pick ?? "";
}
