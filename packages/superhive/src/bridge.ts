import { bridgeText, bridgeTextZh, said, type BridgeText } from "./bridge-text.js";
import { createHash, randomUUID } from "node:crypto";
import {
  isMentioned,
  type AgentUsage,
  type ChatMessage,
  type Invocation,
  type InvocationReport,
  type RoomSummary,
} from "./hive-protocol.js";
import {
  AgentExecutionUncertainError,
  AgentNonRetryableError,
  AgentSessionInvalidError,
  AgentUpstreamError,
  UPSTREAM_FAILURE_PREFIX,
  isCancelled,
  type AgentAccessMode,
  type AgentReply,
  type ApprovalRequest,
  type AgentResponder,
} from "./responder.js";
import { resolveReplyText } from "./silent-reply.js";
import {
  buildDeveloperInstructions,
  buildMentionPrompt,
  buildSteerPrompt,
  snapshotMembers,
  snapshotWhiteboard,
} from "./prompt-builder.js";
import {
  RoomClient,
  RoomClientError,
  type RoomClientHandlers,
  type Snapshot,
} from "./room-client.js";
import { StateStore, type AgentState } from "./state-store.js";
import { isMutatingStep, sanitizeTraceStep } from "./trace.js";
import { readAgentSettings } from "./mcp-servers.js";
import type { TraceStep } from "./hive-protocol.js";
import { AttachmentCache } from "./attachment-cache.js";
import {
  AttachmentPublisher,
  describeFailures,
  parseAttachmentDirective,
} from "./attachment-publisher.js";
import type { AttachmentPaths } from "./prompt-builder.js";
import { diffPromptContext, type PromptContextSnapshot } from "./prompt-context.js";

type PreparedPrompt = {
  text: string;
  full: boolean;
  threadId?: string;
  whiteboardSnapshot?: PromptContextSnapshot;
  membersSnapshot?: PromptContextSnapshot;
};

export function shouldProcessMention(input: {
  message: ChatMessage;
  username: string;
  ownParticipantId: string;
  processedMessageIds: string[];
  /**
   * 服务端已为本 Agent 建立了这条消息的调用（例如人回答了它的提问、没有再 @ 它）：
   * 服务端是派发的权威，正文里没有 @ 也要处理。
   */
  invited?: boolean;
}): boolean {
  return (
    !input.message.deletedAt &&
    // 自己发的不处理；例外是 hive_room_post 从别的房间转来、由服务端派给自己的活
    (input.message.senderId !== input.ownParticipantId ||
      (input.invited === true && input.message.text?.key === "roomPost.forwarded")) &&
    (input.invited === true || isMentioned(input.message.content, input.username)) &&
    !input.processedMessageIds.includes(input.message.id)
  );
}

export function hasAgentMessage(messages: ChatMessage[], participantId: string): boolean {
  return messages.some((message) => message.senderId === participantId);
}

/**
 * 回复要挂在哪条触发消息下：取传递深度最大的一条（同深度取最新），
 * 这样合批后仍沿用最严格的 hop/trace 防循环链，而不会因为混入人类消息被"重置"。
 */
export function pickReplyParent(triggers: ChatMessage[]): ChatMessage {
  return triggers.reduce((best, message) =>
    message.hopCount > best.hopCount ||
    (message.hopCount === best.hopCount && message.seq > best.seq)
      ? message
      : best,
  );
}

export type BridgeTuning = {
  /** 第一条 @ 到达后等待多久再开工，以便把一阵连发合成一轮（参考 relay 的 500ms 合并窗口） */
  batchWindowMs?: number;
  /** 一轮最多合并多少条触发消息（参考 agent-bridge CodexRoomInbox） */
  maxBatchSize?: number;
  /** 运行中多久没有新进度时也回报一次心跳，避免被服务端判为结果未知 */
  heartbeatMs?: number;
  /** 进度回报的最小间隔 */
  progressThrottleMs?: number;
  /** 执行过程攒批上报的间隔 */
  traceFlushMs?: number;
  /** 上游模型服务出错、这一轮又没改过东西时，自动接着继续前的等待时间（次数即长度） */
  upstreamRetryDelaysMs?: number[];
  /** 执行中的权限申请等人批多久，过时按拒绝（略长于服务端的时限，以服务端为准） */
  approvalTimeoutMs?: number;
  /** 多久未收到 Runtime 新进度时提示待核实；只告警，不自动取消或重试 */
  progressStaleMs?: number;
  /** 隔多少轮或多久重新发送一次完整上下文 */
  fullPromptEveryTurns?: number;
  fullPromptEveryMs?: number;
  /**
   * Agent 已经干完活、正要把结果交回时连不上 Server（例如 Server 正在换代重启），
   * 最多等这么久并反复重试，而不是把整轮当失败重跑一遍
   */
  offlineRetryMs?: number;
  offlineRetryIntervalMs?: number;
};

/** 连不上 Server 一类的错误：可以等 Server 回来再试，不代表这一轮做错了 */
export function isServerUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TypeError" || error.name === "AbortError" || error.name === "TimeoutError")
    return true;
  return /ECONNREFUSED|ECONNRESET|fetch failed|socket hang up|聊天室连接|未在 15 秒内确认|\(5\d\d\)/.test(
    error.message,
  );
}

type ActiveBatch = {
  executionId: string;
  messages: ChatMessage[];
  controller: AbortController;
  cancelled: Set<string>;
  /** Provider 回合仍在进行、可以吸收 steer；回合结束后新消息改为排队 */
  accepting: boolean;
  workspace: string | undefined;
  /** 这一轮做过可能有副作用的操作（改文件、跑非只读命令、发消息……）：中断后不自动继续 */
  mutated?: boolean;
  /** 这一轮调用过任何工具（只读的也算）：会话失效时不自动重跑 */
  toolUsed?: boolean;
  /** 本轮用量：Provider 交出的原始观测、补全后的结果，以及是否已经随某次上报发出 */
  turn?: {
    startedAt: number;
    session: "new" | "resumed";
    observed?: AgentUsage;
    usage?: AgentUsage;
    reported?: boolean;
  };
};

const MAX_ATTEMPTS = 3;
/** 这些 Provider 续接会话时不会换上新的系统 / 开发者规则（ACP 等由 refreshInstructions 重新注入） */
const RESUMED_SYSTEM_PROMPT_PROVIDERS = new Set(["claude", "codex"]);

export class AgentBridge {
  private state!: AgentState;
  private stateExisted = false;
  private ownParticipantId = "";
  private instructions = "";
  private serverRules = "";
  private readonly defaultCwd: string | undefined;
  private readonly pending: ChatMessage[] = [];
  private active: ActiveBatch | undefined;
  private draining: Promise<void> | undefined;
  private batchTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly steering = new Set<string>();
  // 排队或处理期间被发送者撤回的 @：处理前跳过，处理中则不再代发回复
  private readonly recalled = new Set<string>();
  // 人在 UI 点了"停止"但消息尚未到达本地队列（例如断线期间）的提及
  private readonly cancelledEarly = new Set<string>();
  private readonly attempts = new Map<string, number>();
  /** 人要求「停下当前，改做这条」的消息：排在队首、单独成一轮 */
  private readonly soloNext = new Set<string>();
  /** 服务端标明是当作主 Agent 派来的消息（没有 @ 任何人）：提示词据此说明由它接话、调度 */
  private readonly leadMessages = new Set<string>();
  /** 上游出错后已自动继续的次数 */
  private readonly upstreamRetries = new Map<string, number>();
  /** 这条消息下一轮用的模型：人点了「换个模型重试」，只对这一次生效 */
  private readonly modelOverrides = new Map<string, string>();
  /** 已经因为会话失效自动开新会话重跑过一次的消息：再失败就交给人 */
  private readonly sessionRetried = new Set<string>();
  /** 上游出错后正在等待自动继续的消息（及其计时器） */
  private readonly waitingResume = new Map<string, NodeJS.Timeout>();
  /** 上游出错中断的原因：下一轮（自动继续或人点「继续」）开头提示 Agent 从断点接着做 */
  private readonly resumeNotes = new Map<string, string>();
  // 同一组触发消息在本地重试时复用 executionId，保证回复的幂等键不变
  private readonly executionIds = new Map<string, string>();
  private readonly room: RoomClient;
  private readonly tuning: Required<BridgeTuning>;
  private readonly attachments: AttachmentCache | undefined;
  private publisher: AttachmentPublisher | undefined;

