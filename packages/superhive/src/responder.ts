import type { AgentUsage, RuntimeEvent, TraceStep } from "./hive-protocol.js";

export type AgentProvider =
  "codex" | "claude" | "copilot" | "openclaw" | "opencode" | "omp" | "echo";
export type AgentAccessMode = "read-only" | "workspace" | "full";

/** 执行中的权限申请：给人看的一行摘要和补充说明 */
export type ApprovalRequest = {
  /** 申请的工具或动作，例如 Bash、commandExecution、fileChange */
  tool: string;
  summary: string;
  detail?: string;
};

export type AgentReplyInput = {
  instructions: string;
  prompt: string;
  threadId?: string;
  /** 人在 Web UI 点击"停止"时触发；Responder 应尽快中断并以 AgentCancelledError 结束 */
  signal?: AbortSignal;
  /** 运行中的可读进度（正在执行的命令、调用的工具等），由 Bridge 节流后上报 */
  onProgress?: (progress: string) => void;
  /** Sanitized structured events; heartbeat is emitted separately by Bridge. */
  onRuntimeEvent?: (event: RuntimeEvent) => void;
  /**
   * 执行过程的一步（中途说的话、思考、工具调用），给房主实时看；同一个 id 再报即更新。
   * 可以带原始内容，Bridge 统一脱敏、截断、合批后上报。
   */
  onTrace?: (step: TraceStep) => void;
  /** 一拿到这一轮用的 Provider 会话 ID 就告诉 Bridge（不用等回合结束），人可以在终端里接着它 */
  onSession?: (sessionId: string) => void;
  /**
   * 本轮结束时（成功、失败、停止都会）交出已观测到的用量，Bridge 据此在失败路径上也能记账。
   * 不支持用量的 Provider 不调用。
   */
  onUsage?: (usage: AgentUsage) => void;
  /**
   * Runtime 执行中要申请权限（跑命令、改工作区外的文件、MCP 确认）时调用：交给人批，
   * resolve(true) 才放行。人拒绝、超时、这一轮被停止都 resolve(false)。没有它就一律按拒绝处理。
   */
  requestApproval?: (request: ApprovalRequest) => Promise<boolean>;
  /**
   * 是否需要重新注入完整规则。只能把规则拼进用户消息的 Provider（Copilot、OpenClaw、ACP）
   * 据此避免每轮都把同一份长规则写进会话历史；新会话总是需要。
   */
  refreshInstructions?: boolean;
};

export type AgentReply = {
  text: string;
  threadId?: string;
  /** 本轮 Runtime 返回的真实用量；不支持的 Provider 不填 */
  usage?: AgentUsage;
  /** Runtime 自报的会话累计费用（Claude Code 的 total_cost_usd）；Bridge 求差得到本轮费用 */
  sessionCostUsd?: number;
};

export interface AgentResponder {
  reply(input: AgentReplyInput): Promise<AgentReply>;
  /**
   * 把新到达的消息注入正在运行的回合（Codex turn/steer）。
   * 返回 false 表示当前没有可注入的回合，调用方应改为排队。
   */
  steer?(prompt: string): Promise<boolean>;
  close?(): Promise<void>;
}

export class AgentCancelledError extends Error {
  constructor(message = "已按请求停止。") {
    super(message);
    this.name = "AgentCancelledError";
  }
}

/** Known failure that must be surfaced once, not automatically re-executed. */
export class AgentNonRetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentNonRetryableError";
  }
}

/** 失败说明的开头：网页据此把「重试」按钮显示为「继续」（与 @superhive/protocol 保持一致） */
export const UPSTREAM_FAILURE_PREFIX = "上游模型服务出错";

/**
 * 上游模型服务出错（限流、过载、5xx、连接中断）导致这一轮中途结束：Runtime 进程已正常退出、原因明确，
 * 不会有残留的执行。threadId 是这一轮所在的会话，接着它继续就能看到已经做过的步骤。
 */
export class AgentUpstreamError extends Error {
  constructor(
    readonly reason: string,
    readonly threadId?: string,
  ) {
    super(`${UPSTREAM_FAILURE_PREFIX}：${reason}`);
    this.name = "AgentUpstreamError";
  }
}

/**
 * 看起来是上游模型服务暂时不可用（限流、过载、5xx、连接中断），等一会儿再试可能就好；
 * 额度用完、鉴权失败这类等多久都不会好的不算。只认明确的写法，不按任意数字或「超时」字样匹配。
 */
export function isUpstreamFailure(text: string): boolean {
  if (
    /insufficient_quota|quota exceeded|billing|credit balance|invalid api key|unauthori[sz]ed|\b401\b|\b403\b/i.test(
      text,
    )
  ) {
    return false;
  }
  return /API Error:?\s*(?:429|5\d\d)\b|(?:status|statusCode|status_code|HTTP)[\s:=]*(?:429|5\d\d)\b|rate[ _-]?limit|too many requests|overloaded|service unavailable|bad gateway|gateway time-?out|ECONNRESET|ETIMEDOUT|socket hang up|stream (?:error|disconnected)|限流|重试渠道均失败|服务繁忙/i.test(
    text,
  );
}

/**
 * 会话本身坏了，续不下去：Codex 解不开旧会话里加密的推理内容（换过网关、key、组织后常见）、
 * 找不到之前的 response / thread、恢复会话的文件损坏。换个新会话就好，跟任务本身无关。
 * executed：这一轮在出错前是否已经开始执行工具（执行过就不能自动重跑，交给人决定）。
 */
export class AgentSessionInvalidError extends Error {
  constructor(
    readonly reason: string,
    readonly executed = false,
  ) {
    super(`会话已失效：${reason}`);
    this.name = "AgentSessionInvalidError";
  }
}

/** 运行时报的错误是不是「会话坏了」：只认明确的写法 */
export function isSessionInvalid(text: string): boolean {
  return /invalid_encrypted_content|encrypted content[^.]*could not be (?:verified|decrypted)|previous_response_not_found|previous response[^.]*not found|no (?:conversation|rollout) found|(?:thread|session|conversation|rollout)[^.]{0,40}(?:not found|does not exist|could not be (?:found|loaded|parsed))|failed to (?:load|parse|read) (?:rollout|session|thread)|corrupt(?:ed)? (?:rollout|session)/i.test(
    text,
  );
}

export class AgentExecutionUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentExecutionUncertainError";
  }
}

export function isCancelled(error: unknown, signal?: AbortSignal): boolean {
  return error instanceof AgentCancelledError || Boolean(signal?.aborted);
}

export class EchoResponder implements AgentResponder {
  constructor(private readonly agentName: string) {}

  async reply(input: AgentReplyInput): Promise<AgentReply> {
    const block = input.prompt.match(/<trigger_message>\s*([\s\S]*?)\s*<\/trigger_message>/)?.[1];
    const triggers = [...(block ?? "").matchAll(/^#\d+ (?:id=\S+ )?\[[^\]]+\] (.*)$/gm)].map(
      (match) => match[1],
    );
    // 回显时去掉 @，避免测试 Agent 把原消息里的提及再转发一遍、触发其他 Agent
    const echoed = triggers.join(" / ").replace(/@(?=[\p{L}\p{N}_.-])/gu, "");
    return { text: `Echo from ${this.agentName}: ${echoed || "收到"}` };
  }
}
