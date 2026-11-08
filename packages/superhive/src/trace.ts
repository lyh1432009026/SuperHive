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

/** 每轮最多这么多段思考带正文；更早的只留时长，免得一轮几十段思考把执行过程撑满 */
export const THINKING_TEXT_STEPS_MAX = 20;
/** 同一段思考最快每秒更新一次正文 */
export const THINKING_THROTTLE_MS = 1_000;

/** 思考正文：先脱敏，超长时保留末尾（最新想到的），前面标「…」 */
export function thinkingText(value: string): string {
  const text = redactTrace(value.trim());
  return text.length > TRACE_TEXT_MAX ? `…${text.slice(-(TRACE_TEXT_MAX - 1))}` : text;
}

/**
 * 一轮里的思考步骤：各 Runtime 把思考片段交给它，累积成正文挂在 thinking 步骤上（同一个 id 原地更新）。
 * 正文更新按段节流；超过 THINKING_TEXT_STEPS_MAX 段时把最早一段的正文清空（text: ""）。
 */
export class ThinkingTrace {
  private readonly steps = new Map<
    string,
    {
      step: TraceStep;
      text: string;
      emittedAt: number;
      timer?: ReturnType<typeof setTimeout> | undefined;
      /** 超出段数上限被清掉了正文，之后也不再带正文 */
      dropped?: boolean;
    }
  >();
  /** 带过正文的段，按先后 */
  private readonly withText: string[] = [];

  constructor(
    private readonly emit: (step: TraceStep) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** 开始一段思考（已开始的不重复上报） */
  start(id: string): void {
    if (this.steps.has(id)) return;
    const step: TraceStep = {
      id,
      kind: "thinking",
      status: "running",
      startedAt: new Date(this.now()).toISOString(),
    };
    this.steps.set(id, { step, text: "", emittedAt: this.now() });
    this.emit(step);
  }

  /** 追加思考片段；距上次上报不到 1 秒的攒着，到点再报 */
  append(id: string, delta: string): void {
    if (!delta) return;
    this.start(id);
    const entry = this.steps.get(id)!;
    if (entry.step.status !== "running") return;
    entry.text += delta;
    // 只保留够用的末尾，避免很长的思考一直占内存
    if (entry.text.length > TRACE_TEXT_MAX * 4) entry.text = entry.text.slice(-TRACE_TEXT_MAX * 2);
    const wait = THINKING_THROTTLE_MS - (this.now() - entry.emittedAt);
    if (wait <= 0) {
      this.flush(id);
    } else if (!entry.timer) {
      entry.timer = setTimeout(() => this.flush(id), wait);
      entry.timer.unref?.();
    }
  }

  /** 结束一段思考；final 是 Runtime 最后给出的完整正文（有就以它为准） */
  end(id: string, final?: string): void {
    const entry = this.steps.get(id);
    if (!entry || entry.step.status !== "running") return;
    if (final?.trim()) entry.text = final;
    entry.step = { ...entry.step, status: "ok", endedAt: new Date(this.now()).toISOString() };
    this.flush(id);
  }

  /** 结束所有还在进行的思考（回合结束、被打断时） */
  endAll(): void {
    for (const id of this.steps.keys()) this.end(id);
  }

  private flush(id: string): void {
    const entry = this.steps.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.emittedAt = this.now();
    const text = !entry.dropped && entry.text.trim() ? thinkingText(entry.text) : "";
    if (text && !this.withText.includes(id)) {
      this.withText.push(id);
      while (this.withText.length > THINKING_TEXT_STEPS_MAX) {
        const dropped = this.steps.get(this.withText.shift()!);
        if (!dropped) continue;
        dropped.text = "";
        dropped.dropped = true;
        this.emit({ ...dropped.step, text: "" });
      }
    }
    this.emit(text ? { ...entry.step, text } : entry.step);
  }
}

/** 常见的只读命令（第一个词）；能执行别的命令或写文件的（find、sed、awk、env、sort、date……）不放进来 */
const readOnlyCommands = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "ls",
  "pwd",
  "echo",
  "wc",
  "grep",
  "rg",
  "ag",
  "stat",
  "file",
  "which",
  "whoami",
  "printenv",
  "du",
  "df",
  "ps",
  "cut",
  "diff",
  "jq",
  "nl",
  "true",
]);
/** 带什么参数都只读的 git 子命令；branch、remote 只认列出用法（见 readOnlyGitCommand） */
const readOnlyGit = new Set([
  "status",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "blame",
  "describe",
  "shortlog",
  "grep",
]);

