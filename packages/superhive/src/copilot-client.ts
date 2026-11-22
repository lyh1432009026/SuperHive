import { randomUUID } from "node:crypto";
import { defaultCommandRunner, type CommandRunner } from "./command-runner.js";
import { copilotHiveMcpConfig, type HiveMcpConnection } from "./hive-mcp-config.js";
import { classifyText, isUpstreamKind } from "./failure.js";
import {
  AgentCancelledError,
  AgentUpstreamError,
  type AgentAccessMode,
  type AgentReply,
  type AgentReplyInput,
  type AgentResponder,
} from "./responder.js";

type CopilotEvent = {
  type?: string;
  data?: {
    sessionId?: string;
    content?: string;
  };
};

function parseJsonLines(output: string): CopilotEvent[] {
  const events: CopilotEvent[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as CopilotEvent);
    } catch {
      // JSON mode can still include a diagnostic line; ignore it.
    }
  }
  return events;
}

/** 新会话或需要刷新规则时才把规则拼进消息，避免每轮重复堆积在会话历史里 */
function withInstructions(input: AgentReplyInput): string {
  return !input.threadId || input.refreshInstructions
    ? `${input.instructions}\n\n---\n\n${input.prompt}`
    : input.prompt;
}

export class CopilotResponder implements AgentResponder {
  constructor(
    private readonly options: {
      command: string;
      cwd: string;
      hive: HiveMcpConnection;
      access?: AgentAccessMode;
      model?: string;
      runner?: CommandRunner;
    },
  ) {}

  async reply(input: AgentReplyInput): Promise<AgentReply> {
    const sessionId = input.threadId ?? randomUUID();
    const access = this.options.access ?? "read-only";
    // 提示走标准输入（不带 -p 时 Copilot 读管道输入）：放在参数里会受命令行长度限制，
    // Windows 上 32767 字符，十几条长消息就超了，也会出现在进程列表里
    const args = [
      "--output-format",
      "json",
      "--stream",
      "off",
      "--mode",
      access === "read-only" ? "plan" : "interactive",
      "--additional-mcp-config",
      copilotHiveMcpConfig(this.options.hive),
      "--allow-tool=hive",
      "--no-custom-instructions",
      "--no-ask-user",
      // --resume 只能恢复已存在的 session；首次会话需用 --session-id 创建新 session。
      input.threadId ? `--resume=${sessionId}` : `--session-id=${sessionId}`,
    ];
    if (access === "read-only") {
      args.push(
        "--disable-builtin-mcps",
        "--deny-tool=write",
        "--deny-tool=shell",
        "--no-remote",
        "--disallow-temp-dir",
      );
    } else if (access === "workspace") {
      args.push(
        "--disable-builtin-mcps",
        "--allow-tool=write",
        "--allow-tool=shell",
        "--no-remote",
        "--disallow-temp-dir",
      );
    } else {
      args.push("--allow-all");
    }
    // 每轮都是新进程：设置里改的模型、「换个模型重试」都按轮生效
    const model = input.model ?? this.options.model;
    if (model) args.push("--model", model);

    let result;
    try {
      result = await (this.options.runner ?? defaultCommandRunner)(this.options.command, args, {
        cwd: this.options.cwd,
        input: withInstructions(input),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      if (error instanceof AgentCancelledError) throw error;
      const message = `GitHub Copilot 执行失败：${error instanceof Error ? error.message : String(error)}`;
      // 没有结构化的失败信息，只能看 CLI 的原话：认得出的上游出错（断网、限流、额度、认证……）交给 Bridge 按分类处理。
      // 会话只在续接已有会话时带上：新会话可能还没建起来，下次续接会找不到
      const kind = classifyText(message);
      if (isUpstreamKind(kind)) {
        throw new AgentUpstreamError(message.slice(0, 240), input.threadId, kind);
      }
      throw new Error(message, { cause: error });
    }
    const events = parseJsonLines(result.stdout);
    const text = events
      .filter((event) => event.type === "assistant.message" && event.data?.content?.trim())
      .at(-1)?.data?.content;
    const reportedSessionId = events.find((event) => event.type === "session.start")?.data
      ?.sessionId;
    if (!text?.trim()) {
      throw new Error(
        `GitHub Copilot 没有返回可发送的文本：${result.stderr.trim() || result.stdout.trim().slice(-300)}`,
      );
    }
    return { text, threadId: reportedSessionId ?? sessionId };
  }
}
