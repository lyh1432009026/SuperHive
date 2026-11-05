import { UsageAccumulator, codexBuckets } from "./usage.js";
import { redactTrace } from "./trace.js";
import type { AgentUsage, TraceStep } from "./hive-protocol.js";
import { codexStartupFailure } from "./codex-errors.js";
import { isMissingCodexThread } from "./codex-client.js";
import { createRequire } from "node:module";
import {
  CODEX_HIVE_TOOLS_APPROVAL_OVERRIDE,
  codexHiveMcpOverrides,
  type HiveMcpConnection,
} from "./hive-mcp-config.js";
import { codexMcpDisableOverrides, readAgentSettings } from "./mcp-servers.js";
import {
  AgentCancelledError,
  AgentExecutionUncertainError,
  AgentUpstreamError,
  isUpstreamFailure,
  AgentNonRetryableError,
  type AgentAccessMode,
  type AgentReply,
  type AgentReplyInput,
  type ApprovalRequest,
  type AgentResponder,
} from "./responder.js";
import {
  spawnStdioTransport,
  type StdioExit,
  type StdioTransport,
  type StdioTransportFactory,
} from "./stdio-transport.js";

/**
 * 基于常驻 `codex app-server` 进程（stdio 上的换行分隔 JSON-RPC）的 Codex Responder。
 * 相比每次调用 `codex mcp-server` 的 CodexMcpResponder，它支持：
 * - 向进行中的回合注入新消息（turn/steer）
 * - 中断回合（turn/interrupt）
 * - 流式进度（item/started 通知）
 */

export type AppServerExit = StdioExit;
export type AppServerTransport = StdioTransport;
export type AppServerTransportFactory = StdioTransportFactory;

export type CodexAppServerResponderOptions = {
  command: string;
  cwd: string;
  hive: HiveMcpConnection;
  access?: AgentAccessMode;
  model?: string;
  log?: (message: string) => void;
  /** 本机 Hive Server 写入的 Agent 设置文件：关闭勾选掉的 MCP，改动在下一轮换新的 app-server 进程生效 */
  settingsFile?: string;
};

