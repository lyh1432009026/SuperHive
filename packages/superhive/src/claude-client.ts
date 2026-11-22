import type { CommandRunner } from "./command-runner.js";
import { streamCommandRunner } from "./stream-command-runner.js";
import { ClaudeStream, type ClaudeResult } from "./claude-stream.js";
import { classifyClaude, classifyText, isUpstreamKind } from "./failure.js";
import { claudeToolSummary, redactTrace } from "./trace.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeHiveMcpConfig, type HiveMcpConnection } from "./hive-mcp-config.js";
import { enabledClaudeMcpServers, readAgentSettings, type AgentSettings } from "./mcp-servers.js";
import {
  AgentCancelledError,
  AgentExecutionUncertainError,
  AgentSessionInvalidError,
  AgentUpstreamError,
  type AgentAccessMode,
  type AgentReply,
  type AgentReplyInput,
  type AgentResponder,
} from "./responder.js";

/** 一行 stream-json 输入：一条用户消息，带上 uuid，Claude 收进对话时会按这个 uuid 回放 */
function userLine(text: string, uuid: string): string {
  return `${JSON.stringify({
    type: "user",
    uuid,
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}

/** 正在跑的这一轮：标准输入保持打开，引导写进去，Claude 在工具间隙读到 */
type ClaudeTurn = {
  stdin?: { write: (text: string) => void; end: () => void };
  /** 已经关闭输入、不再接收引导 */
  closed: boolean;
  /** 写进去、还没被 Claude 收进对话的引导：uuid → 收下后的回调 */
  unacked: Map<string, (accepted: boolean) => void>;
};

/**
 * Claude Code 写出了 is_error 的结果：按错误类别、状态码和原文分类（见 failure.ts 的 classifyClaude），
 * 是上游出错的交给 Bridge 处理；说不清的返回 undefined，照旧按结果未知报
 */
function upstreamFailure(
  payload: ClaudeResult | undefined,
  threadId: string | undefined,
): AgentUpstreamError | undefined {
  if (!payload?.is_error || !payload.result?.trim()) return undefined;
  const kind = classifyClaude({
    category: payload.error_category,
    status: payload.api_error_status,
    terminalReason: payload.terminal_reason,
    text: payload.result,
  });
  if (!isUpstreamKind(kind)) return undefined;
  return new AgentUpstreamError(
    redactTrace(payload.result.replace(/\s+/g, " ").trim()).slice(0, 240),
    payload.session_id ?? threadId,
    kind,
  );
}

export class ClaudeCodeResponder implements AgentResponder {
  private turn: ClaudeTurn | undefined;

  /**
   * 引导：写进正在跑的这一轮的标准输入，Claude 回放（确认收进对话）后才算插进去。
   * 这一轮已经结束、或者写进去后进程意外退出，都返回 false，由 Bridge 退回排队。
   * 收下的引导 Claude 一定会处理：在工具间隙读到就并入这一轮，晚了就在同一进程里接着再跑一轮。
   */
  async steer(prompt: string): Promise<boolean> {
    const turn = this.turn;
    if (!turn || turn.closed || !turn.stdin) return false;
    const uuid = randomUUID();
    const accepted = new Promise<boolean>((resolve) => turn.unacked.set(uuid, resolve));
    turn.stdin.write(userLine(prompt, uuid));
    return accepted;
  }
  constructor(
    private readonly options: {
      command: string;
      cwd: string;
      hive: HiveMcpConnection;
      access?: AgentAccessMode;
      model?: string;
      runner?: CommandRunner;
      /**
       * 本机 Hive Server 写入的 Agent 设置文件。给定时只加载勾选的 MCP（--strict-mcp-config），
       * 每一轮重新读取，改动下一轮生效；不给时沿用 Claude Code 自己的全部 MCP 配置。
       */
      settingsFile?: string;
      /** 停止时请 Claude 自己中断，等多久没确认停下就改为结束进程（默认 5 秒） */
      interruptTimeoutMs?: number;
      /** 测试注入：按 cwd 和设置列出要加载的 MCP（不含 hive） */
      mcpServers?: (
        cwd: string,
        settings: AgentSettings,
      ) => Record<string, Record<string, unknown>>;
    },
  ) {}

  /**
   * 写出本轮的 MCP 配置文件。用文件而不是命令行参数：本机 MCP 配置里常有密钥，
   * 命令行参数会被同机其他用户通过 ps 看到。
   */
  private writeMcpConfig(): { file: string; cleanup: () => void } {
    const settings = readAgentSettings(this.options.settingsFile);
    const servers = (this.options.mcpServers ?? enabledClaudeMcpServers)(
      this.options.cwd,
      settings,
    );
    const hive = (
      JSON.parse(claudeHiveMcpConfig(this.options.hive)) as {
        mcpServers: Record<string, unknown>;
      }
    ).mcpServers;
    const dir = mkdtempSync(path.join(tmpdir(), "hive-claude-mcp-"));
    const file = path.join(dir, "mcp.json");
    // 名称有序且内容不变时文件逐字节相同，工具定义的前缀缓存不会因此失效
    writeFileSync(file, JSON.stringify({ mcpServers: { ...servers, ...hive } }), { mode: 0o600 });
    return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  async reply(input: AgentReplyInput): Promise<AgentReply> {
    const access = this.options.access ?? "read-only";
    const hiveTools = [
      "hive_room_read",
      "hive_members_list",
      "hive_message_send",
      "hive_invoke",
      "hive_wait",
      "hive_ask_human",
      "hive_board_read",
      "hive_board_update",
      "hive_attachment_read",
      "hive_schedule_create",
      "hive_schedule_list",
      "hive_schedule_cancel",
      "hive_room_create",
      "hive_room_post",
      "hive_incident_report",
      "hive_rule_propose",
    ]
      .map((tool) => `mcp__hive__${tool}`)
      .join(",");
    const mcp = this.options.settingsFile !== undefined ? this.writeMcpConfig() : undefined;
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      // 流式输入：这一轮跑着时还能写进新消息（引导）；回放写进去的消息，用来确认 Claude 已经收下
      "--input-format",
      "stream-json",
      "--replay-user-messages",
      "--permission-mode",
      access === "read-only" ? "plan" : access === "workspace" ? "auto" : "bypassPermissions",
      "--append-system-prompt",
      input.instructions,
      "--mcp-config",
      mcp ? mcp.file : claudeHiveMcpConfig(this.options.hive),
      ...(mcp ? ["--strict-mcp-config"] : []),
      "--allowedTools",
      access === "workspace" ? `Read,Glob,Grep,Edit,Write,Bash,${hiveTools}` : hiveTools,
      // 工作区档：Claude 想做 auto 模式下要人确认的事时，通过标准输入问我们（can_use_tool），交给人批；
      // 其余档不弹：只读档照旧直接拒绝，完全权限档本来就不问
      ...(access === "workspace" ? ["--permission-prompt-tool", "stdio"] : []),
      // Claude 自带的定时只活在这一轮的进程里，回复完进程一退就没了，服务端也看不到：一律改用 hive_schedule_create
      "--disallowedTools",
      "CronCreate,CronDelete,CronList,ScheduleWakeup",
    ];
    if (access === "workspace") {
      args.push(
        "--settings",
        JSON.stringify({
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
          },
        }),
      );
    }
    if (access === "full") {
      args.push(
        "--dangerously-skip-permissions",
        "--settings",
        JSON.stringify({ sandbox: { enabled: false } }),
      );
    }
    // 每轮都是新进程：Agent 设置里改的模型、「换个模型重试」下一轮就生效
    const model = input.model ?? this.options.model;
    if (model) args.push("--model", model);
    if (input.threadId) args.push("--resume", input.threadId);

    const stream = new ClaudeStream(
      (event) => input.onRuntimeEvent?.(event),
      (step) => input.onTrace?.(step),
      (sessionId) => input.onSession?.(sessionId),
    );
    input.onRuntimeEvent?.({ kind: "capabilities", observability: "partial", usage: true });
    // 失败、中断时也交出已经发生的用量：钱已经花了
    const reportUsage = () => {
      stream.finish();
      input.onUsage?.(stream.usage());
    };
    input.onRuntimeEvent?.({ kind: "activity", phase: "starting" });
    const turn: ClaudeTurn = { closed: false, unacked: new Map() };
    this.turn = turn;
    // 出了结果、又没有还没收下的引导：关闭输入，进程跑完这一轮就退出；
    // 还有引导没收下就继续开着，Claude 会读到它们并接着再跑一轮
    const closeIfIdle = () => {
      if (turn.closed || turn.unacked.size > 0) return;
      turn.closed = true;
      turn.stdin?.end();
    };
    stream.onUserAck = (uuid) => {
      const resolve = turn.unacked.get(uuid);
      if (!resolve) return;
      turn.unacked.delete(uuid);
      resolve(true);
    };
    const settleTurn = () => {
      turn.closed = true;
      for (const resolve of turn.unacked.values()) resolve(false);
      turn.unacked.clear();
      if (this.turn === turn) this.turn = undefined;
    };
    /**
     * 停止：先用 stream-json 的 control_request interrupt 请 Claude 停在当前这一步——它会终止正在跑的工具、
     * 答复 control_response 并以 error_during_execution 结束这一轮，这样能确认确实停下（会话也还在，可以重试）。
     * 中断请求发不出去、或超时没有确认，才结束进程，那时只能按结果未知处理。
     */
    const kill = new AbortController();
    const interrupt = { requestId: "", acked: false, settled: false };
    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (!turn.stdin || turn.closed) {
        kill.abort();
        return;
      }
      interrupt.requestId = `interrupt-${randomUUID()}`;
      // 停下以后不再接引导；还没收下的引导退回排队
      for (const resolve of turn.unacked.values()) resolve(false);
      turn.unacked.clear();
      turn.stdin.write(
        `${JSON.stringify({ type: "control_request", request_id: interrupt.requestId, request: { subtype: "interrupt" } })}\n`,
      );
      killTimer = setTimeout(() => kill.abort(), this.options.interruptTimeoutMs ?? 5_000);
      killTimer.unref?.();
    };
    stream.onPermissionRequest = (requestId, request) => {
      const answer = (allow: boolean, message?: string) => {
        if (turn.closed || !turn.stdin) return;
        turn.stdin.write(
          `${JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: requestId,
              response: allow
                ? { behavior: "allow", updatedInput: request.input }
                : { behavior: "deny", message: message ?? "没有获得批准。" },
            },
          })}\n`,
        );
      };
      if (access !== "workspace" || !input.requestApproval) {
        answer(false, "当前权限档不允许这个操作。");
        return;
      }
      void input
        .requestApproval({
          tool: request.toolName,
          summary: claudeToolSummary(request.toolName, request.input) || request.toolName,
          ...(request.description ? { detail: request.description } : {}),
        })
        .then(
          (allow) => answer(allow, allow ? undefined : "人没有批准这个操作（拒绝或超时）。"),
          () => answer(false),
        );
    };
    stream.onControlResponse = (requestId, ok) => {
      if (requestId === interrupt.requestId && ok) interrupt.acked = true;
    };
    stream.onResult = () => {
      // 中断确认后出的这个结果就是这一轮的收尾：确认停下，关输入让进程退出
      if (interrupt.acked) {
        interrupt.settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (!turn.closed) {
          turn.closed = true;
          turn.stdin?.end();
        }
        return;
      }
      closeIfIdle();
    };
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    const stoppedCleanly = () =>
      Boolean(input.signal?.aborted && interrupt.settled && !kill.signal.aborted);
    let result;
    try {
      result = await (this.options.runner ?? streamCommandRunner)(this.options.command, args, {
        cwd: this.options.cwd,
        input: userLine(input.prompt, randomUUID()),
        onStdout: (chunk) => stream.push(chunk),
        onStdin: (stdin) => {
          turn.stdin = stdin;
        },
        signal: kill.signal,
      });
    } catch (error) {
      settleTurn();
      reportUsage();
      if (killTimer) clearTimeout(killTimer);
      input.signal?.removeEventListener("abort", onAbort);
      // 中断后 Claude 以非零码退出是正常的：已经确认停下
      if (stoppedCleanly()) throw new AgentCancelledError();
      if (error instanceof AgentCancelledError) {
        throw new AgentExecutionUncertainError(
          "已请求终止 Claude 主进程，但工具子进程是否停止尚未确认。",
        );
      }
      // 上游出错（重试用完的 429、额度用完、key 无效……）时，Claude Code 会先写出一条 is_error 的结果再以非零码退出。
      // 原因明确，不是「中途断了」：按上游出错交给 Bridge，它按失败原因决定自动继续还是等人
      const payload = stream.finish();
      // 恢复会话失败（会话文件被清掉、换了机器）：Claude Code 写出 is_error 的结果和原因后退出，什么都还没做
      const errors = payload?.errors?.join("; ") ?? "";
      if (payload?.is_error && input.threadId && classifyText(errors) === "session_invalid") {
        throw new AgentSessionInvalidError(
          redactTrace(errors.replace(/\s+/g, " ").trim()).slice(0, 240),
          stream.toolStarted,
        );
      }
      const upstream = upstreamFailure(payload, input.threadId);
      if (upstream) throw upstream;
      // An interrupted/invalid stream may follow tool side effects. Never blindly replay it.
      // 带上 Claude Code 最后写出的报错，否则人只看得到「中途退出」不知道为什么
      const said =
        payload?.is_error && payload.result?.trim()
          ? redactTrace(payload.result.replace(/\s+/g, " ").trim()).slice(0, 240)
          : "";
      throw new AgentExecutionUncertainError(
        said ? `Claude Code 中途报错退出：${said}。` : "Claude Code 中途退出，没有给出原因。",
      );
    } finally {
      mcp?.cleanup();
    }
    settleTurn();
    if (killTimer) clearTimeout(killTimer);
    input.signal?.removeEventListener("abort", onAbort);
    if (stoppedCleanly()) {
      reportUsage();
      throw new AgentCancelledError();
    }
    // Injectable legacy runners can return a complete result rather than streaming it.
    if (result.stdout) stream.push(result.stdout);
    const payload = stream.finish();
    reportUsage();
    if (!payload)
      throw new AgentExecutionUncertainError(
        "Claude Code 返回了无法解析的最终结果，执行结果未知。",
      );
    // 上游模型服务出错：进程已正常结束、原因明确，交给 Bridge 按失败原因决定是否接着继续
    const upstream = upstreamFailure(payload, input.threadId);
    if (upstream) throw upstream;
    if (payload.is_error || !payload.result?.trim()) {
      // 带上 Claude Code 给的原因（多半是 API 限流、额度用完），否则只看得到「结果未知」不知道为什么
      const reason =
        payload.is_error && payload.result?.trim()
          ? `：${redactTrace(payload.result.replace(/\s+/g, " ").trim()).slice(0, 240)}`
          : "";
      throw new AgentExecutionUncertainError(
        `Claude Code 没有返回可发送的文本${reason}；执行途中可能已做了部分操作，结果未知。`,
      );
    }
    const usage = stream.usage();
    const sessionCostUsd = stream.sessionCostUsd();
    return {
      text: payload.result,
      ...(payload.session_id ? { threadId: payload.session_id } : {}),
      // 一次请求都没有时不放进回复（onUsage 已交出全零用量）
      ...(usage.requests > 0 ? { usage } : {}),
      ...(sessionCostUsd !== undefined ? { sessionCostUsd } : {}),
    };
  }
}
