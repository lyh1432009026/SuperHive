import { randomUUID } from "node:crypto";
import { defaultCommandRunner, type CommandRunner } from "./command-runner.js";
import { classifyText, isUpstreamKind } from "./failure.js";
import {
  AgentCancelledError,
  AgentUpstreamError,
  type AgentReply,
  type AgentReplyInput,
  type AgentResponder,
} from "./responder.js";

type OpenClawPayload = { text?: string };
type OpenClawResult = {
  payloads?: OpenClawPayload[];
  result?: { payloads?: OpenClawPayload[] };
  meta?: { agentMeta?: { sessionId?: string } };
};

/** 新会话或需要刷新规则时才把规则拼进消息，避免每轮重复堆积在会话历史里 */
function withInstructions(input: AgentReplyInput): string {
  return !input.threadId || input.refreshInstructions
    ? `${input.instructions}\n\n---\n\n${input.prompt}`
    : input.prompt;
}

export class OpenClawResponder implements AgentResponder {
  constructor(
    private readonly options: {
      command: string;
      cwd: string;
      local: boolean;
      agentId?: string;
      model?: string;
      runner?: CommandRunner;
    },
  ) {}

  async reply(input: AgentReplyInput): Promise<AgentReply> {
    const sessionId = input.threadId ?? randomUUID();
    const args = [
      "agent",
      "--session-id",
      sessionId,
      "--message",
      withInstructions(input),
      "--json",
    ];
    if (this.options.local) args.push("--local");
    if (this.options.agentId) args.push("--agent", this.options.agentId);
    // 每轮都是新进程：设置里改的模型、「换个模型重试」都按轮生效
    const model = input.model ?? this.options.model;
    if (model) args.push("--model", model);

    let result;
    try {
      result = await (this.options.runner ?? defaultCommandRunner)(this.options.command, args, {
        cwd: this.options.cwd,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      if (error instanceof AgentCancelledError) throw error;
      const message = `OpenClaw 执行失败：${error instanceof Error ? error.message : String(error)}`;
      // 没有结构化的失败信息，只能看 CLI 的原话：认得出的上游出错（断网、限流、额度、认证……）交给 Bridge 按分类处理。
      // 会话只在续接已有会话时带上：新会话可能还没建起来，下次续接会找不到
      const kind = classifyText(message);
      if (isUpstreamKind(kind)) {
        throw new AgentUpstreamError(message.slice(0, 240), input.threadId, kind);
      }
      throw new Error(message, { cause: error });
    }
    let payload: OpenClawResult;
    try {
      payload = JSON.parse(result.stdout.trim()) as OpenClawResult;
    } catch (error) {
      throw new Error(
        `OpenClaw 返回了无法解析的 JSON：${result.stdout.trim().slice(0, 300) || result.stderr.trim()}`,
        { cause: error },
      );
    }
    const payloads = payload.result?.payloads ?? payload.payloads ?? [];
    const text = payloads
      .map((item) => item.text?.trim())
      .filter((item): item is string => Boolean(item))
      .join("\n\n");
    if (!text) throw new Error("OpenClaw 没有返回可发送的文本。");
    return {
      text,
      threadId: payload.meta?.agentMeta?.sessionId ?? sessionId,
    };
  }
}