export type CodexAppServerResponderDependencies = {
  /** 自定义传输（测试用）；默认 spawn 真实的 codex 进程 */
  createTransport?: AppServerTransportFactory;
  /** 握手类请求（initialize / thread / turn start / steer 等）的超时，默认 60s */
  requestTimeoutMs?: number;
  /** 发出 turn/interrupt 后等待 turn/completed 的宽限时间，默认 10s */
  interruptGraceMs?: number;
  /** initialize 中上报的客户端版本 */
  clientVersion?: string;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_INTERRUPT_GRACE_MS = 10_000;

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require("../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * 沙箱与审批策略。codex 0.162 起 approval_policy="untrusted" 已不再被接受（进程直接报错退出）。
 * - 只读：on-request，模型若申请越权，本客户端一律拒绝，仍保持只读；
 * - 工作区：on-request，沙箱外的操作（联网、写工作区外的文件）由 Codex 申请，转给人批；
 * - 完全权限：never，不申请。
 */
function codexAccess(access: AgentAccessMode = "read-only") {
  if (access === "workspace") {
    return { sandbox: "workspace-write", approvalPolicy: "on-request" } as const;
  }
  if (access === "full") {
    return { sandbox: "danger-full-access", approvalPolicy: "never" } as const;
  }
  return { sandbox: "read-only", approvalPolicy: "on-request" } as const;
}

const commandText = (command: unknown): string =>
  Array.isArray(command)
    ? command.map(String).join(" ")
    : typeof command === "string"
      ? command
      : "";

/** 审批请求给人看的摘要；不是审批类请求（或无法问人的 MCP 表单）返回 undefined */
export function codexApprovalRequest(method: string, params: any): ApprovalRequest | undefined {
  const reason =
    typeof params?.reason === "string" && params.reason.trim() ? params.reason : undefined;
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "execCommandApproval": {
      const command = commandText(params?.command);
      return {
        tool: "command",
        summary: command || reason || "运行沙箱外的命令",
        ...(reason && command ? { detail: reason } : {}),
        ...(typeof params?.cwd === "string" && !reason ? { detail: `目录：${params.cwd}` } : {}),
      };
    }
    case "item/fileChange/requestApproval":
    case "applyPatchApproval": {
      const files =
        params?.fileChanges && typeof params.fileChanges === "object"
          ? Object.keys(params.fileChanges)
          : [];
      return {
        tool: "fileChange",
        summary:
          files.length > 0
            ? `修改 ${files.slice(0, 3).join("、")}${files.length > 3 ? ` 等 ${files.length} 个文件` : ""}`
            : reason || "修改沙箱外的文件",
        ...(reason && files.length > 0 ? { detail: reason } : {}),
        ...(typeof params?.grantRoot === "string"
          ? { detail: `申请可写目录：${params.grantRoot}` }
          : {}),
      };
    }
    case "mcpServer/elicitation/request": {
      // 只能答「允许 / 拒绝」：要填字段的表单问不了人，照旧拒绝
      const schema = params?.requestedSchema;
      const fields =
        schema &&
        typeof schema === "object" &&
        schema.properties &&
        typeof schema.properties === "object"
          ? Object.keys(schema.properties)
          : [];
      if (fields.length > 0) return undefined;
      const server = typeof params?.serverName === "string" ? params.serverName : "MCP";
      return {
        tool: `mcp:${server}`.slice(0, 64),
        summary:
          typeof params?.message === "string" && params.message.trim()
            ? params.message
            : `${server} 请求确认`,
      };
    }
    default:
      return undefined;
  }
}

export function codexApprovalResponse(method: string, allow: boolean): unknown {
  switch (method) {
    case "execCommandApproval":
    case "applyPatchApproval":
      return allow
        ? { decision: "approved" }
        : { decision: { denied: { rejection: "人没有批准这个操作（拒绝或超时）。" } } };
    case "mcpServer/elicitation/request":
      return allow
        ? { action: "accept", content: {}, _meta: null }
        : { action: "decline", content: null, _meta: null };
    default:
      return { decision: allow ? "accept" : "decline" };
  }
}

/** app-server 返回的 JSON-RPC 错误 */
export class AppServerRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
  ) {
    super(`Codex app-server ${method} 失败：${message}`);
    this.name = "AppServerRpcError";
  }
}

/** 请求在超时时间内没有响应 */
class RequestTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`Codex app-server ${method} 超时（${timeoutMs}ms）。`);
    this.name = "CodexRequestTimeoutError";
    this.name = "RequestTimeoutError";
  }
}

/** Explicit capability rejection only. It is not permission to try a different protocol. */
export class CodexAppServerUnsupportedError extends AgentNonRetryableError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexAppServerUnsupportedError";
  }
}

export function isAppServerUnsupported(error: unknown): boolean {
  return error instanceof CodexAppServerUnsupportedError;
}

export const spawnAppServerTransport: AppServerTransportFactory = spawnStdioTransport;