function readOnlyGitCommand(args: string[]): boolean {
  const [sub, ...rest] = args;
  if (!sub) return true;
  // 写文件或调用外部程序的参数：任何子命令带上都算改动
  if (
    rest.some((arg) =>
      /^(?:--output|-O|--open-files-in-pager|--ext-diff|--exec|-c\b|--config)/.test(arg),
    )
  ) {
    return false;
  }
  if (sub === "diff") return true;
  if (sub === "branch") {
    return rest.every((arg) =>
      /^(?:-a|-r|-v|-vv|--all|--remotes|--list|--show-current|--verbose|--no-color|--contains|--merged|--no-merged)$/.test(
        arg,
      ),
    );
  }
  if (sub === "remote") return rest.every((arg) => arg === "-v" || arg === "--verbose");
  return readOnlyGit.has(sub);
}

/** Codex 常把命令包一层 `/bin/zsh -lc '…'`：剥掉这层再判断 */
function unwrapShell(command: string): string {
  const match = command
    .trim()
    .match(/^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+(?:'([\s\S]*)'|"([\s\S]*)")\s*$/);
  return match ? (match[1] ?? match[2] ?? command) : command;
}

/** 只读命令：每一段都在白名单里，且没有命令替换、写文件的重定向、后台执行 */
export function readOnlyCommand(raw: string): boolean {
  const command = unwrapShell(raw);
  // 命令替换、进程替换可以执行任意命令
  if (/\$\(|`|<\(|>\(/.test(command)) return false;
  // 重定向只放过丢弃错误输出和合并输出
  const withoutSafe = command.replace(/\b2>\s*\/dev\/null|\b2>&1|&>\s*\/dev\/null/g, "");
  if (/>|\btee\b/.test(withoutSafe)) return false;
  return (
    withoutSafe
      // 单独的 & 也是命令分隔（后台执行），各段都要判断
      .split(/\n|&&|\|\||;|\||&/)
      .map((part) => part.trim())
      .filter(Boolean)
      .every((part) => {
        const words = part.split(/\s+/);
        // 环境变量前缀会改变命令行为（GIT_EXTERNAL_DIFF、PAGER……）：只放过语言、颜色这类无害的
        while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
          if (!/^(?:LANG|LANGUAGE|LC_[A-Z]+|NO_COLOR|TERM|COLUMNS)=/.test(words[0])) return false;
          words.shift();
        }
        const [head, ...args] = words;
        if (!head || head === "cd") return true;
        if (head === "git") return readOnlyGitCommand(args);
        // rg --pre 会对每个文件执行指定的程序
        if (head === "rg" && args.some((arg) => arg.startsWith("--pre"))) return false;
        return readOnlyCommands.has(head);
      })
  );
}

/** 不改东西的 Hive 工具（按工具名判断，不看参数正文） */
const readOnlyHiveTools = new Set([
  "hive_room_read",
  "hive_members_list",
  "hive_board_read",
  "hive_attachment_read",
  "hive_schedule_list",
  "hive_wait",
]);

/**
 * 这一步可能有副作用吗（改文件、跑不明命令、发消息、调用外部工具……）？
 * 上游出错中断后，只有一步都没有副作用的回合才自动接着继续；判断宁严勿松，认不出的一律算有副作用。
 */
export function isMutatingStep(step: TraceStep): boolean {
  if (step.kind !== "tool") return false;
  switch (step.tool) {
    case "read":
    case "search":
      return false;
    case "command":
      return !readOnlyCommand(step.summary ?? "");
    case "collaboration": {
      const tool = (step.name ?? "").replace(/^mcp__hive__/, "").replace(/^hive\./, "");
      return !readOnlyHiveTools.has(tool);
    }
    default:
      return true;
  }
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
