import { lstatSync, readlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { acpHiveMcpServer, type HiveMcpConnection } from "./hive-mcp-config.js";
import type { TraceStep } from "./hive-protocol.js";
import { ThinkingTrace } from "./trace.js";
import {
  AgentCancelledError,
  AgentNonRetryableError,
  AgentSessionInvalidError,
  AgentUpstreamError,
  isModelUnavailable,
  isSessionInvalid,
  isUpstreamFailure,
  type AgentAccessMode,
  type AgentReply,
  type AgentReplyInput,
  type AgentResponder,
} from "./responder.js";
import {
  spawnStdioTransport,
  type StdioExit,
  type StdioTransport,
  type StdioTransportFactory,
} from "./stdio-transport.js";

/**
 * 基于 Agent Client Protocol（ACP，stdio 上的换行分隔 JSON-RPC）的通用 Responder。
 * opencode（`opencode acp`）、omp（`omp --mode acp`）、Gemini CLI（`gemini --acp`）与 agy（`agy acp`）
 * 都实现了 ACP 的 Agent 端，相比逐次调用 CLI：
 * - Hive MCP 随 session/new 按会话注入，不写入任何配置文件，也不受用户全局 MCP 影响（omp）
 * - Agent 发起的 session/request_permission 由本客户端按 --access 档位逐次裁决
 * - 停止走 session/cancel，工具调用通过 session/update 实时上报为进度
 * - 进程常驻，会话可在进程重启后通过 session/resume 或 session/load 恢复
 */

export const ACP_PROTOCOL_VERSION = 1;

export type AcpToolCall = {
  title?: string;
  kind?: string;
  /** 工具名（agy 等会带，如 mcp_hive_hive_board_update） */
  name?: string;
  /** Agent 自己的扩展信息（Gemini CLI 在这里写 MCP 的 server_name、tool_name） */
  _meta?: unknown;
  locations?: Array<{ path?: string }>;
  rawInput?: unknown;
};

export type AcpResponderOptions = {
  /** 日志与错误里显示的名称，如 "OpenCode" */
  label: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd: string;
  hive: HiveMcpConnection;
  access?: AgentAccessMode;
  log?: (message: string) => void;
  /**
   * 认出随会话注入的 Hive MCP 的工具调用：会为 MCP 工具发权限请求的 Agent（Gemini CLI、agy）提供，
   * 这些调用一律放行（只作用于聊天室本身，服务端另有预算与权限限制），否则只读档连 hive_message_send 都会被拒
   */
  isHiveTool?: (toolCall: AcpToolCall) => boolean;
  /**
   * Agent 要求先登录（session/new 等返回 Authentication required）时：
   * apiKeyMethod 是 initialize 返回的 authMethods 里用 API key 登录的那一项，环境里有 key（hasApiKey）就自动
   * authenticate 后重试；否则以 hint 提示人去终端登录，不自动重试
   */
  auth?: { hint: string; apiKeyMethod?: string; hasApiKey?: boolean };
  /** 没指定模型的回合用的模型：启动参数里没法指定模型的 Agent（agy）用它，按会话切换 */
  defaultModel?: string;
};

export type AcpResponderDependencies = {
  /** 自定义传输（测试用）；默认 spawn 真实的 Agent 进程 */
  createTransport?: StdioTransportFactory;
  /** 握手类请求（initialize / session/new / load / steering）的超时，默认 120s */
  requestTimeoutMs?: number;
  /** 发出 session/cancel 后等待 prompt 结束的宽限时间，超时则结束进程，默认 10s */
  cancelGraceMs?: number;
  clientVersion?: string;
  /** 空闲多久结束 Agent 进程（下次被叫到再拉起，会话照常恢复），默认 10 分钟；0 表示不结束 */
  idleTimeoutMs?: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_CANCEL_GRACE_MS = 10_000;
/** 每个用过的房间都有一个 Agent 进程：空闲这么久就结束，免得挂着一堆进程占内存 */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

function idleText(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require("../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Agent 返回的 JSON-RPC 错误 */
export class AcpRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
  ) {
    super(`${method} 失败：${message}`);
    this.name = "AcpRpcError";
  }
}

class RequestTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`${method} 超时（${timeoutMs}ms）。`);
    this.name = "RequestTimeoutError";
  }
}

/** ACP 规定 -32000 是 auth_required；各家的文案不同（agy：Authentication required；Gemini CLI：API key is missing） */
function isAuthRequired(error: AcpRpcError): boolean {
  return (
    error.code === -32000 && /authenticat|api key|log ?in|sign ?in|credential/i.test(error.message)
  );
}

/** Windows 上 path.relative 不分大小写，盘符不同时返回绝对路径，都按目录外处理 */
export function isInsideDir(
  root: string,
  target: string,
  paths: path.PlatformPath = path,
): boolean {
  const relative = paths.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !paths.isAbsolute(relative));
}