type PendingRequest = {
  method: string;
  /** 在读取到响应的同一时刻同步调用，避免与紧随其后的通知产生竞态 */
  onResult?: ((result: any) => void) | undefined;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

type Session = {
  transport: AppServerTransport;
  nextId: number;
  pending: Map<number, PendingRequest>;
  /** 本进程已加载（start/resume 过）的线程，避免重复 resume */
  loadedThreads: Set<string>;
  ready: Promise<void>;
  initialized: boolean;
  dead: boolean;
  /** 启动这个进程时关闭的 MCP；设置变了就换新进程 */
  mcpDisabled: string;
};

type AgentMessage = { text: string; phase: string | null; turnId?: string };

type ActiveTurn = {
  session?: Session;
  threadId: string;
  turnId?: string;
  signal?: AbortSignal | undefined;
  onProgress?: ((progress: string) => void) | undefined;
  onTrace?: ((step: TraceStep) => void) | undefined;
  /** 工作区档的审批请求交给人批 */
  requestApproval?: AgentReplyInput["requestApproval"];
  /** 已开始的执行过程条目（按 item id），完成时据此补全 */
  traceSteps: Map<string, TraceStep>;
  messages: AgentMessage[];
  reasoningReported: boolean;
  cancelled: boolean;
  interruptSent: boolean;
  graceTimer?: ReturnType<typeof setTimeout>;
  resolve: (reply: AgentReply) => void;
  reject: (error: Error) => void;
  settled: boolean;
  usage: UsageAccumulator;
  onUsage?: ((usage: AgentUsage) => void) | undefined;
};

function truncate(text: string, max: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

function progressForItem(item: any, turn: ActiveTurn): string | undefined {
  switch (item?.type) {
    case "commandExecution":
      return typeof item.command === "string" && item.command
        ? `执行命令：${truncate(item.command, 80)}`
        : "执行命令";
    case "fileChange": {
      const path = Array.isArray(item.changes) ? item.changes[0]?.path : undefined;
      return typeof path === "string" && path ? `修改文件：${path}` : "修改文件";
    }
    case "mcpToolCall":
      return `调用工具：${item.server}.${item.tool}`;
    case "webSearch":
      return "搜索网页";
    case "contextCompaction":
      return "压缩上下文";
    case "reasoning":
      if (turn.reasoningReported) return undefined;
      turn.reasoningReported = true;
      return "思考中";
    default:
      return undefined;
  }
}

/** Codex 条目对应的执行过程一步；不展示的条目（用户消息、最终回复等）返回 undefined */
function traceForItem(item: any, startedAt: string): TraceStep | undefined {
  if (typeof item?.id !== "string") return undefined;
  const base = { id: item.id, startedAt };
  switch (item.type) {
    case "commandExecution":
      return {
        ...base,
        kind: "tool",
        tool: "command",
        name: "command",
        summary: typeof item.command === "string" ? item.command : "",
        status: "running",
      };
    case "fileChange": {
      const paths = Array.isArray(item.changes)
        ? item.changes
            .map((change: any) => change?.path)
            .filter((path: unknown) => typeof path === "string")
        : [];
      return {
        ...base,
        kind: "tool",
        tool: "write",
        name: "fileChange",
        summary: paths.length > 1 ? `${paths[0]} 等 ${paths.length} 个文件` : (paths[0] ?? ""),
        status: "running",
      };
    }
    case "mcpToolCall":
      return {
        ...base,
        kind: "tool",
        tool: item.server === "hive" ? "collaboration" : "other",
        name: `${item.server}.${item.tool}`,
        summary: `${item.server}.${item.tool}`,
        status: "running",
      };
    case "webSearch":
      return {
        ...base,
        kind: "tool",
        tool: "search",
        name: "webSearch",
        summary: typeof item.query === "string" ? item.query : "",
        status: "running",
      };
    case "reasoning":
      return { ...base, kind: "thinking", status: "running" };
    // 用户消息、回复正文另有处理；压缩上下文没有副作用
    case "userMessage":
    case "agentMessage":
    case "contextCompaction":
      return undefined;
    default:
      // 认不出的条目（动态工具、协作、图片……）照样列出来，并按「可能有副作用」处理
      return {
        ...base,
        kind: "tool",
        tool: "other",
        name: typeof item.type === "string" ? item.type : "item",
        summary: typeof item.type === "string" ? item.type : "",
        status: "running",
      };
  }
}

function traceStatus(item: any): NonNullable<TraceStep["status"]> {
  if (item?.status === "failed" || item?.status === "declined") return "error";
  if (typeof item?.exitCode === "number" && item.exitCode !== 0) return "error";
  return "ok";
}

function agentMessageOf(item: any): AgentMessage | undefined {
  if (item?.type !== "agentMessage" || typeof item.text !== "string") return undefined;
  return { text: item.text, phase: typeof item.phase === "string" ? item.phase : null };
}

/** 优先取最后一条 final_answer，否则取最后一条非空 agentMessage */
function pickReplyText(messages: AgentMessage[]): string {
  const nonEmpty = messages.filter((message) => message.text.trim());
  const final = nonEmpty.filter((message) => message.phase === "final_answer").at(-1);
  return (final ?? nonEmpty.at(-1))?.text.trim() ?? "";
}

function textInput(text: string) {
  return [{ type: "text", text, text_elements: [] }];
}

export class CodexAppServerResponder implements AgentResponder {
  private session: Session | undefined;
  /** thread/start、thread/resume 返回的实际模型，用于用量归属 */
  private readonly threadModels = new Map<string, string>();
  private active: ActiveTurn | undefined;
  private executionUncertain = false;
  private readonly log: (message: string) => void;
  private readonly createTransport: AppServerTransportFactory;
  private readonly requestTimeoutMs: number;
  private readonly interruptGraceMs: number;
  private readonly clientVersion: string;

  constructor(
    private readonly options: CodexAppServerResponderOptions,
    dependencies: CodexAppServerResponderDependencies = {},
  ) {
    this.log = options.log ?? console.warn;
    this.createTransport = dependencies.createTransport ?? spawnAppServerTransport;
    this.requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.interruptGraceMs = dependencies.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
    this.clientVersion = dependencies.clientVersion ?? packageVersion();
  }

  async reply(input: AgentReplyInput): Promise<AgentReply> {
    if (input.signal?.aborted) throw new AgentCancelledError();
    if (this.executionUncertain)
      throw new AgentNonRetryableError(
        "上次 Codex 执行结果尚未确认，当前会话已锁定；请核对执行与工具进程，不能直接重放任务。",
      );
    if (this.active)
      throw new AgentNonRetryableError("Codex 已有进行中的回合，请等待其结束后再发起新回合。");

    // 先占位，防止并发调用在握手期间重复进入
    const placeholder = { settled: false } as ActiveTurn;
    this.active = placeholder;
    let threadId: string;
    let session: Session;
    try {
      this.retireSessionIfMcpChanged();
      session = await this.ensureSession();
      this.throwIfAborted(input.signal);
      threadId = await this.openThread(session, input);
      input.onSession?.(threadId);
      this.throwIfAborted(input.signal);
    } catch (error) {
      if (this.active === placeholder) this.active = undefined;
      if (error instanceof AgentCancelledError) throw error;
      throw codexStartupFailure("app-server 会话准备", error);
    }

    return new Promise<AgentReply>((resolve, reject) => {
      const turn: ActiveTurn = {
        session,
        threadId,
        signal: input.signal,
        onProgress: input.onProgress,
        onTrace: input.onTrace,
        requestApproval: input.requestApproval,
        traceSteps: new Map(),
        messages: [],
        reasoningReported: false,
        cancelled: false,
        interruptSent: false,
        settled: false,
        resolve,
        reject,
        usage: new UsageAccumulator(),
        onUsage: input.onUsage,
      };
      input.onRuntimeEvent?.({ kind: "capabilities", usage: true });
      turn.usage.setModel(this.threadModels.get(threadId) ?? this.options.model);
      this.active = turn;

      const onAbort = () => {
        turn.cancelled = true;
        this.sendInterrupt(turn);
        // Only a terminal event acknowledges stop; an elapsed grace period is not proof.
        turn.graceTimer = setTimeout(() => {
          this.finishTurn(
            turn,
            new AgentExecutionUncertainError(
              "Codex 停止请求尚未收到结束确认，执行结果未知；禁止自动重放。",
            ),
          );
        }, this.interruptGraceMs);
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => input.signal?.removeEventListener("abort", onAbort);
      turn.resolve = (reply) => {
        cleanup();
        resolve(reply);
      };
      turn.reject = (error) => {
        cleanup();
        reject(error);
      };

      const params: Record<string, unknown> = { threadId, input: textInput(input.prompt) };
      if (this.options.model) params.model = this.options.model;
      const onResult = (result: any) => {
        const turnId = result?.turn?.id;
        if (typeof turnId !== "string" || !turnId) {
          this.finishTurn(
            turn,
            new AgentExecutionUncertainError("Codex turn/start 返回缺少回合标识，执行结果未知。"),
          );
          return;
        }
        if (!turn.turnId) turn.turnId = turnId;
        if (turn.cancelled) this.sendInterrupt(turn);
      };
      this.request(session, "turn/start", params, true, onResult).then(
        () => undefined,
        () => {
          this.finishTurn(
            turn,
            new AgentExecutionUncertainError(
              "Codex turn/start 已发送但未取得可信执行结果，可能仍在运行；禁止自动重放。",
            ),
          );
        },
      );
    });
  }

  async steer(prompt: string): Promise<boolean> {
    const turn = this.active;
    const session = this.session;
    if (!turn || turn.settled || !turn.turnId || turn.cancelled || !session || session.dead) {
      return false;
    }
    try {
      await this.request(
        session,
        "turn/steer",
        { threadId: turn.threadId, expectedTurnId: turn.turnId, input: textInput(prompt) },
        true,
      );
      return true;
    } catch (error) {
      if (error instanceof AppServerRpcError) return false;
      const uncertain = new AgentExecutionUncertainError(
        "Codex turn/steer 已发送但未确认是否接收；不能将同一消息退回队列重放。",
      );
      this.finishTurn(turn, uncertain);
      throw uncertain;
    }
  }

  async close(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.teardown(session, new Error("Codex app-server 已关闭。"));
    session.transport.kill();
  }

  private throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new AgentCancelledError();
  }

  private sendInterrupt(turn: ActiveTurn) {
    const session = turn.session;
    if (turn.interruptSent || !turn.turnId || !session || session.dead) return;
    turn.interruptSent = true;
    this.request(
      session,
      "turn/interrupt",
      { threadId: turn.threadId, turnId: turn.turnId },
      true,
    ).catch(() => this.log("[hive] Codex turn/interrupt 未获确认，仍需等待可信结束事件。"));
  }

  private finishTurn(turn: ActiveTurn, outcome: AgentReply | Error) {
    if (turn.settled) return;
    turn.settled = true;
    if (turn.graceTimer) clearTimeout(turn.graceTimer);
    if (this.active === turn) this.active = undefined;
    if (outcome instanceof AgentExecutionUncertainError) this.executionUncertain = true;
    // 成功、失败、停止都交出已观测到的用量
    try {
      turn.onUsage?.(turn.usage.finish());
    } catch {
      // 用量回调异常不影响回合
    }
    if (outcome instanceof Error) turn.reject(outcome);
    else turn.resolve(outcome);
  }

  private async openThread(session: Session, input: AgentReplyInput): Promise<string> {
    const access = codexAccess(this.options.access);
    const common: Record<string, unknown> = {
      cwd: this.options.cwd,
      sandbox: access.sandbox,
      approvalPolicy: access.approvalPolicy,
      developerInstructions: input.instructions,
    };
    if (this.options.model) common.model = this.options.model;

    if (input.threadId) {
      if (session.loadedThreads.has(input.threadId)) return input.threadId;
      try {
        const result = await this.request(
          session,
          "thread/resume",
          { threadId: input.threadId, ...common, excludeTurns: true },
          true,
        );
        const threadId = typeof result?.thread?.id === "string" ? result.thread.id : input.threadId;
        session.loadedThreads.add(threadId);
        if (typeof result?.model === "string") this.threadModels.set(threadId, result.model);
        return threadId;
      } catch (error) {
        if (!(error instanceof AppServerRpcError) || !isMissingCodexThread(error)) throw error;
        this.log("[hive] Codex 明确报告旧会话不存在，在发送执行请求前创建新会话。");
      }
    }

    const result = await this.request(session, "thread/start", common, true);
    const threadId = result?.thread?.id;
    if (typeof threadId !== "string" || !threadId) {
      throw new Error("Codex app-server thread/start 没有返回线程 ID。");
    }
    session.loadedThreads.add(threadId);
    if (typeof result?.model === "string") this.threadModels.set(threadId, result.model);
    return threadId;
  }

  private mcpDisabled(): string[] {
    return readAgentSettings(this.options.settingsFile).mcpDisabled;
  }

  /** MCP 勾选变了：app-server 只在启动时读配置，空闲时换一个新进程（线程照常续接） */
  private retireSessionIfMcpChanged(): void {
    const session = this.session;
    if (!session || session.dead || session.mcpDisabled === this.mcpDisabled().join(",")) return;
    this.log("[hive] MCP 设置已变更，重启 Codex app-server 以加载新的工具");
    this.teardown(session, new Error("MCP 设置已变更"));
    session.transport.kill();
  }

  private ensureSession(): Promise<Session> {
    const existing = this.session;
    if (existing && !existing.dead) return existing.ready.then(() => existing);

    const access = codexAccess(this.options.access);
    const mcpDisabled = this.mcpDisabled();
    const args = [
      "app-server",
      "-c",
      `sandbox_mode="${access.sandbox}"`,
      "-c",
      `approval_policy="${access.approvalPolicy}"`,
      ...codexHiveMcpOverrides(this.options.hive).flatMap((override) => ["-c", override]),
      "-c",
      CODEX_HIVE_TOOLS_APPROVAL_OVERRIDE,
      ...codexMcpDisableOverrides(mcpDisabled).flatMap((override) => ["-c", override]),
    ];
    const transport = this.createTransport(this.options.command, args, { cwd: this.options.cwd });
    const session: Session = {
      transport,
      nextId: 1,
      pending: new Map(),
      loadedThreads: new Set(),
      ready: Promise.resolve(),
      initialized: false,
      dead: false,
      mcpDisabled: mcpDisabled.join(","),
    };
    this.session = session;
    transport.onLine((line) => this.handleLine(session, line));
    transport.onExit((exit) => this.handleExit(session, exit));

    session.ready = (async () => {
      try {
        await this.request(
          session,
          "initialize",
          {
            clientInfo: { name: "superhive", title: "SuperHive", version: this.clientVersion },
            capabilities: null,
          },
          true,
        );
      } catch (error) {
        this.teardown(session, error as Error);
        transport.kill();
        if (error instanceof AppServerRpcError && error.code === -32601) {
          throw new CodexAppServerUnsupportedError(
            "Codex app-server initialize 不受支持（JSON-RPC -32601）；请检查 CLI 版本，不会自动降级。",
            { cause: error },
          );
        }
        throw codexStartupFailure("app-server initialize", error);
      }
      this.notify(session, "initialized");
      session.initialized = true;
    })();
    return session.ready.then(() => session);
  }

  private request(
    session: Session,
    method: string,
    params: unknown,
    withTimeout: boolean,
    onResult?: (result: any) => void,
  ): Promise<any> {
    if (session.dead) return Promise.reject(new Error("Codex app-server 未运行。"));
    const id = session.nextId++;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { method, resolve, reject, onResult };
      if (withTimeout) {
        pending.timer = setTimeout(() => {
          session.pending.delete(id);
          reject(new RequestTimeoutError(method, this.requestTimeoutMs));
        }, this.requestTimeoutMs);
      }
      session.pending.set(id, pending);
      session.transport.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private notify(session: Session, method: string, params?: unknown) {
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    session.transport.write(JSON.stringify(message));
  }

  private respond(session: Session, id: unknown, result: unknown) {
    session.transport.write(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private handleLine(session: Session, line: string) {
    if (session.dead) return;
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let message: any;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;

    const hasId = message.id !== undefined && message.id !== null;
    if (hasId && typeof message.method === "string") {
      this.handleServerRequest(session, message.id, message.method, message.params);
      return;
    }
    if (hasId) {
      const pending = session.pending.get(message.id);
      if (!pending) return;
      session.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new AppServerRpcError(
            pending.method,
            typeof message.error.code === "number" ? message.error.code : undefined,
            String(message.error.message ?? "未知错误"),
          ),
        );
      } else {
        pending.onResult?.(message.result);
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      this.handleNotification(message.method, message.params);
    }
  }

  /**
   * Codex 的审批请求：工作区档交给人批（Bridge 转成「允许 / 拒绝」的提问），批了才放行；
   * 只读档、没有人可问、或要填表单的 MCP 确认，一律拒绝。
   */
  private handleServerRequest(session: Session, id: unknown, method: string, params: any) {
    const turn = this.active;
    const ask =
      (this.options.access ?? "read-only") === "workspace" && turn && !turn.settled
        ? turn.requestApproval
        : undefined;
    const request = ask ? codexApprovalRequest(method, params) : undefined;
    if (ask && request) {
      void ask(request).then(
        (allow) => this.respond(session, id, codexApprovalResponse(method, allow)),
        () => this.respond(session, id, codexApprovalResponse(method, false)),
      );
      return;
    }
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        this.respond(session, id, { decision: "decline" });
        return;
      case "execCommandApproval":
      case "applyPatchApproval":
        this.respond(session, id, {
          decision: { denied: { rejection: "SuperHive 代理以非交互方式运行，不接受审批请求。" } },
        });
        return;
      case "mcpServer/elicitation/request":
        this.respond(session, id, { action: "decline", content: null, _meta: null });
        return;
      default:
        void params;
        session.transport.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `SuperHive 不支持的请求：${method}` },
          }),
        );
    }
  }

  private matchesActive(params: any): ActiveTurn | undefined {
    const turn = this.active;
    if (!turn || turn.settled || !turn.threadId || params?.threadId !== turn.threadId) {
      return undefined;
    }
    const turnId = params.turnId ?? params.turn?.id;
    if (turn.turnId && typeof turnId === "string" && turnId !== turn.turnId) return undefined;
    return turn;
  }

  private handleNotification(method: string, params: any) {
    switch (method) {
      case "turn/started": {
        const turn = this.matchesActive(params);
        if (turn && !turn.turnId && typeof params.turn?.id === "string") {
          turn.turnId = params.turn.id;
          if (turn.cancelled) this.sendInterrupt(turn);
        }
        return;
      }
      case "item/started": {
        const turn = this.matchesActive(params);
        const step = turn?.onTrace
          ? traceForItem(params.item, new Date().toISOString())
          : undefined;
        if (turn && step && turn.traceSteps.size < 1024) {
          turn.traceSteps.set(step.id, step);
          try {
            turn.onTrace!(step);
          } catch {
            // 进度回调异常不影响回合
          }
        }
        if (!turn?.onProgress) return;
        const progress = progressForItem(params.item, turn);
        if (progress) {
          try {
            turn.onProgress(progress);
          } catch {
            // 进度回调异常不影响回合
          }
        }
        return;
      }
      case "item/completed": {
        const turn = this.matchesActive(params);
        const started =
          turn && typeof params.item?.id === "string"
            ? turn.traceSteps.get(params.item.id)
            : undefined;
        if (turn && started) {
          turn.traceSteps.delete(started.id);
          const latest = traceForItem(params.item, started.startedAt);
          try {
            turn.onTrace?.({
              ...started,
              ...(latest?.summary ? { summary: latest.summary } : {}),
              status: traceStatus(params.item),
              endedAt: new Date().toISOString(),
            });
          } catch {
            // 进度回调异常不影响回合
          }
        }
        const message = turn ? agentMessageOf(params.item) : undefined;
        // 中途说的话（不是最终回复）也放进执行过程
        if (turn?.onTrace && message && message.phase !== "final_answer" && message.text.trim()) {
          const at = new Date().toISOString();
          try {
            turn.onTrace({
              id: typeof params.item?.id === "string" ? params.item.id : `text:${at}`,
              kind: "text",
              text: message.text,
              startedAt: at,
              endedAt: at,
            });
          } catch {
            // 进度回调异常不影响回合
          }
        }
        if (turn && message) {
          // 回合 ID 未知时也先收下，完成时再按回合 ID 过滤
          turn.messages.push({
            ...message,
            ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
          });
        }
        return;
      }
      case "thread/tokenUsage/updated": {
        // 每次模型响应后推送一次；last 是这一次响应的用量，total 的累计值可唯一标识这次响应
        const turn = this.matchesActive(params);
        const usage = params?.tokenUsage;
        const buckets = codexBuckets(usage?.last);
        if (!turn || !buckets) return;
        const key = String(usage?.total?.totalTokens ?? `update-${Date.now()}`);
        turn.usage.request(key, buckets);
        turn.usage.setContextWindow(usage?.modelContextWindow);
        return;
      }
      case "turn/completed": {
        const turn = this.matchesActive(params);
        if (turn) this.completeTurn(turn, params.turn);
        return;
      }
      default:
        return;
    }
  }

  private completeTurn(turn: ActiveTurn, result: any) {
    const status = result?.status;
    if (!["completed", "failed", "interrupted"].includes(status)) {
      this.finishTurn(
        turn,
        new AgentExecutionUncertainError("Codex 未返回可信终态，结果未知；禁止自动重放。"),
      );
      return;
    }
    if (turn.cancelled && typeof result?.id !== "string") {
      this.finishTurn(
        turn,
        new AgentExecutionUncertainError("Codex 结束事件缺少回合标识，不能确认停止。"),
      );
      return;
    }
    if (turn.cancelled || (status === "interrupted" && turn.signal?.aborted)) {
      this.finishTurn(turn, new AgentCancelledError());
      return;
    }
    if (status === "failed" && result?.error) {
      const detail = JSON.stringify(result.error);
      if (isUpstreamFailure(detail)) {
        const message =
          typeof result.error.message === "string" && result.error.message.trim()
            ? result.error.message
            : detail;
        this.finishTurn(
          turn,
          new AgentUpstreamError(redactTrace(truncate(message, 240)), turn.threadId),
        );
        return;
      }
    }
    if (status === "failed") {
      // 带上 Codex 给的失败原因（限流、额度、上下文超长……），不然只看得到「失败」不知道为什么
      const reason =
        typeof result?.error?.message === "string" && result.error.message.trim()
          ? `：${redactTrace(truncate(result.error.message, 240))}`
          : "";
      this.finishTurn(
        turn,
        new AgentNonRetryableError(
          `Codex 回合已报告失败${reason}；可能已执行部分操作，不会自动重放。`,
        ),
      );
      return;
    }
    if (status === "interrupted") {
      this.finishTurn(turn, new AgentNonRetryableError("Codex 回合被中断；不会自动重放。"));
      return;
    }
    let messages = turn.messages.filter(
      (message) => !message.turnId || !turn.turnId || message.turnId === turn.turnId,
    );
    if (!messages.length && Array.isArray(result?.items)) {
      messages = result.items
        .map((item: unknown) => agentMessageOf(item))
        .filter((item: AgentMessage | undefined): item is AgentMessage => Boolean(item));
    }
    const text = pickReplyText(messages);
    if (!text) {
      this.finishTurn(
        turn,
        new AgentExecutionUncertainError(
          "Codex 已结束但没有返回可发送的文本，结果未知；禁止自动重放。",
        ),
      );
      return;
    }
    const usage = turn.usage.finish();
    this.finishTurn(turn, {
      text,
      threadId: turn.threadId,
      ...(usage.requests > 0 ? { usage } : {}),
    });
  }

  private handleExit(session: Session, exit: AppServerExit) {
    // close() 或握手失败时已经收尾过
    if (session.dead) return;
    let error: Error;
    if ((exit.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      error = Object.assign(
        new Error(`找不到 Codex 命令 “${this.options.command}”。请先安装 Codex CLI 并完成登录。`),
        { code: "ENOENT" },
      );
    } else {
      const detail = `code=${exit.code ?? "null"}${exit.signal ? `, signal=${exit.signal}` : ""}`;
      error = codexStartupFailure(`app-server 退出（${detail}）`, exit.error, exit.stderr);
    }
    this.teardown(session, error);
  }

  /** A dead transport is not proof that submitted execution had no side effects. */
  private teardown(session: Session, error: Error) {
    session.dead = true;
    if (this.session === session) this.session = undefined;
    for (const pending of session.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    session.pending.clear();
    const turn = this.active;
    if (turn && turn.session === session) {
      this.finishTurn(
        turn,
        new AgentExecutionUncertainError(
          "Codex app-server 连接关闭，已发送回合的执行结果未知；禁止自动重放。",
        ),
      );
    }
  }
}