  constructor(
    private readonly options: {
      serverUrl: string;
      roomId: string;
      username: string;
      persona: string;
      provider: string;
      token: string;
      access?: AgentAccessMode;
      /** 附件缓存目录；只读档不准备本地路径（它没有读文件工具），只能经 hive_attachment_read 读取 */
      attachmentCacheDir?: string;
      /** Agent 工作目录：回复里声明的附件只允许来自这里 */
      cwd?: string;
      /** 房间工作区没有采用时的原因，写进规则 */
      workspaceNote?: string;
      onRoomsChanged?: (room: RoomSummary) => void;
      onArchived?: () => void;
      onShutdown?: () => void;
      tuning?: BridgeTuning;
      /** 本机 Hive Server 写的 Agent 设置文件：模型每一轮从这里读 */
      settingsFile?: string;
      taskWorkspace?: {
        resolve: (messageId: string) => Promise<string | undefined>;
        resolveMany?: (messageIds: string[]) => Promise<Map<string, string | undefined>>;
        responder: (cwd: string) => AgentResponder;
      };
    },
    private readonly store: StateStore,
    private responder: AgentResponder,
    private readonly log: (message: string) => void = console.log,
    createRoom: (
      options: ConstructorParameters<typeof RoomClient>[0],
      handlers: RoomClientHandlers,
    ) => RoomClient = (roomOptions, handlers) => new RoomClient(roomOptions, handlers),
  ) {
    this.defaultCwd = options.cwd;
    this.tuning = {
      batchWindowMs: 400,
      maxBatchSize: 10,
      heartbeatMs: 60_000,
      progressThrottleMs: 3_000,
      traceFlushMs: 300,
      upstreamRetryDelaysMs: [60_000, 180_000],
      approvalTimeoutMs: 10 * 60_000 + 30_000,
      progressStaleMs: 120_000,
      fullPromptEveryTurns: 8,
      fullPromptEveryMs: 30 * 60_000,
      offlineRetryMs: 5 * 60_000,
      offlineRetryIntervalMs: 2_000,
      ...options.tuning,
    };
    this.attachments =
      options.attachmentCacheDir && options.access && options.access !== "read-only"
        ? new AttachmentCache({
            serverUrl: options.serverUrl,
            token: options.token,
            dir: options.attachmentCacheDir,
          })
        : undefined;
    this.publisher = options.cwd
      ? new AttachmentPublisher({
          serverUrl: options.serverUrl,
          roomId: options.roomId,
          token: options.token,
          cwd: options.cwd,
          access: options.access ?? "read-only",
        })
      : undefined;
    this.room = createRoom(
      {
        serverUrl: this.options.serverUrl,
        roomId: this.options.roomId,
        username: this.options.username,
        token: this.options.token,
        persona: this.options.persona,
        provider: this.options.provider,
      },
      {
        onSnapshot: (snapshot) => this.onSnapshot(snapshot),
        onMention: (message, _latestSeq, retry, steer, first, lead, model) => {
          if (lead) this.leadMessages.add(message.id);
          else this.leadMessages.delete(message.id);
          // 人点「换个模型重试」：只对这一次生效
          if (model) this.modelOverrides.set(message.id, model);
          else if (retry) this.modelOverrides.delete(message.id);
          this.enqueue(message, {
            retry,
            invited: true,
            ...(steer ? { steer } : {}),
            ...(first ? { first } : {}),
          });
        },
        onCancel: (messageId) => this.cancel(messageId),
        onApprovalDecision: (requestId, allow, reason) =>
          this.approvals.get(requestId)?.(allow, reason),
        onMessageDeleted: (message) => this.onRecalled(message.id),
        ...(this.options.onRoomsChanged ? { onRoomsChanged: this.options.onRoomsChanged } : {}),
        ...(this.options.onShutdown ? { onShutdown: this.options.onShutdown } : {}),
        onError: (error) => {
          this.log(`[hive] ${error.message}`);
          if (error instanceof RoomClientError && error.code === "ROOM_ARCHIVED") {
            this.options.onArchived?.();
          }
          // 凭限时邀请带入的 Agent：访客到期或被房主移除后不再重连，直接离开这个房间
          if (
            error instanceof RoomClientError &&
            (error.code === "SESSION_EXPIRED" || error.code === "SESSION_REVOKED")
          ) {
            this.log("[hive] 访问期限已到或已被房主移除，离开这个房间。");
            this.options.onArchived?.();
          }
        },
      },
    );
  }

  async start(): Promise<void> {
    const existing = await this.store.load();
    this.stateExisted = Boolean(existing);
    this.state =
      existing ??
      ({
        serverUrl: this.options.serverUrl,
        roomId: this.options.roomId,
        username: this.options.username,
        lastProcessedSeq: 0,
        processedMessageIds: [],
      } satisfies AgentState);
    const serverRules = await this.room.fetchInstructions();
    this.serverRules = serverRules;
    this.instructions = buildDeveloperInstructions({
      agentName: this.options.username,
      persona: this.options.persona,
      serverRules,
      ...(this.options.access ? { access: this.options.access } : {}),
      ...(this.options.cwd
        ? {
            workspace: {
              cwd: this.options.cwd,
              ...(this.options.workspaceNote ? { note: this.options.workspaceNote } : {}),
            },
          }
        : {}),
    });
    // 换了工作目录：旧会话（Codex 线程、Claude 续接）会沿用旧目录，丢掉它从新会话开始；消息游标保留
    if (
      !this.options.taskWorkspace &&
      this.options.cwd &&
      this.state.workspace !== this.options.cwd
    ) {
      if (this.state.threadId && this.state.workspace) {
        this.log(`[hive] 房间工作目录已改为 ${this.options.cwd}，开始新的会话`);
        delete this.state.threadId;
      }
      this.state.workspace = this.options.cwd;
    }
    await this.recoverInterruptedExecution();
    this.reportSession();
    this.room.start();
    this.log(
      `[hive] ${this.options.username} 正在连接 ${this.options.serverUrl}/${this.options.roomId}`,
    );
  }

  /** 告诉服务端这个房间当前的 Provider 会话，人可以在终端里接着它 */
  private reportSession(): void {
    const cwd = this.state?.workspace ?? this.options.cwd;
    if (this.state?.threadId && cwd) {
      this.room.reportSession(this.state.threadId, cwd);
    }
  }