/** 符号链接最多跟这么多次，超过当成循环（和 Linux 的 ELOOP 上限一致） */
const MAX_SYMLINK_HOPS = 40;

/** POSIX 上反斜杠是普通文件名字符，只有 Windows 两种分隔符都认 */
function segments(input: string): string[] {
  return input
    .split(path.sep === "\\" ? /[\\/]+/ : "/")
    .filter((part) => part !== "" && part !== ".");
}

/**
 * 按操作系统实际访问的方式逐段解析路径，得到真实路径；不能只按字面 path.resolve，否则：
 * - cwd 里指向外面的软链（link → /etc），写 link/x 实际落在 /etc/x；
 * - 末段是悬空软链时 realpath 报不存在，但写它会在链接指向处新建文件；
 * - link/.. 在系统里是链接目标的上一级，按字面却折回了 cwd。
 * 已存在的部分逐段 lstat、遇到软链就把链接内容展开进待解析的段；从第一个不存在的段起，剩下的按字面拼接
 * （新建的目录不会是软链）。软链循环、无权限等异常返回 undefined，调用方按目录外处理。
 */
function resolveRealPath(cwd: string, target: string): string | undefined {
  const absolute = path.isAbsolute(target) ? target : `${cwd}${path.sep}${target}`;
  const root = path.parse(path.resolve(absolute)).root;
  const pending = segments(absolute.slice(path.parse(absolute).root.length));
  let resolved = root;
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.shift()!;
    if (part === "..") {
      // resolved 一直是真实路径，取上一级就是系统里的上一级
      resolved = path.dirname(resolved);
      continue;
    }
    const next = path.join(resolved, part);
    let isLink: boolean;
    try {
      isLink = lstatSync(next).isSymbolicLink();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return path.join(next, ...pending);
      return undefined;
    }
    if (!isLink) {
      resolved = next;
      continue;
    }
    if (++hops > MAX_SYMLINK_HOPS) return undefined;
    let link: string;
    try {
      link = readlinkSync(next);
    } catch {
      return undefined;
    }
    if (path.isAbsolute(link)) resolved = path.parse(path.resolve(link)).root;
    pending.unshift(
      ...segments(path.isAbsolute(link) ? link.slice(path.parse(link).root.length) : link),
    );
  }
  return resolved;
}

/**
 * 路径在 cwd 内：两边都先解析成真实路径再比较。cwd 本身经过符号链接时（macOS 的 /tmp → /private/tmp）
 * Agent 报上来的常是真实路径，照常算在内；cwd 里指向外面的软链、悬空软链、link/.. 都按实际落点算。
 * 解析不了（软链循环、无权限）一律算在外，工作区档会转给人批，不会放行
 */
function isInside(cwd: string, target: string): boolean {
  const root = resolveRealPath(cwd, ".");
  const real = resolveRealPath(cwd, target);
  return root !== undefined && real !== undefined && isInsideDir(root, real);
}

/** 从工具调用里收集涉及的文件路径：locations 优先，rawInput 里常见的路径字段兜底 */
function toolCallPaths(toolCall: AcpToolCall): string[] {
  const paths = (toolCall.locations ?? [])
    .map((location) => location.path)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const input = toolCall.rawInput;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const key of ["path", "filePath", "file_path", "from", "to", "destination"]) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === "string" && value) paths.push(value);
    }
  }
  return paths;
}

/**
 * 按 --access 档位裁决一次权限请求。Hive 代理无人值守，没有"询问用户"这一选项：
 * - read-only：只放行读取、搜索、思考类工具
 * - workspace：文件改动必须全部落在 cwd 之内（无法判断路径时拒绝），命令执行放行
 * - full：全部放行
 */
export function decideAcpPermission(
  access: AgentAccessMode,
  cwd: string,
  toolCall: AcpToolCall,
): "allow" | "reject" {
  if (access === "full") return "allow";
  const kind = toolCall.kind ?? "other";
  if (access === "read-only")
    return ["read", "search", "think"].includes(kind) ? "allow" : "reject";
  if (kind === "edit" || kind === "delete" || kind === "move") {
    const paths = toolCallPaths(toolCall);
    return paths.length > 0 && paths.every((target) => isInside(cwd, target)) ? "allow" : "reject";
  }
  return "allow";
}

type PermissionOption = { optionId: string; kind?: string };

/** 只用一次性选项，避免 "always" 把单次裁决扩大成会话级授权 */
function pickPermissionOption(
  options: PermissionOption[],
  decision: "allow" | "reject",
): PermissionOption | undefined {
  const preferred =
    decision === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of preferred) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) return option;
  }
  return undefined;
}

function truncate(text: string, max: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

function progressForToolCall(toolCall: AcpToolCall): string | undefined {
  const title = toolCall.title ? truncate(toolCall.title, 80) : "";
  if (!title) return undefined;
  switch (toolCall.kind) {
    case "execute":
      return `执行命令：${title}`;
    case "edit":
    case "delete":
    case "move":
      return `修改文件：${title}`;
    case "read":
      return `读取：${title}`;
    case "search":
      return `搜索：${title}`;
    case "fetch":
      return `获取：${title}`;
    case "think":
      return undefined;
    default:
      return `调用工具：${title}`;
  }
}

const acpToolCategories: Record<string, NonNullable<TraceStep["tool"]>> = {
  execute: "command",
  edit: "write",
  delete: "write",
  move: "write",
  read: "read",
  search: "search",
  fetch: "search",
};

/** 会话打开时返回的可选模型：configOptions 里的 model 优先，没有再看 models（Gemini CLI 只给这个） */
export function sessionModelChoices(
  result: any,
): { current?: string; options: string[]; via: "config" | "model" } | undefined {
  const configOptions = Array.isArray(result?.configOptions) ? result.configOptions : [];
  const model = configOptions.find(
    (option: any) => option?.id === "model" || option?.category === "model",
  );
  if (model) {
    const options = Array.isArray(model.options)
      ? model.options
          .map((option: any) => option?.value)
          .filter((value: unknown): value is string => typeof value === "string")
      : [];
    const current = typeof model.currentValue === "string" ? model.currentValue : undefined;
    return { ...(current ? { current } : {}), options, via: "config" };
  }
  const models = result?.models;
  if (!models || !Array.isArray(models.availableModels)) return undefined;
  const options = models.availableModels
    .map((option: any) => option?.modelId)
    .filter((value: unknown): value is string => typeof value === "string");
  const current = typeof models.currentModelId === "string" ? models.currentModelId : undefined;
  return { ...(current ? { current } : {}), options, via: "model" };
}

function offersAuth(agent: { authMethods: Array<{ id?: unknown }> }, methodId: string): boolean {
  return agent.authMethods.some((method) => method?.id === methodId);
}

type PendingRequest = {
  method: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

type AgentProcess = {
  transport: StdioTransport;
  nextId: number;
  pending: Map<number, PendingRequest>;
  /** 本进程已创建或恢复过的会话 */
  loadedSessions: Set<string>;
  /**
   * 会话能切的模型（session/new、load、resume 返回的 configOptions 里 id 为 model 的那项，
   * 没有时用 models.availableModels，如 Gemini CLI）：initial 是会话打开时的模型，没指定模型的回合切回它，
   * 「换个模型重试」才只管这一次；via 是切换用的方法
   */
  sessionModels: Map<
    string,
    { initial?: string; current?: string; options: string[]; via: "config" | "model" }
  >;
  /** 这个进程已用 API key 登录过（authenticate） */
  authenticated: boolean;
  /** initialize 返回的登录方式 */
  authMethods: Array<{ id?: unknown }>;
  capabilities: any;
  steering: boolean;
  ready: Promise<void>;
  initialized: boolean;
  dead: boolean;
};

type ActiveTurn = {
  process?: AgentProcess;
  sessionId?: string;
  signal?: AbortSignal | undefined;
  onProgress?: ((progress: string) => void) | undefined;
  onTrace?: ((step: TraceStep) => void) | undefined;
  /** 工作区档超出范围的权限请求交给人批 */
  requestApproval?: AgentReplyInput["requestApproval"];
  /** 已开始的执行过程条目（按 toolCallId），更新与完成时据此补全 */
  traceSteps: Map<string, TraceStep>;
  /** 正在进行的思考的步骤 id（收到思考片段时开始，开始说话或调用工具时结束） */
  thinkingStep?: string | undefined;
  /** 思考正文的累积、节流与段数上限 */
  thinking: ThinkingTrace;
  /** 按工具调用切分的回复片段：最后一个非空片段即最终回答 */
  segments: string[];
  toolTitles: Map<string, string>;
  thinkingReported: boolean;
  cancelled: boolean;
  graceTimer?: ReturnType<typeof setTimeout>;
  resolve: (reply: AgentReply) => void;
  reject: (error: Error) => void;
  settled: boolean;
};

export class AcpResponder implements AgentResponder {
  private agent: AgentProcess | undefined;
  private active: ActiveTurn | undefined;
  private readonly log: (message: string) => void;
  private readonly createTransport: StdioTransportFactory;
  private readonly requestTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly idleTimeoutMs: number;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly clientVersion: string;
  /** 已知要用 API key 登录：之后拉起的进程握手后先 authenticate，免得恢复旧会话时才被拒 */
  private useApiKeyAuth = false;

  constructor(
    private readonly options: AcpResponderOptions,
    dependencies: AcpResponderDependencies = {},
  ) {
    this.log = options.log ?? console.warn;
    this.createTransport = dependencies.createTransport ?? spawnStdioTransport;
    this.requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.cancelGraceMs = dependencies.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.idleTimeoutMs = dependencies.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.clientVersion = dependencies.clientVersion ?? packageVersion();
  }

  async reply(input: AgentReplyInput): Promise<AgentReply> {
    if (input.signal?.aborted) throw new AgentCancelledError();
    if (this.active) {
      throw new Error(`${this.options.label} 已有进行中的回合，请等待其结束后再发起新回合。`);
    }

    // 先占位，防止并发调用在握手期间重复进入
    const placeholder = { settled: false } as ActiveTurn;
    this.active = placeholder;
    this.cancelIdleRetire();
    let agent: AgentProcess;
    let session: { sessionId: string; fresh: boolean };
    try {
      agent = await this.ensureAgent();
      this.throwIfAborted(input.signal);
      session = await this.openSession(agent, input.threadId, Boolean(input.refreshInstructions));
      input.onSession?.(session.sessionId);
      this.throwIfAborted(input.signal);
      await this.useModel(agent, session.sessionId, input.model ?? this.options.defaultModel);
      this.throwIfAborted(input.signal);
    } catch (error) {
      if (this.active === placeholder) {
        this.active = undefined;
        this.scheduleIdleRetire();
      }
      throw error;
    }

    // ACP 没有系统提示词字段：新会话或需要刷新时把规则拼进本轮消息
    const text =
      session.fresh || input.refreshInstructions
        ? `${input.instructions}\n\n---\n\n${input.prompt}`
        : input.prompt;

    return new Promise<AgentReply>((resolve, reject) => {
      const turn: ActiveTurn = {
        process: agent,
        sessionId: session.sessionId,
        signal: input.signal,
        onProgress: input.onProgress,
        onTrace: input.onTrace,
        requestApproval: input.requestApproval,
        traceSteps: new Map(),
        thinking: new ThinkingTrace((step) => this.traceStep(turn, step)),
        segments: [""],
        toolTitles: new Map(),
        thinkingReported: false,
        cancelled: false,
        settled: false,
        resolve,
        reject,
      };
      this.active = turn;

      const onAbort = () => this.cancelTurn(turn);
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

      this.request(
        agent,
        "session/prompt",
        { sessionId: session.sessionId, prompt: [{ type: "text", text }] },
        false,
      ).then(
        (result) => this.completeTurn(turn, result),
        (error: Error) =>
          this.finishTurn(
            turn,
            turn.cancelled ? new AgentCancelledError() : this.classifyPromptError(turn, error),
          ),
      );
    });
  }

  async steer(prompt: string): Promise<boolean> {
    const turn = this.active;
    const agent = this.agent;
    if (!turn || turn.settled || turn.cancelled || !turn.sessionId) return false;
    if (!agent || agent.dead || !agent.steering || turn.process !== agent) return false;
    try {
      const result = await this.request(
        agent,
        "_session/steering",
        { sessionId: turn.sessionId, prompt: [{ type: "text", text: prompt }] },
        true,
      );
      return result?.outcome === "injected";
    } catch (error) {
      if (!(error instanceof AcpRpcError)) {
        this.log(`[hive] ${this.options.label} 注入消息失败：${(error as Error).message}`);
      }
      return false;
    }
  }

  async close(): Promise<void> {
    this.cancelIdleRetire();
    const agent = this.agent;
    if (!agent) return;
    this.teardown(agent, new Error(`${this.options.label} 已关闭。`));
    agent.transport.kill();
  }

  private throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new AgentCancelledError();
  }

  private cancelTurn(turn: ActiveTurn) {
    if (turn.settled || turn.cancelled) return;
    turn.cancelled = true;
    const agent = turn.process;
    if (!agent || agent.dead || !turn.sessionId) {
      this.finishTurn(turn, new AgentCancelledError());
      return;
    }
    this.notify(agent, "session/cancel", { sessionId: turn.sessionId });
    // 等待 prompt 以 stopReason=cancelled 结束；Agent 卡住时结束进程，下次回合会恢复会话
    turn.graceTimer = setTimeout(() => {
      this.log(`[hive] ${this.options.label} 未在宽限期内停止，结束进程。`);
      this.finishTurn(turn, new AgentCancelledError());
      this.teardown(agent, new AgentCancelledError());
      agent.transport.kill();
    }, this.cancelGraceMs);
  }

  private cancelIdleRetire(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** 回合结束后开始计时：一直没人叫就结束进程，下次 reply 重新拉起并 session/resume（或 load）续接 */
  private scheduleIdleRetire(): void {
    this.cancelIdleRetire();
    if (this.idleTimeoutMs <= 0 || !this.agent || this.agent.dead) return;
    this.idleTimer = setTimeout(() => this.retireIdleAgent(), this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private retireIdleAgent(): void {
    this.idleTimer = undefined;
    const agent = this.agent;
    if (!agent || agent.dead || this.active || agent.pending.size > 0) return;
    this.log(
      `[hive] ${this.options.label} 已空闲 ${idleText(this.idleTimeoutMs)}，先结束进程；下次被叫到再启动并恢复会话`,
    );
    this.teardown(agent, new Error(`${this.options.label} 空闲已结束`));
    agent.transport.kill();
  }

  private finishTurn(turn: ActiveTurn, outcome: AgentReply | Error) {
    if (turn.settled) return;
    this.endThinking(turn);
    turn.settled = true;
    if (turn.graceTimer) clearTimeout(turn.graceTimer);
    if (this.active === turn) {
      this.active = undefined;
      this.scheduleIdleRetire();
    }
    if (outcome instanceof Error) turn.reject(outcome);
    else turn.resolve(outcome);
  }

  private completeTurn(turn: ActiveTurn, result: any) {
    const stopReason = typeof result?.stopReason === "string" ? result.stopReason : "end_turn";
    const label = this.options.label;
    if (turn.cancelled || (stopReason === "cancelled" && turn.signal?.aborted)) {
      this.finishTurn(turn, new AgentCancelledError());
      return;
    }
    const text =
      turn.segments
        .filter((segment) => segment.trim())
        .at(-1)
        ?.trim() ?? "";
    if (stopReason === "cancelled") {
      this.finishTurn(turn, new Error(`${label} 回合被中断。`));
      return;
    }
    if (stopReason === "refusal") {
      this.finishTurn(turn, new Error(`${label} 拒绝了这次请求。`));
      return;
    }
    if (!text) {
      const reason = stopReason === "end_turn" ? "" : `（${stopReason}）`;
      this.finishTurn(turn, new Error(`${label} 没有返回可发送的文本${reason}。`));
      return;
    }
    // max_tokens / max_turn_requests 时仍把已生成的回答发出去，比整轮失败更有用
    this.finishTurn(turn, { text, threadId: turn.sessionId! });
  }

  /** session/prompt 被拒：会话坏了、模型用不了单独归类，Bridge 据此开新会话或换模型 */
  private classifyPromptError(turn: ActiveTurn, error: Error): Error {
    const text = error.message;
    if (isSessionInvalid(text))
      return new AgentSessionInvalidError(text.slice(0, 240), turn.toolTitles.size > 0);
    if (isModelUnavailable(text))
      return new AgentUpstreamError(text.slice(0, 240), turn.sessionId, "model");
    if (isUpstreamFailure(text)) return new AgentUpstreamError(text.slice(0, 240), turn.sessionId);
    return error;
  }

  /**
   * 按轮切模型：ACP 的会话在 configOptions 里列出能选的模型（opencode、omp、agy 都有），
   * 用 session/set_config_option 切换当前会话；只给 models 的（Gemini CLI）用 session/set_model。
   * 没列出、或不在候选里的就不切，照原模型跑。
   */
  private async useModel(
    agent: AgentProcess,
    sessionId: string,
    requested: string | undefined,
  ): Promise<void> {
    const known = agent.sessionModels.get(sessionId);
    const model = requested ?? known?.initial;
    if (!known || !model || known.current === model) return;
    if (!known.options.includes(model)) {
      // 人指定的模型这个运行时没有：明说，别悄悄用原模型跑
      if (requested) {
        throw new AgentUpstreamError(
          `${this.options.label} 没有模型 ${model}（可选：${known.options.slice(0, 8).join("、")}）`,
          sessionId,
          "model",
        );
      }
      return;
    }
    try {
      if (known.via === "model") {
        await this.request(agent, "session/set_model", { sessionId, modelId: model }, true);
      } else {
        await this.request(
          agent,
          "session/set_config_option",
          { sessionId, configId: "model", value: model },
          true,
        );
      }
    } catch (error) {
      if (requested) throw error;
      // 只是切回会话原来的模型：切不回去不影响这一轮，记一笔照常跑
      this.log(`[hive] ${this.options.label} 切回模型 ${model} 失败：${(error as Error).message}`);
      return;
    }
    agent.sessionModels.set(sessionId, { ...known, current: model });
  }

  private rememberModels(agent: AgentProcess, sessionId: string, result: any): void {
    const found = sessionModelChoices(result);
    if (!found) return;
    const initial = agent.sessionModels.get(sessionId)?.initial ?? found.current;
    agent.sessionModels.set(sessionId, {
      ...(initial ? { initial } : {}),
      ...(found.current ? { current: found.current } : {}),
      options: found.options,
      via: found.via,
    });
  }

  private async openSession(
    agent: AgentProcess,
    threadId: string | undefined,
    fullPrompt = true,
  ): Promise<{ sessionId: string; fresh: boolean }> {
    const params = { cwd: this.options.cwd, mcpServers: [acpHiveMcpServer(this.options.hive)] };
    if (threadId) {
      if (agent.loadedSessions.has(threadId)) return { sessionId: threadId, fresh: false };
      // session/resume 不回放历史，优先使用；否则退回 session/load（回放的 session/update 会被忽略）
      const method = agent.capabilities?.sessionCapabilities?.resume
        ? "session/resume"
        : agent.capabilities?.loadSession
          ? "session/load"
          : undefined;
      if (method) {
        try {
          const resumed = await this.sessionRequest(agent, method, {
            sessionId: threadId,
            ...params,
          });
          agent.loadedSessions.add(threadId);
          this.rememberModels(agent, threadId, resumed);
          return { sessionId: threadId, fresh: false };
        } catch (error) {
          if (!(error instanceof AcpRpcError)) throw error;
          // 这一轮的提示只带了新消息（续接旧会话用的）：新会话看不到房间上下文，交给 Bridge 带完整上下文重来
          if (!fullPrompt) throw new AgentSessionInvalidError(error.message.slice(0, 240));
          this.log(
            `[hive] ${this.options.label} 旧会话 ${threadId} 已失效（${error.message}），自动创建新会话继续处理。`,
          );
        }
      }
    }
    const result = await this.sessionRequest(agent, "session/new", params);
    const sessionId = result?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error(`${this.options.label} session/new 没有返回会话 ID。`);
    }
    agent.loadedSessions.add(sessionId);
    this.rememberModels(agent, sessionId, result);
    return { sessionId, fresh: true };
  }

  /** 打开会话的请求：Agent 说要先登录时，能用 API key 就 authenticate 后重试一次，否则提示人去登录 */
  private async sessionRequest(agent: AgentProcess, method: string, params: unknown): Promise<any> {
    try {
      return await this.request(agent, method, params, true);
    } catch (error) {
      const auth = this.options.auth;
      if (!auth || !(error instanceof AcpRpcError) || !isAuthRequired(error)) throw error;
      const methodId = auth.apiKeyMethod;
      if (agent.authenticated || !methodId || !auth.hasApiKey || !offersAuth(agent, methodId)) {
        throw new AgentNonRetryableError(`${this.options.label} 还没有登录：${auth.hint}`);
      }
      this.log(`[hive] ${this.options.label} 未登录账号，改用环境里的 API key 登录（${methodId}）`);
      await this.request(agent, "authenticate", { methodId }, true);
      agent.authenticated = true;
      this.useApiKeyAuth = true;
      return this.request(agent, method, params, true);
    }
  }

  private ensureAgent(): Promise<AgentProcess> {
    const existing = this.agent;
    if (existing && !existing.dead) return existing.ready.then(() => existing);

    const transport = this.createTransport(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      ...(this.options.env ? { env: this.options.env } : {}),
    });
    const agent: AgentProcess = {
      transport,
      nextId: 1,
      pending: new Map(),
      loadedSessions: new Set(),
      sessionModels: new Map(),
      authenticated: false,
      authMethods: [],
      capabilities: undefined,
      steering: false,
      ready: Promise.resolve(),
      initialized: false,
      dead: false,
    };
    this.agent = agent;
    transport.onLine((line) => this.handleLine(agent, line));
    transport.onExit((exit) => this.handleExit(agent, exit));

    agent.ready = (async () => {
      let result: any;
      try {
        result = await this.request(
          agent,
          "initialize",
          {
            protocolVersion: ACP_PROTOCOL_VERSION,
            // 不提供文件系统与终端能力：Agent 用自己的工具，权限由 request_permission 裁决
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "superhive", title: "SuperHive", version: this.clientVersion },
          },
          true,
        );
      } catch (error) {
        this.teardown(agent, error as Error);
        transport.kill();
        throw error;
      }
      if (result?.protocolVersion !== ACP_PROTOCOL_VERSION) {
        const error = new Error(
          `${this.options.label} 的 ACP 协议版本为 ${String(result?.protocolVersion)}，SuperHive 仅支持版本 ${ACP_PROTOCOL_VERSION}。`,
        );
        this.teardown(agent, error);
        transport.kill();
        throw error;
      }
      agent.capabilities = result.agentCapabilities ?? {};
      agent.authMethods = Array.isArray(result.authMethods) ? result.authMethods : [];
      agent.steering = result._meta?.steering?.supported === true;
      const methodId = this.options.auth?.apiKeyMethod;
      if (this.useApiKeyAuth && methodId && offersAuth(agent, methodId)) {
        try {
          await this.request(agent, "authenticate", { methodId }, true);
          agent.authenticated = true;
        } catch (error) {
          // 登录不上时照常握手，打开会话时会再按未登录处理
          this.log(`[hive] ${this.options.label} API key 登录失败：${(error as Error).message}`);
        }
      }
      agent.initialized = true;
    })();
    return agent.ready.then(() => agent);
  }

  private request(
    agent: AgentProcess,
    method: string,
    params: unknown,
    withTimeout: boolean,
  ): Promise<any> {
    if (agent.dead) return Promise.reject(new Error(`${this.options.label} 未运行。`));
    const id = agent.nextId++;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { method, resolve, reject };
      if (withTimeout) {
        pending.timer = setTimeout(() => {
          agent.pending.delete(id);
          reject(new RequestTimeoutError(`${this.options.label} ${method}`, this.requestTimeoutMs));
        }, this.requestTimeoutMs);
      }
      agent.pending.set(id, pending);
      agent.transport.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private notify(agent: AgentProcess, method: string, params: unknown) {
    agent.transport.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private respond(agent: AgentProcess, id: unknown, result: unknown) {
    agent.transport.write(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private respondError(agent: AgentProcess, id: unknown, code: number, message: string) {
    agent.transport.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  private handleLine(agent: AgentProcess, line: string) {
    if (agent.dead) return;
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
      this.handleAgentRequest(agent, message.id, message.method, message.params);
      return;
    }
    if (hasId) {
      const pending = agent.pending.get(message.id);
      if (!pending) return;
      agent.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) {
        const detail = message.error.data?.message ?? message.error.data?.details;
        pending.reject(
          new AcpRpcError(
            `${this.options.label} ${pending.method}`,
            typeof message.error.code === "number" ? message.error.code : undefined,
            `${String(message.error.message ?? "未知错误")}${typeof detail === "string" && detail ? `：${detail}` : ""}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method === "session/update") this.handleUpdate(message.params);
  }

  private handleAgentRequest(agent: AgentProcess, id: unknown, method: string, params: any) {
    if (method !== "session/request_permission") {
      // 未声明 fs / terminal 能力，其余客户端方法一律不支持
      this.respondError(agent, id, -32601, `SuperHive 不支持的请求：${method}`);
      return;
    }
    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "";
    // 权限请求总是同步答复；回合取消后到达的请求按规范答复 cancelled
    const turn = this.active;
    if (turn?.cancelled && turn.sessionId === sessionId) {
      this.respond(agent, id, { outcome: { outcome: "cancelled" } });
      return;
    }
    const toolCall: AcpToolCall = params?.toolCall ?? {};
    const decision = this.options.isHiveTool?.(toolCall)
      ? "allow"
      : decideAcpPermission(this.options.access ?? "read-only", this.options.cwd, toolCall);
    const option = pickPermissionOption(
      Array.isArray(params?.options) ? params.options : [],
      decision,
    );
    // 工作区档超出范围（改工作区外的文件）：不直接拒绝，交给人批；只读档照旧拒绝，完全权限档本来就放行
    const ask =
      decision === "reject" && this.options.access === "workspace" && turn && !turn.settled
        ? turn.requestApproval
        : undefined;
    if (ask) {
      const options: PermissionOption[] = Array.isArray(params?.options) ? params.options : [];
      void ask({
        tool: toolCall.kind ?? "tool",
        summary: truncate(toolCall.title ?? toolCall.kind ?? "未知操作", 300),
        ...(toolCallPaths(toolCall).length
          ? { detail: `涉及：${toolCallPaths(toolCall).slice(0, 5).join("、")}` }
          : {}),
      }).then(
        (allow) => {
          const picked = pickPermissionOption(options, allow ? "allow" : "reject");
          this.respond(
            agent,
            id,
            picked
              ? { outcome: { outcome: "selected", optionId: picked.optionId } }
              : { outcome: { outcome: "cancelled" } },
          );
        },
        () => this.respond(agent, id, { outcome: { outcome: "cancelled" } }),
      );
      return;
    }
    if (decision === "reject") {
      this.log(
        `[hive] ${this.options.label} 请求的操作超出 --access ${this.options.access ?? "read-only"}，已拒绝：${truncate(toolCall.title ?? toolCall.kind ?? "unknown", 120)}`,
      );
    }
    if (!option) {
      this.respond(agent, id, { outcome: { outcome: "cancelled" } });
      return;
    }
    this.respond(agent, id, { outcome: { outcome: "selected", optionId: option.optionId } });
  }

  private handleUpdate(params: any) {
    const turn = this.active;
    // 只处理当前回合的更新；session/load 回放的历史在回合开始前到达，会被忽略
    if (!turn || turn.settled || !turn.sessionId || params?.sessionId !== turn.sessionId) return;
    const update = params.update;
    switch (update?.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content?.type === "text" && typeof update.content.text === "string") {
          this.endThinking(turn);
          turn.segments[turn.segments.length - 1] += update.content.text;
        }
        return;
      case "agent_thought_chunk":
        turn.thinkingStep ??= `thinking:${turn.traceSteps.size}:${Date.now()}`;
        turn.thinking.start(turn.thinkingStep);
        if (update.content?.type === "text" && typeof update.content.text === "string") {
          turn.thinking.append(turn.thinkingStep, update.content.text);
        }
        if (!turn.thinkingReported) {
          turn.thinkingReported = true;
          this.reportProgress(turn, "思考中");
        }
        return;
      case "tool_call": {
        this.endThinking(turn);
        // 工具调用前说的那段话是中途的话，放进执行过程
        const said = turn.segments.at(-1)?.trim();
        if (said) {
          const at = new Date().toISOString();
          this.traceStep(turn, {
            id: `text:${turn.segments.length}`,
            kind: "text",
            text: said,
            startedAt: at,
            endedAt: at,
          });
        }
        if (turn.segments.at(-1)?.trim()) turn.segments.push("");
        const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
        if (typeof update.title === "string") turn.toolTitles.set(id, update.title);
        if (id && turn.traceSteps.size < 1024) {
          const step: TraceStep = {
            id,
            kind: "tool",
            tool: acpToolCategories[update.kind] ?? "other",
            ...(typeof update.kind === "string" ? { name: update.kind } : {}),
            summary: typeof update.title === "string" ? update.title : "",
            status: update.status === "failed" ? "error" : "running",
            startedAt: new Date().toISOString(),
          };
          turn.traceSteps.set(id, step);
          this.traceStep(turn, step);
        }
        this.reportProgress(turn, progressForToolCall(update));
        return;
      }
      case "tool_call_update": {
        // opencode 先以工具名创建调用，执行时才更新为具体命令/路径；标题变化时再上报一次
        const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
        const started = turn.traceSteps.get(id);
        if (started) {
          const finished = update.status === "completed" || update.status === "failed";
          const next: TraceStep = {
            ...started,
            ...(typeof update.title === "string" && update.title ? { summary: update.title } : {}),
            ...(finished
              ? {
                  status: update.status === "failed" ? "error" : "ok",
                  endedAt: new Date().toISOString(),
                }
              : {}),
          };
          if (finished) turn.traceSteps.delete(id);
          else turn.traceSteps.set(id, next);
          if (finished || next.summary !== started.summary) this.traceStep(turn, next);
        }
        if (
          typeof update.title !== "string" ||
          !update.title ||
          turn.toolTitles.get(id) === update.title
        ) {
          return;
        }
        turn.toolTitles.set(id, update.title);
        if (update.status === "in_progress") this.reportProgress(turn, progressForToolCall(update));
        return;
      }
      default:
        return;
    }
  }

  private traceStep(turn: ActiveTurn, step: TraceStep) {
    try {
      turn.onTrace?.(step);
    } catch {
      // 进度回调异常不影响回合
    }
  }

  private endThinking(turn: ActiveTurn) {
    if (!turn.thinkingStep) return;
    turn.thinking.end(turn.thinkingStep);
    turn.thinkingStep = undefined;
  }

  private reportProgress(turn: ActiveTurn, progress: string | undefined) {
    if (!progress || !turn.onProgress) return;
    try {
      turn.onProgress(progress);
    } catch {
      // 进度回调异常不影响回合
    }
  }

  private handleExit(agent: AgentProcess, exit: StdioExit) {
    // close() 或握手失败时已经收尾过
    if (agent.dead) return;
    let error: Error;
    if ((exit.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      error = Object.assign(
        new Error(
          `找不到 ${this.options.label} 命令 “${this.options.command}”。请先安装 CLI 并完成登录或模型配置。`,
        ),
        { code: "ENOENT" },
      );
    } else {
      const detail = exit.error
        ? exit.error.message
        : `code=${exit.code ?? "null"}${exit.signal ? `, signal=${exit.signal}` : ""}`;
      const stderr = exit.stderr.trim() ? `\n${exit.stderr.trim().slice(-1_000)}` : "";
      error = new Error(`${this.options.label} 意外退出（${detail}）。${stderr}`);
    }
    this.teardown(agent, error);
  }

  /** 进程失效：拒绝所有挂起请求和进行中的回合，下次 reply 会重新启动并恢复会话 */
  private teardown(agent: AgentProcess, error: Error) {
    agent.dead = true;
    if (this.agent === agent) this.agent = undefined;
    for (const pending of agent.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    agent.pending.clear();
    const turn = this.active;
    if (turn && turn.process === agent) {
      this.finishTurn(turn, turn.cancelled ? new AgentCancelledError() : error);
    }
  }
}