  /** 没有正在执行、排队或待恢复的回合时返回；切换房间工作区前用它等这一轮做完 */
  async whenIdle(pollMs = 500): Promise<void> {
    while (!this.stopped && (this.active || this.pending.length > 0 || this.state?.inflight)) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.batchTimer) clearTimeout(this.batchTimer);
    for (const timer of new Set(this.waitingResume.values())) clearTimeout(timer);
    this.waitingResume.clear();
    // 停止进程时中断正在进行的回合；执行意图会在中断回报后清除
    this.active?.controller.abort();
    await this.draining?.catch(() => undefined);
    this.room.stop();
    await this.responder.close?.();
  }

  /**
   * 上次进程在执行途中退出（崩溃、断电、kill -9）：结果未知，不自动重跑，
   * 只把这些提及回报为失败并标记已处理，由人在 UI 中决定是否重试。
   */
  private async recoverInterruptedExecution(): Promise<void> {
    const inflight = this.state.inflight;
    if (!inflight) return;
    this.log(
      `[hive] 检测到上次执行中断（${inflight.messageIds.length} 条提及，开始于 ${inflight.startedAt}），结果未知，不会自动重跑。`,
    );
    for (const messageId of inflight.messageIds) {
      this.room.report({
        messageId,
        status: "uncertain",
        ...said(bridgeText("bridge.crashedMidTurn")),
      });
      this.rememberProcessed(messageId);
    }
    delete this.state.inflight;
    await this.store.save(this.state);
  }

  private async onSnapshot(snapshot: Snapshot): Promise<void> {
    this.ownParticipantId = snapshot.self.id;
    this.log(`[hive] 已加入 #${this.options.roomId}，公共消息最新 seq=${snapshot.latestSeq}`);
    if (!this.stateExisted) {
      // 首次加入不回放历史聊天，但服务端仍为本 Agent 挂着的 queued 调用要接着做，
      // 否则这些 @ 永远没人处理，最后被扫成"结果未知"
      const queued = new Set(
        (snapshot.invocations ?? [])
          .filter(
            (invocation) =>
              invocation.agentId === this.ownParticipantId && invocation.status === "queued",
          )
          .map((invocation) => invocation.messageId),
      );
      this.state.lastProcessedSeq = snapshot.latestSeq;
      this.stateExisted = true;
      await this.store.save(this.state);
      for (const message of snapshot.messages) {
        if (queued.delete(message.id)) this.enqueue(message, { invited: true });
      }
      // 快照只带最近的消息；更早的提及拿不到原文，如实报告并交给人决定是否重试
      for (const messageId of queued) {
        this.room.report({
          messageId,
          status: "failed",
          ...said(bridgeText("bridge.beyondCatchUp")),
        });
      }
      return;
    }
    const known = new Map<string, Invocation>();
    for (const invocation of snapshot.invocations ?? []) {
      if (invocation.agentId === this.ownParticipantId) known.set(invocation.messageId, invocation);
    }
    const missed = await this.room.fetchMessages(this.state.lastProcessedSeq);
    for (const message of missed.messages) {
      const invocation = known.get(message.id);
      if (!this.isEligible(message, Boolean(invocation))) continue;
      // 服务端是调用状态的权威：被拦下、已停止或已结束的提及不再补做
      if (snapshot.invocations && invocation && invocation.status !== "queued") {
        if (
          (invocation.status === "running" || invocation.status === "timed_out") &&
          !this.isLocal(message.id)
        ) {
          this.room.report({
            messageId: message.id,
            status: "uncertain",
            ...said(bridgeText("bridge.reconnectedGone")),
          });
          this.rememberProcessed(message.id);
        }
        continue;
      }
      this.enqueue(message, { invited: Boolean(invocation) });
    }
    await this.store.save(this.state);
  }

  private isEligible(message: ChatMessage, invited = false): boolean {
    return shouldProcessMention({
      message,
      username: this.options.username,
      ownParticipantId: this.ownParticipantId,
      processedMessageIds: this.state.processedMessageIds,
      invited,
    });
  }

  private isLocal(messageId: string): boolean {
    return (
      this.waitingResume.has(messageId) ||
      this.steering.has(messageId) ||
      this.pending.some((message) => message.id === messageId) ||
      Boolean(this.active?.messages.some((message) => message.id === messageId))
    );
  }

  private enqueue(
    message: ChatMessage,
    options: { retry?: boolean; invited?: boolean; steer?: boolean; first?: boolean } = {},
  ): void {
    if (this.stopped) return;
    // 停下当前，改做这条：排到队首，下一轮只做它（不和别的排队消息合在一起）
    if (options.first) {
      this.soloNext.add(message.id);
      const index = this.pending.findIndex((item) => item.id === message.id);
      if (index > 0) this.pending.unshift(...this.pending.splice(index, 1));
      if (index >= 0) return;
    }
    // 人要求引导：已经在排队的从队里拿出来用来引导当前任务；不能插就留在队里并说明原因
    if (options.steer && this.pending.some((item) => item.id === message.id)) {
      if (this.canSteer()) {
        this.pending.splice(
          this.pending.findIndex((item) => item.id === message.id),
          1,
        );
        void this.steerIntoActive(this.active!, message);
      } else {
        this.reportNotSteered(message);
      }
      return;
    }
    if (options.retry) {
      // 人显式重试：忽略本地"已处理/已停止"记录，重新开始计数和幂等键
      this.state.processedMessageIds = this.state.processedMessageIds.filter(
        (id) => id !== message.id,
      );
      this.cancelledEarly.delete(message.id);
      this.attempts.delete(message.id);
      this.sessionRetried.delete(message.id);
      this.executionIds.delete(message.id);
    }
    if (this.isLocal(message.id) || !this.isEligible(message, options.invited)) return;
    if (this.cancelledEarly.delete(message.id)) {
      this.rememberProcessed(message.id);
      void this.store
        .save(this.state)
        .then(() => {
          this.room.report({
            messageId: message.id,
            status: "cancelled",
            ...said(bridgeText("bridge.cancelledBeforeRun")),
          });
        })
        .catch(() => this.room.report({ messageId: message.id, status: "uncertain" }));
      return;
    }
    this.room.report({ messageId: message.id, status: "received" });
    // 默认排队；只有人明确要求（引导当前任务、发送并引导、Agent 开了自动引导）才插进正在执行的这一轮
    if (options.steer) {
      if (this.canSteer()) {
        void this.steerIntoActive(this.active!, message);
        return;
      }
      this.reportNotSteered(message);
    }
    if (this.soloNext.has(message.id)) this.pending.unshift(message);
    else this.pending.push(message);
    this.scheduleDrain(this.tuning.batchWindowMs);
  }

  /** 有正在执行、还能吸收新消息的一轮，而且这个运行时支持引导 */
  private canSteer(): boolean {
    return Boolean(
      this.active?.accepting && this.responder.steer && !this.active.controller.signal.aborted,
    );
  }

  private async taskWorkspaces(messages: ChatMessage[]): Promise<Map<string, string | undefined>> {
    const runtime = this.options.taskWorkspace;
    if (!runtime) return new Map(messages.map((message) => [message.id, undefined]));
    const ids = messages.map((message) => message.id);
    const selections = runtime.resolveMany
      ? await runtime.resolveMany(ids)
      : new Map(await Promise.all(ids.map(async (id) => [id, await runtime.resolve(id)] as const)));
    if (ids.some((id) => !selections.has(id)))
      throw new AgentNonRetryableError("Incomplete managed task workspace selection");
    return selections;
  }

  private async selectTaskWorkspace(
    messageId: string,
    prepared?: { path: string | undefined },
  ): Promise<boolean> {
    const runtime = this.options.taskWorkspace;
    if (!runtime || !this.defaultCwd) return false;
    const selected =
      (prepared ? prepared.path : await runtime.resolve(messageId)) ?? this.defaultCwd;
    const changed = selected !== this.options.cwd;
    if (changed) {
      await this.responder.close?.();
      this.responder = runtime.responder(selected);
      this.options.cwd = selected;
      this.publisher = new AttachmentPublisher({
        serverUrl: this.options.serverUrl,
        roomId: this.options.roomId,
        token: this.options.token,
        cwd: selected,
        access: this.options.access ?? "read-only",
      });
    }
    if (selected !== this.state.workspace) {
      delete this.state.threadId;
      delete this.state.promptContext;
      delete this.state.instructionsDigest;
      delete this.state.lastFullPromptAt;
      this.state.briefTurns = 0;
      this.state.workspace = selected;
    }
    this.instructions = buildDeveloperInstructions({
      agentName: this.options.username,
      persona: this.options.persona,
      serverRules: this.serverRules,
      ...(this.options.access ? { access: this.options.access } : {}),
      workspace: { cwd: selected },
    });
    await this.store.save(this.state);
    return changed;
  }

  private reportNotSteered(message: ChatMessage): void {
    this.room.report({
      messageId: message.id,
      status: "received",
      ...said(
        bridgeText(this.responder.steer ? "bridge.notSteeredQueued" : "bridge.steerUnsupported"),
      ),
    });
  }

  /** 把新消息插进正在运行的这一轮（Codex turn/steer、Claude 流式输入、ACP steering），插不进去就退回排队 */
  private async steerIntoActive(active: ActiveBatch, message: ChatMessage): Promise<void> {
    this.steering.add(message.id);
    let steered = false;
    let queuedDetail: BridgeText | undefined;
    try {
      const selected = this.options.taskWorkspace
        ? await this.options.taskWorkspace.resolve(message.id)
        : undefined;
      if (selected && selected !== active.workspace) {
        queuedDetail = bridgeText("bridge.worktreeSteerQueued", { path: selected });
      } else {
        const runtime = this.responder;
        const prompt = buildSteerPrompt(message, await this.attachmentPaths([message]));
        if (
          this.active === active &&
          active.accepting &&
          !active.controller.signal.aborted &&
          !this.cancelledEarly.has(message.id) &&
          this.responder === runtime
        ) {
          this.room.report({
            messageId: message.id,
            status: "received",
            ...said(bridgeText("bridge.steering")),
          });
          steered = await runtime.steer!(prompt);
        }
      }
    } catch (error) {
      if (
        error instanceof AgentExecutionUncertainError ||
        error instanceof AgentNonRetryableError
      ) {
        this.rememberProcessed(message.id);
        await this.store.save(this.state);
        this.room.report({
          messageId: message.id,
          status: error instanceof AgentNonRetryableError ? "failed" : "uncertain",
          ...(error instanceof AgentNonRetryableError
            ? { detail: error.message }
            : said(bridgeText("bridge.steerUnconfirmed"))),
        });
        return;
      }
      steered = false;
    } finally {
      this.steering.delete(message.id);
    }
    if (this.cancelledEarly.delete(message.id)) {
      if (steered && this.active === active && active.accepting) {
        active.messages.push(message);
        active.cancelled.add(message.id);
      } else if (!steered) {
        this.rememberProcessed(message.id);
        await this.store.save(this.state);
        this.room.report({
          messageId: message.id,
          status: "cancelled",
          ...said(bridgeText("bridge.steerRemoved")),
        });
      } else {
        this.room.report({
          messageId: message.id,
          status: "uncertain",
          ...said(bridgeText("bridge.steerCancelRace")),
        });
      }
      return;
    }
    // A confirmed steer that races completion may already have run; never queue it twice.
    if (steered && (this.active !== active || !active.accepting)) {
      this.rememberProcessed(message.id);
      await this.store.save(this.state);
      this.room.report({
        messageId: message.id,
        status: "uncertain",
        ...said(bridgeText("bridge.steerEndRace")),
      });
      return;
    }
    if (steered && this.active === active && active.accepting) {
      active.messages.push(message);
      const host = active.messages[0]!;
      this.log(`[hive] #${message.seq} 已并入正在进行的 #${host.seq}`);
      this.room.report({
        messageId: message.id,
        status: "running",
        ...said(bridgeText("bridge.steered", { seq: host.seq })),
      });
      // 执行过程里标出引导的位置，看得出 Agent 从哪一步开始调整
      const at = new Date().toISOString();
      for (const item of active.messages.filter((entry) => entry.id !== message.id)) {
        this.room.trace(item.id, [
          {
            id: `steer:${message.id}`,
            kind: "text",
            text: `↳ ${message.senderName} 引导：${message.content}`.slice(0, 2000),
            startedAt: at,
            endedAt: at,
          },
        ]);
      }
      return;
    }
    this.room.report({
      messageId: message.id,
      status: "received",
      ...said(queuedDetail ?? bridgeText("bridge.steerLate")),
    });
    this.pending.push(message);
    this.scheduleDrain(this.tuning.batchWindowMs);
  }

  private scheduleDrain(delayMs: number): void {
    if (this.batchTimer || this.stopped) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined;
      void this.drain();
    }, delayMs);
    this.batchTimer.unref?.();
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      while (this.pending.length > 0 && !this.stopped) {
        const first = this.pending[0]!;
        const candidates = this.pending.slice(
          0,
          this.soloNext.has(first.id) ? 1 : this.tuning.maxBatchSize,
        );
        let prepared: { path: string | undefined } | undefined;
        let count = candidates.length;
        if (this.options.taskWorkspace) {
          try {
            const selections = await this.taskWorkspaces(candidates);
            prepared = { path: selections.get(first.id) };
            const directory = prepared.path ?? this.defaultCwd;
            const different = candidates.findIndex(
              (message) => (selections.get(message.id) ?? this.defaultCwd) !== directory,
            );
            if (different >= 0) count = different;
          } catch {
            count = 1;
          }
        }
        if (this.stopped) break;
        if (this.pending[0]?.id !== first.id) continue;
        const batch = candidates
          .slice(0, count)
          .filter((message, index) => this.pending[index]?.id === message.id);
        if (!batch.length) continue;
        this.soloNext.delete(first.id);
        this.pending.splice(0, batch.length);
        await this.runBatch(batch, prepared);
      }
    })().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private onRecalled(messageId: string): void {
    if (this.isLocal(messageId)) this.recalled.add(messageId);
  }

  /** 成员列表的忙闲：正在跑一轮，或有任务在等上游恢复后自动继续 */
  private syncTyping(): void {
    this.room.setTyping(Boolean(this.active) || this.waitingResume.size > 0);
  }

  private cancel(messageId: string): void {
    // 正在等待自动继续：直接取消，不用等计时器
    const waiting = this.waitingResume.get(messageId);
    if (waiting) {
      this.waitingResume.delete(messageId);
      if (![...this.waitingResume.values()].includes(waiting)) clearTimeout(waiting);
      this.resumeNotes.delete(messageId);
      this.rememberProcessed(messageId);
      this.syncTyping();
      this.log(`[hive] 等待自动继续的 ${messageId} 已被停止`);
      void this.store
        .save(this.state)
        .then(() => {
          this.room.report({
            messageId,
            status: "cancelled",
            ...said(bridgeText("bridge.stoppedWhileWaiting")),
          });
        })
        .catch(() =>
          this.room.report({
            messageId,
            status: "uncertain",
            ...said(bridgeText("bridge.cancelNotPersisted")),
          }),
        );
      return;
    }
    const pendingIndex = this.pending.findIndex((message) => message.id === messageId);
    if (pendingIndex >= 0) {
      this.pending.splice(pendingIndex, 1);
      this.log(`[hive] 排队中的提及 ${messageId} 已被停止`);
      this.rememberProcessed(messageId);
      void this.store
        .save(this.state)
        .then(() => {
          this.room.report({
            messageId,
            status: "cancelled",
            ...said(bridgeText("bridge.queuedRemoved")),
          });
        })
        .catch(() =>
          this.room.report({
            messageId,
            status: "uncertain",
            ...said(bridgeText("bridge.cancelNotPersisted")),
          }),
        );
      return;
    }
    const active = this.active;
    if (active?.messages.some((message) => message.id === messageId)) {
      active.cancelled.add(messageId);
      // 合批中只要还有未被停止的消息，就继续这一轮
      if (active.messages.every((message) => active.cancelled.has(message.id))) {
        this.log("[hive] 收到停止请求，正在中断当前回合");
        active.controller.abort();
      }
      return;
    }
    // 这一轮早已结束（比如结果未知后人又点了停止）：这边没有在跑的回合，立即回复，
    // 否则服务端会一直显示「停止中」，要等 10 分钟超时才放开。仍报结果未知：
    // 当初中断时工具子进程是否停下并没有确认，不能借这次停止把它洗成可重试的「已停止」
    if (this.state.processedMessageIds.includes(messageId)) {
      this.log(`[hive] ${messageId} 这一轮已经结束，没有在跑的回合`);
      this.room.report({
        messageId,
        status: "uncertain",
        ...said(bridgeText("bridge.alreadyEnded")),
      });
      return;
    }
    this.cancelledEarly.add(messageId);
  }

  private rememberProcessed(messageId: string): void {
    this.leadMessages.delete(messageId);
    this.modelOverrides.delete(messageId);
    this.sessionRetried.delete(messageId);
    this.state.processedMessageIds = [
      ...this.state.processedMessageIds.filter((id) => id !== messageId),
      messageId,
    ].slice(-1000);
    this.attempts.delete(messageId);
    this.upstreamRetries.delete(messageId);
    this.executionIds.delete(messageId);
  }

  private reportAll(messages: ChatMessage[], report: Omit<InvocationReport, "type" | "messageId">) {
    for (const message of messages) this.room.report({ messageId: message.id, ...report });
  }

  private async runBatch(
    initial: ChatMessage[],
    preparedWorkspace?: { path: string | undefined },
  ): Promise<void> {
    const skipped = initial.filter(
      (message) =>
        this.recalled.has(message.id) || this.state.processedMessageIds.includes(message.id),
    );
    for (const message of skipped) {
      if (this.recalled.delete(message.id)) {
        this.log(`[hive] #${message.seq} 已被发送者撤回，跳过处理`);
        this.rememberProcessed(message.id);
      }
    }
    const messages = initial.filter((message) => !skipped.includes(message));
    if (messages.length === 0) {
      await this.store.save(this.state);
      return;
    }
    const executionId = this.executionIds.get(messages[0]!.id) ?? randomUUID();
    for (const message of messages) this.executionIds.set(message.id, executionId);
    const active: ActiveBatch = {
      executionId,
      messages: [...messages],
      controller: new AbortController(),
      cancelled: new Set(),
      accepting: false,
      workspace: this.options.cwd,
    };
    this.active = active;
    let heartbeat: NodeJS.Timeout | undefined;
    let traceTimer: NodeJS.Timeout | undefined;
    // 回合结束前把攒着的执行过程发出去：Server 在调用结束后就不再收，最后一段思考、最后一步的结果会丢
    let flushPendingTrace: () => void = () => undefined;
    try {
      const context = await this.room.fetchMessages(this.state.lastProcessedSeq);
      // 先落盘执行意图，再调用 Provider：崩溃后据此判定"结果未知"而不是重跑
      this.state.inflight = {
        executionId,
        messageIds: messages.map((message) => message.id),
        startedAt: new Date().toISOString(),
      };
      await this.store.save(this.state);

      // 人点「换个模型重试」选的模型：只对这一次生效，状态里写明用的是哪个
      const picked = messages.map((message) => this.modelOverrides.get(message.id)).find(Boolean);
      const using = picked ? bridgeText("bridge.usingModel", { model: picked }) : undefined;
      this.reportAll(active.messages, {
        status: "running",
        contextSeq: context.latestSeq,
        ...(using ? { ...said(using), progress: bridgeTextZh(using).slice(0, 200) } : {}),
      });
      this.room.setTyping(true);
      // Bridge 存活不等于 Runtime 在推进；心跳不得刷新最后一次真实进度的时间。
      let lastRuntimeProgressAt = Date.now();
      let handoffUnsafe = false;
      let lastProgressReportAt: number | undefined;
      let lastRuntimeReportAt: number | undefined;
      let lastProgress: string | undefined;
      let lastActivityKey: string | undefined;
      let lastActivityReportAt: number | undefined;
      // 执行过程：脱敏后按 id 合并，攒一小会儿再发，避免 Runtime 一条命令连发几十个事件
      const pendingTrace = new Map<string, TraceStep>();
      const flushTrace = () => {
        traceTimer = undefined;
        if (pendingTrace.size === 0) return;
        const steps = [...pendingTrace.values()];
        pendingTrace.clear();
        for (const message of active.messages) {
          if (active.cancelled.has(message.id)) continue;
          for (let index = 0; index < steps.length; index += 50) {
            this.room.trace(message.id, steps.slice(index, index + 50));
          }
        }
      };
      flushPendingTrace = () => {
        if (traceTimer) clearTimeout(traceTimer);
        flushTrace();
      };
      const reportProgress = (progress: string) => {
        lastProgressReportAt = Date.now();
        this.reportAll(active.messages, { status: "running", progress: progress.slice(0, 200) });
      };
      heartbeat = setInterval(() => {
        const now = Date.now();
        if (
          lastProgressReportAt !== undefined &&
          now - lastProgressReportAt < this.tuning.heartbeatMs
        ) {
          return;
        }
        const idleMs = Math.max(0, now - lastRuntimeProgressAt);
        const seconds = Math.floor(idleMs / 1000);
        const elapsed =
          seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`;
        const warning = idleMs >= this.tuning.progressStaleMs ? "，状态待核实" : "";
        reportProgress(
          `仅 Bridge 心跳；${elapsed}未收到 Runtime 新进度${warning}${lastProgress ? `；上次：${lastProgress}` : ""}`,
        );
      }, this.tuning.heartbeatMs);
      heartbeat.unref?.();

      await this.selectTaskWorkspace(messages[0]!.id, preparedWorkspace);
      let handoff: string | undefined;
      let handoffs = 0;
      let reply: AgentReply;
      let prompt: PreparedPrompt;
      let usage: AgentUsage | undefined;
      while (true) {
        const built = await this.buildPrompt(
          this.applyTopicBoundary(context.messages),
          active.messages,
        );
        // 上一轮因上游出错中断：提醒 Agent 接着原会话从断点继续，别把已经做过的再做一遍
        const interrupted = messages
          .map((message) => this.resumeNotes.get(message.id))
          .find((note) => note !== undefined);
        for (const message of messages) this.resumeNotes.delete(message.id);
        // 中途开了新话题、旧会话已丢弃时，就不能说「会话已接上」
        prompt = interrupted
          ? {
              ...built,
              text: `（系统提示）你上一轮处理下面这条消息时，因上游模型服务出错在中途中断：${interrupted}\n${
                this.state.threadId
                  ? "会话已接上。请先根据你已经做过的操作确认进度，从中断处继续把原任务做完；"
                  : "原会话已随新话题丢弃，看不到上一轮的步骤。请先检查工作区和房间里的现状，确认哪些已经做过，再把原任务做完；"
              }不要重复已经完成的、有副作用的操作（改文件、提交、发消息等）。\n\n${built.text}`,
            }
          : built;
        if (handoff)
          prompt = {
            ...prompt,
            text: `（系统提示）上一轮已正常结束；现在已在 ${this.options.cwd} 建立独立的新会话和写权限。不要重放原任务或重复已完成的操作；先核对工作区及上一轮摘要，再继续尚未完成的工作。旧会话没有搬到这里。\n<previous_turn_summary untrusted="true">\n${handoff.slice(-12_000)}\n</previous_turn_summary>\n\n${prompt.text}`,
          };
        this.log(
          `[hive] 正在处理 ${messages.map((message) => `#${message.seq}`).join("、")}（来自 ${[...new Set(messages.map((message) => message.senderName))].join("、")}）`,
        );
        const turn: NonNullable<ActiveBatch["turn"]> = {
          startedAt: Date.now(),
          session: this.state.threadId ? "resumed" : "new",
        };
        active.turn = turn;
        // 这一轮的模型：「换个模型重试」选的优先，其次是网页上设置的；都没有就不传，用启动时的 --model
        const turnModel = picked ?? this.settings().model;
        active.workspace = this.options.cwd;
        active.accepting = true;
        reply = await this.responder.reply({
          onUsage: (usage) => {
            turn.observed = usage;
          },
          instructions: this.instructions,
          prompt: prompt.text,
          refreshInstructions: prompt.full,
          ...(turnModel ? { model: turnModel } : {}),
          signal: active.controller.signal,
          onProgress: (progress) => {
            if (this.active !== active || active.controller.signal.aborted) return;
            lastRuntimeProgressAt = Date.now();
            lastProgress = progress.slice(0, 200);
            if (
              lastRuntimeReportAt !== undefined &&
              lastRuntimeProgressAt - lastRuntimeReportAt < this.tuning.progressThrottleMs
            ) {
              return;
            }
            lastRuntimeReportAt = lastRuntimeProgressAt;
            lastProgressReportAt = Date.now();
            this.reportAll(active.messages, {
              status: "running",
              progress: lastProgress,
              runtimeEvent: { kind: "activity", phase: "working" },
            });
          },
          requestApproval: (request) => this.askApproval(active, request),
          // 第一轮还没结束就能在终端里打开：一拿到会话 ID 就报，不等回合结束
          onSession: (sessionId) => {
            if (this.options.cwd) this.room.reportSession(sessionId, this.options.cwd);
          },
          onTrace: (step) => {
            if (this.active !== active || active.controller.signal.aborted) return;
            if (isMutatingStep(step)) {
              active.mutated = true;
              if (!/(?:^|[._])hive_(?:worktree_create|board_update)$/.test(step.name ?? ""))
                handoffUnsafe = true;
            }
            if (step.kind === "tool") active.toolUsed = true;
            const clean = sanitizeTraceStep(step);
            pendingTrace.set(clean.id, { ...pendingTrace.get(clean.id), ...clean });
            traceTimer ??= setTimeout(flushTrace, this.tuning.traceFlushMs);
          },
          onRuntimeEvent: (event) => {
            if (this.active !== active || active.controller.signal.aborted) return;
            const now = Date.now();
            if (event.kind === "activity" || event.kind === "recovered")
              lastRuntimeProgressAt = now;
            if (event.kind === "activity") {
              const key = `${event.phase}:${event.tool ?? ""}`;
              if (
                key === lastActivityKey &&
                lastActivityReportAt !== undefined &&
                now - lastActivityReportAt < this.tuning.progressThrottleMs
              )
                return;
              lastActivityKey = key;
              lastActivityReportAt = now;
              lastProgress =
                event.phase === "tool_running"
                  ? "Runtime 正在执行工具"
                  : event.phase === "tool_completed"
                    ? "Runtime 工具已返回（不代表任务完成）"
                    : event.phase === "starting"
                      ? "正在启动 Runtime"
                      : event.phase === "working"
                        ? "收到 Runtime 执行事件"
                        : "收到模型响应事件";
            }
            if (event.kind === "provider_error") lastProgress = "API 异常，等待恢复证据";
            if (event.kind === "recovered") lastProgress = "收到模型恢复证据";
            lastProgressReportAt = now;
            this.reportAll(
              active.messages.filter((message) => !active.cancelled.has(message.id)),
              {
                status: "running",
                runtimeEvent: event,
                ...(event.kind !== "capabilities" && lastProgress
                  ? { progress: lastProgress }
                  : {}),
              },
            );
          },
          ...(this.state.threadId ? { threadId: this.state.threadId } : {}),
        });
        active.accepting = false;
        flushPendingTrace();
        if (reply.usage) turn.observed = reply.usage;
        usage = this.settleUsage(active, "completed", reply);
        if (reply.threadId) this.state.threadId = reply.threadId;
        this.reportSession();
        this.notePromptSent(prompt);
        const selections = await this.taskWorkspaces(active.messages);
        const selected = selections.get(messages[0]!.id);
        if (
          this.options.taskWorkspace &&
          active.messages.some(
            (message) =>
              selections.get(message.id) !== undefined &&
              selections.get(message.id) !== (selected ?? this.defaultCwd),
          )
        )
          throw new AgentNonRetryableError(
            "Task workspace bindings changed during the turn; confirm before continuing.",
          );
        const changed = await this.selectTaskWorkspace(messages[0]!.id, { path: selected });
        if (!changed) break;
        if (handoffUnsafe)
          throw new AgentNonRetryableError(
            bridgeTextZh(
              bridgeText("bridge.worktreeCheckBeforeContinue", { path: this.options.cwd! }),
            ),
          );
        const detail = bridgeText("bridge.worktreeHandoff", { path: this.options.cwd! });
        for (const message of active.messages)
          this.room.report({
            messageId: message.id,
            status: "running",
            ...said(detail),
            ...this.usageReport(active),
          });
        if (active.controller.signal.aborted)
          throw new AgentNonRetryableError(
            "Worktree handoff was stopped; no continuation was started.",
          );
        if (++handoffs > 1)
          throw new AgentNonRetryableError(
            "Multiple worktree changes in one task; confirm the selected worktree before continuing.",
          );
        handoff = reply.text;
      }

      const resolved = resolveReplyText(reply.text);
      const directive = parseAttachmentDirective(resolved.silent ? "" : resolved.text);
      let content = directive.text;
      if (!resolved.silent && !content && directive.paths.length === 0) {
        throw new Error("Agent 回复为空。");
      }
      const live = active.messages.filter(
        (message) => !this.recalled.has(message.id) && !active.cancelled.has(message.id),
      );
      // 结果已经出来了：之后与 Server 的往来如果赶上它重启，等它回来再交，不把整轮重跑
      const messagesAfterReply = await this.whenOnline("补拉回复前后的消息", () =>
        this.room.fetchMessages(context.latestSeq),
      );
      // 经 hive_invoke 发出的委派、hive_ask_human 提的问题只是中间动作，服务端代发的回执（子任务、定时任务说明）
      // 也不是这一轮自己发的，都不能当成这一轮的回复，否则最终答复会被吞掉
      const toolMessages = messagesAfterReply.messages.filter(
        (message) =>
          message.senderId === this.ownParticipantId &&
          message.kind !== "delegation" &&
          message.kind !== "question" &&
          message.kind !== "receipt" &&
          message.kind !== "progress",
      );
      // 这一轮用 hive_message_send 发过消息，最终回复仍要照常代发：工具发的往往只是中途的进度（「收到，开始做」），
      // 只有最终输出为 NO_REPLY、和已发的内容相同，或只是一句「已发送」时，才把工具发的那条当作这一轮的回复
      const sentWithHiveTool =
        toolMessages.length > 0 &&
        (resolved.silent ||
          repeatsToolMessage(content, toolMessages) ||
          isSendAcknowledgement(content))
          ? toolMessages.at(-1)
          : undefined;
      let replyMessageId: string | undefined = sentWithHiveTool?.id;
      if (live.length === 0) {
        this.log("[hive] 本轮的触发消息都已被撤回或停止，不再发送回复");
      } else if (!sentWithHiveTool && resolved.silent) {
        this.log(
          `[hive] ${live.map((message) => `#${message.seq}`).join("、")} 无需回复，未发送消息`,
        );
      } else if (!sentWithHiveTool) {
        // 回复里声明的产物由本机 Bridge 上传成附件，随回复一起发出
        let attachmentIds: string[] = [];
        if (directive.paths.length) {
          const publisher = this.publisher;
          const published = publisher
            ? await this.whenOnline("上传附件", () => publisher.publish(directive.paths))
            : {
                attachmentIds: [],
                failures: directive.paths.map((item) => ({
                  path: item,
                  reason: "这个 Agent 没有配置工作目录，不能发布文件",
                })),
              };
          attachmentIds = published.attachmentIds;
          content = `${content}${describeFailures(published.failures)}`.trim();
          for (const failure of published.failures) {
            this.log(`[hive] 附件 ${failure.path} 未发出：${failure.reason}`);
          }
        }
        const sent = await this.whenOnline("发送回复", () =>
          this.room.sendMessage({
            content,
            ...(attachmentIds.length ? { attachmentIds } : {}),
            // 同一次执行（含本地重试）复用幂等键；人重试时换新键，确保会发出新回复
            clientMessageId: `agent-reply-${executionId}`,
            parentMessageId: pickReplyParent(live).id,
          }),
        );
        replyMessageId = sent.id;
      } else {
        this.log("[hive] 最终回复已用 hive_message_send 发出，不再重复代发。");
        if (directive.paths.length) {
          this.log(
            "[hive] 回复里声明的附件只随 Bridge 代发的回复发出，这次已用工具发送，附件未发出",
          );
        }
      }
      for (const message of active.messages) {
        this.recalled.delete(message.id);
        this.rememberProcessed(message.id);
      }
      this.state.lastProcessedSeq = Math.max(
        this.state.lastProcessedSeq,
        context.latestSeq,
        messagesAfterReply.latestSeq,
        ...active.messages.map((message) => message.seq),
      );
      delete this.state.inflight;
      // 先持久化"已处理"，再对外宣告完成：两步之间崩溃时宁可漏报，也不重复执行
      await this.store.save(this.state);
      const stopped = active.messages.filter((message) => active.cancelled.has(message.id));
      for (const [index, message] of stopped.entries()) {
        this.room.report({
          messageId: message.id,
          status: "cancelled",
          ...said(bridgeText("bridge.stoppedNoReply")),
          // 触发消息全停了也照样花了钱：用量记到第一条上
          ...(usage && live.length === 0 && index === 0 ? this.usageReport(active) : {}),
        });
      }
      // 一轮合并处理多条消息时，用量只随第一条上报，避免按消息重复计费
      const [usageCarrier, ...others] = live;
      if (usageCarrier) {
        this.room.report({
          messageId: usageCarrier.id,
          status: "completed",
          ...(replyMessageId ? { replyMessageId } : said(bridgeText("bridge.noReply"))),
          ...this.usageReport(active),
        });
      }
      this.reportAll(others, {
        status: "completed",
        ...(replyMessageId ? { replyMessageId } : said(bridgeText("bridge.noReply"))),
      });
      this.log(
        `[hive] ${replyMessageId ? "已回复" : "已处理"} ${active.messages.map((message) => `#${message.seq}`).join("、")}`,
      );
    } catch (error) {
      flushPendingTrace();
      await this.handleBatchError(active, error);
    } finally {
      active.accepting = false;
      if (heartbeat) clearInterval(heartbeat);
      if (traceTimer) clearTimeout(traceTimer);
      traceTimer = undefined;
      if (this.active === active) this.active = undefined;
      // 等上游恢复后自动继续的任务还算在办：成员列表显示忙，不然对话流里还在「执行中」，列表却是空闲
      this.syncTyping();
    }
  }

  /** 连不上 Server 时等它回来再试；超过 offlineRetryMs 或遇到其它错误照常抛出 */
  private async whenOnline<T>(label: string, action: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.tuning.offlineRetryMs;
    let warned = false;
    for (;;) {
      try {
        return await action();
      } catch (error) {
        if (this.stopped || !isServerUnavailable(error) || Date.now() >= deadline) throw error;
        if (!warned) {
          warned = true;
          this.log(`[hive] ${label}时连不上 Hive Server，等它恢复后重试`);
        }
        await new Promise((resolve) => setTimeout(resolve, this.tuning.offlineRetryIntervalMs));
      }
    }
  }

  /**
   * 补全本轮用量（只做一次）：会话是新是旧、距上次模型请求的间隔、上一轮缓存的有效期、会话费用差额，
   * 并推进下一轮要用的基线。失败、停止、结果未知的回合同样记账。
   */
  private settleUsage(
    active: ActiveBatch,
    outcome: NonNullable<AgentUsage["outcome"]>,
    reply?: AgentReply,
  ): AgentUsage | undefined {
    const turn = active.turn;
    if (!turn?.observed) return undefined;
    // 已补全过（例如成功后发送回复时才出错）：只更新结局，基线不再推进
    if (turn.usage) {
      if (!turn.reported) turn.usage = { ...turn.usage, outcome };
      return turn.usage;
    }
    const raw = turn.observed;
    const now = Date.now();
    // 自报费用是会话累计值：同一会话减去上一轮的累计，换了会话（或累计值变小）就从头算
    let turnCostUsd: number | undefined;
    if (reply?.sessionCostUsd !== undefined && reply.threadId) {
      const previous =
        this.state.sessionCost?.threadId === reply.threadId
          ? this.state.sessionCost.usd
          : turn.session === "new"
            ? 0
            : undefined;
      // 续接的会话没有上一轮的累计（例如刚升级）：本轮费用未知，只记下基线
      if (previous !== undefined) {
        turnCostUsd =
          reply.sessionCostUsd >= previous ? reply.sessionCostUsd - previous : reply.sessionCostUsd;
      }
      this.state.sessionCost = { threadId: reply.threadId, usd: reply.sessionCostUsd };
    }
    // 间隔优先按模型请求算（上轮最后一次请求 → 本轮第一次请求），拿不到再按回合算（上轮结束 → 本轮开始）
    let idle: Pick<AgentUsage, "idleMs" | "idleBasis"> = {};
    if (turn.session === "resumed") {
      const lastRequest = Date.parse(this.state.lastRequestAt ?? "");
      const firstRequest = Date.parse(raw.firstRequestAt ?? "");
      const lastTurnEnded = Date.parse(this.state.lastTurnEndedAt ?? "");
      if (Number.isFinite(lastRequest) && Number.isFinite(firstRequest)) {
        idle = { idleMs: Math.max(0, firstRequest - lastRequest), idleBasis: "request" };
      } else if (Number.isFinite(lastTurnEnded)) {
        idle = { idleMs: Math.max(0, turn.startedAt - lastTurnEnded), idleBasis: "turn" };
      }
    }
    const usage: AgentUsage = {
      ...raw,
      ...(turnCostUsd !== undefined
        ? { reportedCostUsd: Math.round(turnCostUsd * 1e6) / 1e6 }
        : {}),
      session: turn.session,
      ...idle,
      ...(turn.session === "resumed" && this.state.lastCacheTtlMs
        ? { previousCacheTtlMs: this.state.lastCacheTtlMs }
        : {}),
      outcome,
    };
    this.state.lastTurnEndedAt = new Date(now).toISOString();
    if (raw.lastRequestAt) this.state.lastRequestAt = raw.lastRequestAt;
    // 只有 Runtime 区分了 5 分钟 / 1 小时写入，才记下缓存有效期；不区分的（如 Codex）保持未知
    if (raw.cacheWriteTokens > 0) {
      if (raw.cacheWrite1hTokens !== undefined) {
        this.state.lastCacheTtlMs = raw.cacheWrite1hTokens > 0 ? 3_600_000 : 300_000;
      } else delete this.state.lastCacheTtlMs;
    }
    turn.usage = usage;
    return usage;
  }

  /** 随一次上报带上本轮用量；同一轮只带一次，避免按消息重复计费 */
  private usageReport(active: ActiveBatch): { usage?: AgentUsage } {
    const usage = active.turn?.usage;
    if (!usage || active.turn?.reported) return {};
    active.turn!.reported = true;
    return { usage };
  }

  /** 等人批的权限申请：requestId → 收到决定时的回调 */
  private readonly approvals = new Map<string, (allow: boolean, reason?: string) => void>();

  /**
   * Runtime 执行中申请权限：交给服务端转成「允许 / 拒绝」的提问，等人批。
   * 服务端不支持、连不上、超时、这一轮被停止都按拒绝；只读档和完全权限档由各 Runtime 自己决定不走这里。
   */
  private askApproval(active: ActiveBatch, request: ApprovalRequest): Promise<boolean> {
    const trigger = active.messages.find((message) => !active.cancelled.has(message.id));
    if (!trigger || active.controller.signal.aborted) return Promise.resolve(false);
    const requestId = randomUUID();
    const sent = this.room.requestApproval({
      messageId: trigger.id,
      requestId,
      tool: request.tool.slice(0, 64),
      summary: request.summary.replace(/\s+/g, " ").trim().slice(0, 1000) || request.tool,
      ...(request.detail ? { detail: request.detail.slice(0, 4000) } : {}),
    });
    if (!sent) {
      this.log(`[hive] 权限申请没能交给人（服务端不支持或未连接），按拒绝处理：${request.summary}`);
      return Promise.resolve(false);
    }
    this.log(`[hive] 已把权限申请交给人批：${request.summary}`);
    return new Promise<boolean>((resolve) => {
      const finish = (allow: boolean, reason?: string) => {
        if (!this.approvals.delete(requestId)) return;
        clearTimeout(timer);
        active.controller.signal.removeEventListener("abort", onAbort);
        this.log(`[hive] 权限申请${allow ? "已获准" : `被拒绝${reason ? `：${reason}` : ""}`}`);
        resolve(allow);
      };
      const onAbort = () => finish(false, "这一轮已停止");
      const timer = setTimeout(() => finish(false, "等人批超时"), this.tuning.approvalTimeoutMs);
      timer.unref?.();
      active.controller.signal.addEventListener("abort", onAbort, { once: true });
      this.approvals.set(requestId, finish);
    });
  }

  private async handleBatchError(active: ActiveBatch, error: unknown): Promise<void> {
    delete this.state.inflight;
    if (error instanceof AgentUpstreamError && !isCancelled(error, active.controller.signal)) {
      await this.handleUpstreamError(active, error);
      return;
    }
    if (
      error instanceof AgentSessionInvalidError &&
      !isCancelled(error, active.controller.signal)
    ) {
      await this.handleSessionInvalid(active, error);
      return;
    }
    const outcome: NonNullable<AgentUsage["outcome"]> =
      error instanceof AgentExecutionUncertainError
        ? "uncertain"
        : isCancelled(error, active.controller.signal)
          ? "cancelled"
          : "failed";
    this.settleUsage(active, outcome);
    // 用量随第一条消息的上报发出
    const withUsage = (
      messages: ChatMessage[],
      report: Omit<InvocationReport, "type" | "messageId">,
    ) => {
      for (const message of messages) {
        this.room.report({ messageId: message.id, ...report, ...this.usageReport(active) });
      }
    };
    if (error instanceof AgentExecutionUncertainError) {
      // The provider may have completed side effects before its result stream was lost.
      for (const message of active.messages) this.rememberProcessed(message.id);
      await this.store.save(this.state);
      withUsage(active.messages, {
        status: "uncertain",
        // 带上 Runtime 给的具体原因（API 限流、流中断、停止未确认……）
        ...said(bridgeText("bridge.uncertain", { reason: error.message.slice(0, 380) })),
      });
      return;
    }
    if (error instanceof AgentNonRetryableError) {
      for (const message of active.messages) this.rememberProcessed(message.id);
      await this.store.save(this.state);
      withUsage(active.messages, { status: "failed", detail: error.message.slice(0, 500) });
      this.log(`[hive] Codex 调用不可自动重试：${error.message}`);
      return;
    }
    if (isCancelled(error, active.controller.signal)) {
      this.log("[hive] 当前回合已停止");
      for (const message of active.messages) this.rememberProcessed(message.id);
      await this.store.save(this.state);
      withUsage(active.messages, {
        status: "cancelled",
        ...(this.stopped ? said(bridgeText("bridge.offline")) : {}),
      });
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    this.log(`[hive] 处理 @mention 失败：${reason}`);
    const retryable: ChatMessage[] = [];
    const exhausted: ChatMessage[] = [];
    for (const message of active.messages) {
      const attempt = (this.attempts.get(message.id) ?? 0) + 1;
      this.attempts.set(message.id, attempt);
      if (attempt < MAX_ATTEMPTS) retryable.push(message);
      else exhausted.push(message);
    }
    // 本地重试耗尽：作为"死信"交给人处理，不再在重连时自动补做（先落盘再上报）
    for (const message of exhausted) this.rememberProcessed(message.id);
    await this.store.save(this.state);
    for (const message of exhausted) {
      this.log(
        `[hive] #${message.seq} 连续失败 ${MAX_ATTEMPTS} 次，已标记为失败，可在界面中重试。`,
      );
      this.room.report({
        messageId: message.id,
        status: "failed",
        ...said(bridgeText("bridge.failedRepeatedly", { attempts: MAX_ATTEMPTS, reason })),
        ...this.usageReport(active),
      });
    }
    if (retryable.length === 0) return;
    const attempt = Math.max(...retryable.map((message) => this.attempts.get(message.id) ?? 1));
    withUsage(retryable, {
      status: "running",
      progress: `第 ${attempt} 次尝试失败，稍后自动重试`,
    });
    const timer = setTimeout(
      () => {
        if (this.stopped) return;
        this.pending.unshift(...retryable.filter((message) => !this.isLocal(message.id)));
        void this.drain();
      },
      1_000 * 2 ** (attempt - 1),
    );
    timer.unref?.();
  }

  private settings() {
    return readAgentSettings(this.options.settingsFile);
  }

  /**
   * 会话坏了（Codex 解不开旧会话里加密的推理内容、找不到之前的 response、恢复会话的文件坏了……）：
   * 丢掉旧会话，下一轮用完整上下文开新会话。这一轮还没执行任何工具就自动重跑一次；
   * 执行过工具、或已经自动重跑过的交给人，点「重试」时一定是新会话。
   */
  private async handleSessionInvalid(
    active: ActiveBatch,
    error: AgentSessionInvalidError,
  ): Promise<void> {
    this.settleUsage(active, "failed");
    delete this.state.threadId;
    delete this.state.promptContext;
    this.reportSession();
    const live = active.messages.filter((message) => !active.cancelled.has(message.id));
    const executed = error.executed || active.toolUsed === true || active.mutated === true;
    const retried = live.some((message) => this.sessionRetried.has(message.id));
    if (!executed && !retried && live.length > 0) {
      for (const message of live) this.sessionRetried.add(message.id);
      await this.store.save(this.state);
      this.log(`[hive] ${error.message}；这一轮还没执行工具，开新会话重跑`);
      for (const message of live) {
        this.room.report({
          messageId: message.id,
          status: "running",
          ...said(bridgeText("bridge.sessionRetrying", { reason: error.reason.slice(0, 200) })),
          progress: bridgeTextZh(
            bridgeText("bridge.sessionRetrying", { reason: error.reason.slice(0, 120) }),
          ).slice(0, 200),
          ...this.usageReport(active),
        });
      }
      this.pending.unshift(...live);
      void this.drain();
      return;
    }
    for (const message of active.messages) this.rememberProcessed(message.id);
    await this.store.save(this.state);
    const why = bridgeText(executed ? "bridge.sessionExecuted" : "bridge.sessionRetried");
    const detail = said(
      bridgeText("bridge.sessionInvalid", { reason: error.reason.slice(0, 360), why }),
    );
    this.log(`[hive] ${detail.detail}`);
    for (const message of live) {
      this.room.report({
        messageId: message.id,
        status: "failed",
        ...detail,
        ...this.usageReport(active),
      });
    }
  }

  /**
   * 上游模型服务出错（限流、过载、5xx、断流）：进程已正常退出、原因明确，不会有残留执行。
   * 这一轮没做过有副作用的操作就等一会儿接着原会话自动继续（次数与等待时间见 tuning.upstreamRetryDelaysMs）；
   * 做过的、或次数用完，就报失败并写明原因，由人点「继续」（即重试），同样接着原会话从断点往下做。
   */
  private async handleUpstreamError(active: ActiveBatch, error: AgentUpstreamError): Promise<void> {
    this.settleUsage(active, "failed");
    // 接着出错的那个会话继续：它记得这一轮已经做过的步骤
    if (error.threadId) this.state.threadId = error.threadId;
    this.reportSession();
    const live = active.messages.filter((message) => !active.cancelled.has(message.id));
    for (const message of live) this.resumeNotes.set(message.id, error.reason);
    const used = Math.max(0, ...live.map((message) => this.upstreamRetries.get(message.id) ?? 0));
    // 模型本身用不了（不存在、下线）：等多久都不会好，不自动重试，交给人换个模型
    const delay = error.kind === "model" ? undefined : this.tuning.upstreamRetryDelaysMs[used];
    if (!active.mutated && delay !== undefined && live.length > 0) {
      for (const message of live) this.upstreamRetries.set(message.id, used + 1);
      await this.store.save(this.state);
      const wait =
        delay >= 60_000
          ? `${Math.round(delay / 60_000)} 分钟`
          : `${Math.max(1, Math.round(delay / 1000))} 秒`;
      this.log(`[hive] ${error.message}；这一轮没有改动，${wait}后自动继续`);
      for (const message of live) {
        this.room.report({
          messageId: message.id,
          status: "running",
          progress:
            `${UPSTREAM_FAILURE_PREFIX}，${wait}后自动继续（第 ${used + 1}/${this.tuning.upstreamRetryDelaysMs.length} 次）`.slice(
              0,
              200,
            ),
          detail: error.message.slice(0, 500),
          ...this.usageReport(active),
        });
      }
      // 等待中的消息算作本地在办：重连补拉、重复的 @ 都不会再另起一份
      const timer = setTimeout(() => {
        const resume: ChatMessage[] = [];
        for (const message of live) {
          if (this.waitingResume.get(message.id) !== timer) continue;
          this.waitingResume.delete(message.id);
          if (this.stopped || this.state.processedMessageIds.includes(message.id)) continue;
          resume.push(message);
        }
        if (resume.length === 0) {
          this.syncTyping();
          return;
        }
        this.pending.unshift(...resume);
        void this.drain();
      }, delay);
      timer.unref?.();
      for (const message of live) this.waitingResume.set(message.id, timer);
      return;
    }
    for (const message of active.messages) {
      this.rememberProcessed(message.id);
      this.upstreamRetries.delete(message.id);
    }
    await this.store.save(this.state);
    const why = active.mutated
      ? bridgeText("bridge.upstreamMutated")
      : bridgeText("bridge.upstreamExhausted", {
          count: this.tuning.upstreamRetryDelaysMs.length,
        });
    // 模型本身用不了：接着原会话「继续」还是同一个模型，没用，让人换模型
    const detail = said(
      error.kind === "model"
        ? bridgeText("bridge.modelFailed", { reason: error.reason.slice(0, 360) })
        : bridgeText("bridge.upstreamFailed", { reason: error.reason.slice(0, 360), why }),
    );
    this.log(`[hive] ${detail.detail}，等人点「继续」`);
    for (const message of live) {
      this.room.report({
        messageId: message.id,
        status: "failed",
        ...detail,
        ...this.usageReport(active),
      });
    }
  }

  /**
   * 有人开启了新话题（或房主清空了房间）：丢弃 Provider 旧会话，上下文只保留分隔之后的消息。
   * 在每轮开始时检查而不是监听事件：Agent 离线期间发生的分隔，上线后第一轮同样生效。
   */
  private applyTopicBoundary(context: ChatMessage[]): ChatMessage[] {
    const boundary = context.filter((message) => message.kind === "topic").at(-1);
    if (!boundary) return context;
    if (boundary.seq > (this.state.topicSeq ?? 0)) {
      this.state.topicSeq = boundary.seq;
      if (this.state.threadId) {
        this.log(`[hive] #${boundary.seq} 开启了新话题，丢弃之前的会话，从新会话开始`);
        delete this.state.threadId;
      }
    }
    return context.filter((message) => message.seq > boundary.seq);
  }

  /** 决定这一轮发完整上下文还是只发增量，并按需附带白板 */
  private async buildPrompt(
    context: ChatMessage[],
    triggers: ChatMessage[],
  ): Promise<PreparedPrompt> {
    const lastFull = this.state.lastFullPromptAt ? Date.parse(this.state.lastFullPromptAt) : 0;
    const full =
      !this.state.threadId ||
      this.state.instructionsDigest !== this.instructionsDigest() ||
      (this.state.briefTurns ?? 0) >= this.tuning.fullPromptEveryTurns ||
      Date.now() - lastFull >= this.tuning.fullPromptEveryMs;
    const previous =
      this.state.threadId && this.state.promptContext?.threadId === this.state.threadId
        ? this.state.promptContext
        : undefined;
    let whiteboardSnapshot: PromptContextSnapshot | undefined;
    let membersSnapshot: PromptContextSnapshot | undefined;
    // Refresh both cheaply from the room; only semantic differences enter the model prompt.
    // A failed fetch is unknown, not an empty list, and must not overwrite its last good baseline.
    await Promise.all([
      this.room
        .fetchWhiteboard()
        .then((entries) => {
          whiteboardSnapshot = snapshotWhiteboard(entries);
        })
        .catch((error: unknown) => {
          this.log(`[hive] ${error instanceof Error ? error.message : String(error)}`);
        }),
      this.room
        .fetchParticipants()
        .then((members) => {
          membersSnapshot = snapshotMembers(members, this.options.username);
        })
        .catch((error: unknown) => {
          this.log(`[hive] ${error instanceof Error ? error.message : String(error)}`);
        }),
    ]);
    const whiteboardUpdate = whiteboardSnapshot
      ? diffPromptContext(whiteboardSnapshot, previous?.whiteboard, full)
      : undefined;
    const membersUpdate = membersSnapshot
      ? diffPromptContext(membersSnapshot, previous?.members, full)
      : undefined;
    const attachmentPaths = await this.attachmentPaths([...context, ...triggers]);
    // Claude --resume 与 Codex 线程都沿用会话创建时的系统规则：规则更新后在这一轮把完整新规则补发一次
    const rulesUpdated =
      Boolean(this.state.threadId && this.state.instructionsDigest) &&
      this.state.instructionsDigest !== this.instructionsDigest() &&
      RESUMED_SYSTEM_PROMPT_PROVIDERS.has(this.options.provider);
    const prompt = buildMentionPrompt({
      messages: context,
      triggers,
      mode: full ? "full" : "brief",
      agentName: this.options.username,
      leadMessageIds: triggers
        .filter((message) => this.leadMessages.has(message.id))
        .map((message) => message.id),
      ...(membersUpdate ? { membersUpdate } : {}),
      ...(whiteboardUpdate ? { whiteboardUpdate } : {}),
      attachmentPaths,
    });
    return {
      text: rulesUpdated
        ? `你的工作规则已更新，以下为完整的新规则，与之前的规则冲突时以这里为准：\n<updated_rules>\n${this.instructions}\n</updated_rules>\n\n${prompt}`
        : prompt,
      full,
      ...(this.state.threadId ? { threadId: this.state.threadId } : {}),
      ...(whiteboardSnapshot ? { whiteboardSnapshot } : {}),
      ...(membersSnapshot ? { membersSnapshot } : {}),
    };
  }

  /** 为消息里的附件准备本机路径；拿不到的只在日志里记一笔，Agent 仍可改用 hive_attachment_read */
  private async attachmentPaths(messages: ChatMessage[]): Promise<AttachmentPaths> {
    const cache = this.attachments;
    if (!cache) return {};
    const items = messages.flatMap((message) =>
      message.deletedAt ? [] : (message.attachments ?? []),
    );
    const paths: AttachmentPaths = {};
    await Promise.all(
      items.map(async (item) => {
        const located = await cache.locate(item);
        if ("path" in located) paths[item.id] = located.path;
        else this.log(`[hive] 附件 ${item.name}：${located.error}`);
      }),
    );
    return paths;
  }

  private instructionsDigest(): string {
    return createHash("sha256").update(this.instructions).digest("hex").slice(0, 16);
  }

  private notePromptSent(prompt: PreparedPrompt): void {
    if (prompt.full) {
      this.state.briefTurns = 0;
      this.state.lastFullPromptAt = new Date().toISOString();
      this.state.instructionsDigest = this.instructionsDigest();
    } else {
      this.state.briefTurns = (this.state.briefTurns ?? 0) + 1;
    }
    delete this.state.whiteboardDigest;
    const threadId = this.state.threadId;
    if (prompt.threadId !== threadId || this.state.promptContext?.threadId !== threadId) {
      delete this.state.promptContext;
    }
    // Some runtimes recover a missing thread themselves. A delta sent to that replacement
    // cannot establish a full baseline; send fresh snapshots on the next wake instead.
    if (!threadId || (!prompt.full && prompt.threadId !== threadId)) return;
    const context = this.state.promptContext ?? { threadId };
    if (prompt.whiteboardSnapshot) context.whiteboard = prompt.whiteboardSnapshot;
    if (prompt.membersSnapshot) context.members = prompt.membersSnapshot;
    this.state.promptContext = context;
  }
}

function normalizeReply(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 最终输出和本轮用工具发过的某条消息是同一段话（或几乎整段包含） */
export function repeatsToolMessage(content: string, sent: ChatMessage[]): boolean {
  const final = normalizeReply(content);
  if (!final) return false;
  return sent.some((message) => {
    const posted = normalizeReply(message.content);
    if (!posted) return false;
    if (posted === final) return true;
    const [shorter, longer] = posted.length < final.length ? [posted, final] : [final, posted];
    return longer.includes(shorter) && shorter.length >= longer.length * 0.9;
  });
}

/** 发完之后只说一句「已发送」：不是新的回复内容 */
export function isSendAcknowledgement(content: string): boolean {
  const text = normalizeReply(content);
  return (
    text.length <= 40 &&
    /(已|已经)(通过|用|经)?.{0,20}(发送|发出|回复|发到|发在)|^sent\b|hive_message_send/i.test(text)
  );
}
