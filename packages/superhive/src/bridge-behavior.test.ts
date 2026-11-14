import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentBridge, pickReplyParent } from "./bridge.js";
import type {
  ChatMessage,
  Invocation,
  InvocationReport,
  Participant,
  WhiteboardEntry,
} from "./hive-protocol.js";
import {
  AgentCancelledError,
  AgentExecutionUncertainError,
  AgentNonRetryableError,
  AgentSessionInvalidError,
  AgentUpstreamError,
  type AgentReply,
  type AgentReplyInput,
  type AgentResponder,
} from "./responder.js";
import type { RoomClient, RoomClientHandlers, Snapshot } from "./room-client.js";
import { StateStore, type AgentState } from "./state-store.js";

const SELF = "00000000-0000-4000-8000-0000000000aa";
let seq = 0;

function chat(overrides: Partial<ChatMessage> = {}): ChatMessage {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    roomId: "general",
    seq,
    senderId: "00000000-0000-4000-8000-0000000000bb",
    senderName: "Alice",
    senderType: "human",
    content: "@agent-a 帮忙",
    mentions: ["agent-a"],
    traceId: "00000000-0000-4000-8000-0000000000cc",
    hopCount: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const self: Participant = {
  id: SELF,
  roomId: "general",
  username: "agent-a",
  type: "agent",
  status: "online",
  joinedAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
};

/** 记录 Bridge 对房间的所有调用，并允许测试直接触发服务端事件 */
class FakeRoom {
  handlers!: RoomClientHandlers;
  messages: ChatMessage[] = [];
  reports: Array<Omit<InvocationReport, "type">> = [];
  sent: Array<{ content: string; clientMessageId: string; parentMessageId: string }> = [];
  whiteboard: WhiteboardEntry[] = [];
  participants: Participant[] = [self];
  whiteboardCalls = 0;
  participantCalls = 0;
  /** 模拟 Server 重启：接下来这么多次补拉/发送都连不上 */
  offlineCalls = 0;
  private offline(): void {
    if (this.offlineCalls > 0) {
      this.offlineCalls -= 1;
      throw new Error("聊天室连接已断开，稍后将自动重试。");
    }
  }

  start() {}
  stop() {}
  sessions: Array<{ sessionId: string; cwd: string }> = [];
  reportSession(sessionId: string, cwd: string) {
    this.sessions.push({ sessionId, cwd });
  }
  typing: boolean[] = [];
  setTyping(active: boolean) {
    this.typing.push(active);
  }
  async fetchInstructions() {
    return "server rules";
  }
  async fetchMessages(afterSeq: number) {
    this.offline();
    const messages = this.messages.filter((message) => message.seq > afterSeq);
    return { messages, latestSeq: this.messages.at(-1)?.seq ?? afterSeq };
  }
  async fetchWhiteboard() {
    this.whiteboardCalls += 1;
    return this.whiteboard;
  }
  async fetchParticipants() {
    this.participantCalls += 1;
    return this.participants;
  }
  report(report: Omit<InvocationReport, "type">) {
    this.order.push(report.status);
    this.reports.push(report);
  }
  async sendMessage(input: { content: string; clientMessageId: string; parentMessageId: string }) {
    this.offline();
    this.sent.push(input);
    const reply = chat({
      senderId: SELF,
      senderName: "agent-a",
      senderType: "agent",
      content: input.content,
      mentions: [],
    });
    this.messages.push(reply);
    return reply;
  }
  approvalRequests: Array<{ messageId: string; requestId: string; summary: string }> = [];
  approvalsSupported = true;
  requestApproval(request: { messageId: string; requestId: string; summary: string }) {
    if (!this.approvalsSupported) return false;
    this.approvalRequests.push(request);
    return true;
  }
  traces: Array<{ messageId: string; steps: unknown[] }> = [];
  /** 按先后记下执行过程和状态回报，用来核对顺序 */
  order: string[] = [];
  trace(messageId: string, steps: unknown[]) {
    this.order.push("trace");
    this.traces.push({ messageId, steps });
  }
  statuses(messageId: string) {
    return this.reports
      .filter((report) => report.messageId === messageId)
      .map((report) => report.status);
  }
}

/** 可控的 Responder：每次 reply 都挂起，由测试决定何时完成或失败 */
class ControlledResponder implements AgentResponder {
  async close() {}
  calls: AgentReplyInput[] = [];
  steered: string[] = [];
  steerResult = true;
  private resolvers: Array<{
    resolve: (reply: AgentReply) => void;
    reject: (error: Error) => void;
  }> = [];

  reply(input: AgentReplyInput): Promise<AgentReply> {
    this.calls.push(input);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.resolvers.push(entry);
      input.signal?.addEventListener("abort", () => {
        this.resolvers = this.resolvers.filter((candidate) => candidate !== entry);
        reject(new AgentCancelledError());
      });
    });
  }
  async steer(prompt: string) {
    this.steered.push(prompt);
    return this.steerResult;
  }
  finish(
    text = "完成",
    threadId = "thread-1",
    usage?: AgentReply["usage"],
    sessionCostUsd?: number,
  ) {
    this.resolvers.shift()?.resolve({
      text,
      threadId,
      ...(usage ? { usage } : {}),
      ...(sessionCostUsd !== undefined ? { sessionCostUsd } : {}),
    });
  }
  fail(message: string | Error = "boom") {
    this.resolvers.shift()?.reject(message instanceof Error ? message : new Error(message));
  }
}

async function flush(times = 5) {
  for (let index = 0; index < times; index += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("AgentBridge", () => {
  let directory: string;
  let store: StateStore;
  let room: FakeRoom;
  let responder: ControlledResponder;
  let bridge: AgentBridge;
  const identity = { serverUrl: "http://hive", roomId: "general", username: "agent-a" };

  /** 本机 Hive Server 写给 Agent 的设置文件（模型、备用模型） */
  let settingsFile: string | undefined;
  let taskWorkspace: ConstructorParameters<typeof AgentBridge>[0]["taskWorkspace"];

  async function startBridge(
    state?: AgentState,
    invocations?: Invocation[],
    snapshotMessages: ChatMessage[] = [],
  ) {
    if (state) await store.save(state);
    bridge = new AgentBridge(
      {
        ...identity,
        persona: "p",
        provider: "codex",
        token: "t",
        ...(settingsFile ? { settingsFile } : {}),
        ...(taskWorkspace ? { taskWorkspace, cwd: directory, access: "workspace" as const } : {}),
        tuning: {
          batchWindowMs: 20,
          offlineRetryIntervalMs: 5,
          traceFlushMs: 5,
          upstreamRetryDelaysMs: [30, 60],
        },
      },
      store,
      responder,
      () => undefined,
      (_options, handlers) => {
        room.handlers = handlers;
        return room as unknown as RoomClient;
      },
    );
    await bridge.start();
    const snapshot: Snapshot = {
      self,
      latestSeq: room.messages.at(-1)?.seq ?? 0,
      messages: snapshotMessages,
      participants: [self],
      ...(invocations ? { invocations } : {}),
    };
    await room.handlers.onSnapshot(snapshot);
  }

  async function completePromptTurn(threadId = "thread-1"): Promise<AgentReplyInput> {
    const index = responder.calls.length;
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === index + 1);
    const input = responder.calls[index]!;
    responder.finish("完成", threadId);
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    return input;
  }

  function seedPromptContext() {
    room.whiteboard = ["a", "b"].map((key) => ({
      id: `board-${key}`,
      key,
      slot: "ready",
      summary: `summary-${key}`,
      unblocks: [],
      authorName: "author",
      updatedAt: "2026-10-31T00:00:00Z",
    }));
    room.participants = [self, { ...self, id: "other", username: "reviewer", persona: "review" }];
  }

  const baseState = (): AgentState => ({
    ...identity,
    lastProcessedSeq: 0,
    processedMessageIds: [],
  });

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "hive-bridge-test-"));
    store = new StateStore(directory, identity);
    room = new FakeRoom();
    responder = new ControlledResponder();
    settingsFile = undefined;
    taskWorkspace = undefined;
  });

  afterEach(async () => {
    await bridge?.stop();
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });

  it("hands off only after the setup turn ends, with a new cwd, session and full context", async () => {
    const checkout = path.join(directory, "checkout");
    const isolated = new ControlledResponder();
    let selected: string | undefined = undefined;
    const close = vi.fn(async () => undefined);
    responder.close = close;
    const factory = vi.fn(() => isolated);
    taskWorkspace = { resolve: async () => selected, responder: factory };
    await startBridge({ ...baseState(), workspace: directory, threadId: "old-thread" });
    const message = chat();
    room.messages.push(message);
    room.handlers.onMention(message, message.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    expect(responder.calls[0]?.threadId).toBe("old-thread");
    selected = checkout;
    expect(close).not.toHaveBeenCalled();
    responder.finish("Created checkout; no files edited", "old-thread");
    await waitUntil(() => isolated.calls.length === 1);
    expect(close).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(checkout);
    expect(isolated.calls[0]?.threadId).toBeUndefined();
    expect(isolated.calls[0]?.instructions).toContain(checkout);
    expect(isolated.calls[0]?.prompt).toContain("Created checkout; no files edited");
    expect(isolated.calls[0]?.prompt).toContain("不要重放原任务");
    expect(room.sent).toHaveLength(0);
    isolated.finish("Finished in isolated checkout", "isolated-thread");
    await waitUntil(() => room.statuses(message.id).includes("completed"));
    expect(room.sent.map((item) => item.content)).toEqual(["Finished in isolated checkout"]);
    expect(await store.load()).toMatchObject({ workspace: checkout, threadId: "isolated-thread" });
    const followup = chat({ content: "@agent-a review fixes" });
    room.messages.push(followup);
    room.handlers.onMention(followup, followup.seq, false);
    await waitUntil(() => isolated.calls.length === 2);
    expect(isolated.calls[1]?.threadId).toBe("isolated-thread");
    isolated.finish();
    await waitUntil(() => room.statuses(followup.id).includes("completed"));
  });

  it("does not automatically continue a directory handoff after other side effects", async () => {
    const isolated = new ControlledResponder();
    let selected: string | undefined = undefined;
    taskWorkspace = { resolve: async () => selected, responder: () => isolated };
    await startBridge(baseState());
    const message = chat();
    room.messages.push(message);
    room.handlers.onMention(message, message.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.calls[0]?.onTrace?.({
      id: "write",
      kind: "tool",
      tool: "write",
      summary: "write original checkout",
      startedAt: new Date().toISOString(),
    });
    selected = path.join(directory, "checkout");
    responder.finish("Original checkout changed; worktree prepared");
    await waitUntil(() => room.statuses(message.id).includes("failed"));
    expect(isolated.calls).toHaveLength(0);
    expect(room.reports.find((report) => report.status === "failed")?.detail).toContain(
      "未自动续跑",
    );
    expect(await store.load()).toMatchObject({ workspace: selected });
  });

  it("refuses to run when the managed workspace cannot be verified", async () => {
    taskWorkspace = {
      resolve: async () => {
        throw new AgentNonRetryableError("checkout identity changed");
      },
      responder: () => responder,
    };
    await startBridge(baseState());
    const message = chat();
    room.messages.push(message);
    room.handlers.onMention(message, message.seq, false);
    await waitUntil(() => room.statuses(message.id).includes("failed"));
    expect(responder.calls).toHaveLength(0);
  });

  it("drops an old directory's thread when a saved task starts in another checkout", async () => {
    const isolated = new ControlledResponder();
    const checkout = path.join(directory, "checkout");
    taskWorkspace = { resolve: async () => checkout, responder: () => isolated };
    await startBridge({ ...baseState(), workspace: directory, threadId: "old-thread" });
    const message = chat();
    room.messages.push(message);
    room.handlers.onMention(message, message.seq, false);
    await waitUntil(() => isolated.calls.length === 1);
    expect(isolated.calls[0]?.threadId).toBeUndefined();
    isolated.finish();
    await waitUntil(() => room.statuses(message.id).includes("completed"));
  });

  it("reports the full lifecycle and writes the execution intent before calling the provider", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);

    const intent = await store.load();
    expect(intent?.inflight?.messageIds).toEqual([mention.id]);
    expect(room.statuses(mention.id)).toEqual(["received", "running"]);
    expect(room.reports.find((report) => report.status === "running")?.contextSeq).toBe(
      mention.seq,
    );

    responder.finish("搞定");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    const completed = room.reports.find((report) => report.status === "completed");
    expect(completed?.replyMessageId).toBe(room.messages.at(-1)?.id);
    expect(room.sent[0]).toMatchObject({ content: "搞定", parentMessageId: mention.id });
    const saved = await store.load();
    expect(saved?.inflight).toBeUndefined();
    expect(saved?.processedMessageIds).toContain(mention.id);
    expect(saved?.threadId).toBe("thread-1");
  });

  it("waits for the Hive Server to come back instead of re-running a finished turn", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    // 模型已经给出结果，这时 Server 正在重启：补拉和发送各失败几次后恢复
    room.offlineCalls = 4;
    responder.finish("重启期间做完的");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    expect(room.sent).toHaveLength(1);
    expect(room.sent[0]).toMatchObject({ content: "重启期间做完的" });
    // 没有把整轮当失败重跑
    expect(responder.calls).toHaveLength(1);
    expect(room.statuses(mention.id)).not.toContain("failed");
  });

  it("strips the attachment directive from the reply and reports files it could not publish", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.finish("做好了\n\n<hive-attachments>\nout/a.png\n</hive-attachments>");
    await waitUntil(() => room.sent.length === 1);
    expect(room.sent[0]?.content).toBe(
      "做好了\n\n（以下附件没有发出：a.png — 这个 Agent 没有配置工作目录，不能发布文件）",
    );
    expect(room.sent[0]).not.toHaveProperty("attachmentIds");
  });

  it("resends the full rules once when they changed for a resumed codex thread", async () => {
    await startBridge({ ...baseState(), threadId: "thread-old", instructionsDigest: "stale" });
    const first = chat();
    room.messages.push(first);
    room.handlers.onMention(first, first.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    expect(responder.calls[0]?.prompt).toContain("<updated_rules>");
    expect(responder.calls[0]?.prompt).toContain("server rules");
    responder.finish("好");
    await waitUntil(() => room.sent.length === 1);

    const second = chat({ seq: first.seq + 10 });
    room.messages.push(second);
    room.handlers.onMention(second, second.seq, false);
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.calls[1]?.prompt).not.toContain("<updated_rules>");
  });

  it("still posts the final answer after delegating with hive_invoke", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    // 本轮中途经 hive_invoke 发出的委派消息不是这一轮的回复
    room.messages.push(
      chat({
        senderId: SELF,
        senderName: "agent-a",
        senderType: "agent",
        content: "@agent-b 子任务",
        mentions: ["agent-b"],
        kind: "delegation",
      }),
    );
    responder.finish("已委派 agent-b，结果回来后汇总");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    expect(room.sent).toEqual([
      expect.objectContaining({
        content: "已委派 agent-b，结果回来后汇总",
        parentMessageId: mention.id,
      }),
    ]);
  });

  it("posts the final answer after an interim hive_message_send, but not a repeat or an acknowledgement", async () => {
    const run = async (final: string, sentContent: string) => {
      const calls = responder.calls.length;
      const mention = chat({ content: `@agent-a ${final}` });
      room.messages.push(mention);
      room.handlers.onMention(mention, mention.seq, false);
      await waitUntil(() => responder.calls.length === calls + 1);
      const interim = chat({
        senderId: SELF,
        senderName: "agent-a",
        senderType: "agent",
        content: sentContent,
        mentions: [],
        parentMessageId: mention.id,
      });
      room.messages.push(interim);
      responder.finish(final);
      await waitUntil(() => room.statuses(mention.id).includes("completed"));
      const completed = room.reports.find(
        (report) => report.messageId === mention.id && report.status === "completed",
      );
      return { interim, completed };
    };
    await startBridge(baseState());
    // 中途报了一句进度，最终的完整结论照常代发，并作为这一轮的回复
    const first = await run("全部修完，测试通过", "收到，开始做");
    expect(room.sent.at(-1)).toMatchObject({ content: "全部修完，测试通过" });
    expect(first.completed?.replyMessageId).toBe(room.messages.at(-1)!.id);
    // 最终输出和工具发过的一样：不重复发
    const sentBefore = room.sent.length;
    const second = await run("结论：已修复", "结论：已修复");
    expect(room.sent).toHaveLength(sentBefore);
    expect(second.completed?.replyMessageId).toBe(second.interim.id);
    // 只说一句已发送：不重复发
    const third = await run("已通过 hive_message_send 发送", "这是完整的答复");
    expect(room.sent).toHaveLength(sentBefore);
    expect(third.completed?.replyMessageId).toBe(third.interim.id);
  });

  it("hands a runtime approval request to the server and resolves it with the human's decision", async () => {
    await startBridge(baseState());
    const mention = chat({ content: "@agent-a 跑一下" });
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    const ask = responder.calls[0]!.requestApproval!;
    const first = ask({ tool: "Bash", summary: "curl example.com" });
    await waitUntil(() => room.approvalRequests.length === 1);
    expect(room.approvalRequests[0]).toMatchObject({
      messageId: mention.id,
      summary: "curl example.com",
    });
    room.handlers.onApprovalDecision?.(room.approvalRequests[0]!.requestId, true);
    await expect(first).resolves.toBe(true);
    // 这一轮被停止：等着的申请按拒绝
    const second = ask({ tool: "Bash", summary: "rm -rf x" });
    room.handlers.onCancel?.(mention.id);
    await expect(second).resolves.toBe(false);
    // 服务端不支持时直接拒绝，不干等
    room.approvalsSupported = false;
    await expect(ask({ tool: "Bash", summary: "x" })).resolves.toBe(false);
  });

  it("never takes a progress update as the turn's reply", async () => {
    await startBridge(baseState());
    const mention = chat({ content: "@agent-a 跑一遍全量测试" });
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    room.messages.push(
      chat({
        senderId: SELF,
        senderName: "agent-a",
        senderType: "agent",
        content: "全部通过",
        mentions: [],
        parentMessageId: mention.id,
        kind: "progress",
      }),
    );
    // 最终输出和进度一样，也照常作为回复发出
    responder.finish("全部通过");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    expect(room.sent.at(-1)).toMatchObject({ content: "全部通过" });
  });

  it("processes a server-dispatched answer that does not @ the agent", async () => {
    await startBridge(baseState());
    // 人回复了 Agent 的提问：正文没有 @，但服务端已为它派发
    const answer = chat({ content: "A", mentions: [] });
    room.messages.push(answer);
    room.handlers.onMention(answer, answer.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.finish("收到，开始提交");
    await waitUntil(() => room.statuses(answer.id).includes("completed"));
    expect(room.sent[0]).toMatchObject({ content: "收到，开始提交", parentMessageId: answer.id });
  });

  it("still posts the final answer after asking a human with hive_ask_human", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    // 本轮中途经 hive_ask_human 发出的提问不是这一轮的回复
    room.messages.push(
      chat({
        senderId: SELF,
        senderName: "agent-a",
        senderType: "agent",
        content: "@Alice ❓ 发正式环境吗？",
        mentions: ["Alice"],
        kind: "question",
      }),
    );
    responder.finish("在等 Alice 确认环境，确认后继续");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    expect(room.sent).toEqual([
      expect.objectContaining({
        content: "在等 Alice 确认环境，确认后继续",
        parentMessageId: mention.id,
      }),
    ]);
  });

  it("stays silent on NO_REPLY but still completes and remembers the mention", async () => {
    await startBridge(baseState());
    const mention = chat({
      senderName: "agent-b",
      senderType: "agent",
      content: "@agent-a 我这边结论和你一致",
    });
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    // 全部由 Agent 唤醒时，结尾提醒可以不回
    expect(responder.calls[0]!.prompt).toContain("只输出 NO_REPLY");

    responder.finish("**NO_REPLY**");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    expect(room.sent).toHaveLength(0);
    const completed = room.reports.find((report) => report.status === "completed");
    expect(completed).toMatchObject({ detail: "无需回复" });
    expect(completed?.replyMessageId).toBeUndefined();
    expect((await store.load())?.processedMessageIds).toContain(mention.id);
  });

  it("strips a stray NO_REPLY from a real answer and only reminds about it for agent triggers", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    expect(responder.calls[0]!.prompt).not.toContain("只输出 NO_REPLY");

    responder.finish("已经改好了。\n\nNO_REPLY");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    expect(room.sent[0]?.content).toBe("已经改好了。");
  });

  it("merges a burst of mentions into one provider turn", async () => {
    await startBridge(baseState());
    const first = chat();
    const second = chat({ senderName: "Bob", content: "@agent-a 还有这个" });
    room.messages.push(first, second);
    room.handlers.onMention(first, first.seq, false);
    room.handlers.onMention(second, second.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    expect(responder.calls[0]!.prompt).toContain("当前有 2 条消息");
    responder.finish();
    await waitUntil(() => room.statuses(second.id).includes("completed"));
    expect(room.sent).toHaveLength(1);
    expect(responder.calls).toHaveLength(1);
  });

  it("reports a turn's usage once, tagged with new/resumed session and idle time", async () => {
    await startBridge(baseState());
    const usage = {
      inputTokens: 10,
      cacheWriteTokens: 400_000,
      cacheReadTokens: 0,
      outputTokens: 20,
      requests: 1,
      peakContextTokens: 400_010,
      peakCacheWriteTokens: 400_000,
      cacheWrite1hTokens: 0,
      firstRequestAt: "2026-10-31T10:00:00.000Z",
      lastRequestAt: "2026-10-31T10:06:00.000Z",
    };
    const first = chat();
    const second = chat({ senderName: "Bob", content: "@agent-a 还有这个" });
    room.messages.push(first, second);
    room.handlers.onMention(first, first.seq, false);
    room.handlers.onMention(second, second.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.finish("好", "thread-1", usage, 2.2);
    await waitUntil(() => room.statuses(second.id).includes("completed"));
    const withUsage = room.reports.filter((report) => report.usage);
    expect(withUsage).toHaveLength(1);
    expect(withUsage[0]).toMatchObject({ messageId: first.id, status: "completed" });
    expect(withUsage[0]!.usage).toEqual({
      ...usage,
      reportedCostUsd: 2.2,
      session: "new",
      outcome: "completed",
    });

    const third = chat({ content: "@agent-a 再来" });
    room.messages.push(third);
    room.handlers.onMention(third, third.seq, false);
    await waitUntil(() => responder.calls.length === 2);
    // 自报费用是会话累计值，本轮只记差额；间隔按上轮最后一次请求到本轮第一次请求算，
    // 不把上一轮执行的 6 分钟算成空闲
    responder.finish(
      "好",
      "thread-1",
      {
        ...usage,
        firstRequestAt: "2026-10-31T10:06:10.000Z",
        lastRequestAt: "2026-10-31T10:07:00.000Z",
      },
      2.4,
    );
    await waitUntil(() => room.statuses(third.id).includes("completed"));
    const resumed = room.reports.find((report) => report.messageId === third.id && report.usage);
    expect(resumed?.usage).toMatchObject({
      session: "resumed",
      idleMs: 10_000,
      idleBasis: "request",
      // 上一轮观测到的是 5 分钟写入
      previousCacheTtlMs: 300_000,
    });
    expect(resumed?.usage?.reportedCostUsd).toBeCloseTo(0.2);
  });

  it("still records usage observed before a turn failed, once", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.calls[0]!.onUsage?.({
      inputTokens: 5,
      cacheWriteTokens: 1000,
      cacheReadTokens: 0,
      outputTokens: 3,
      requests: 1,
      peakContextTokens: 1005,
      peakCacheWriteTokens: 1000,
    });
    responder.fail(new AgentExecutionUncertainError("lost"));
    await waitUntil(() => room.statuses(mention.id).includes("uncertain"));
    const withUsage = room.reports.filter((report) => report.usage);
    expect(withUsage).toHaveLength(1);
    expect(withUsage[0]).toMatchObject({
      status: "uncertain",
      usage: { cacheWriteTokens: 1000, outcome: "uncertain", session: "new" },
    });
  });

  it.each([false, true])(
    "steers late mentions and falls back to queueing (managed=%s)",
    async (managed) => {
      if (managed) taskWorkspace = { resolve: async () => undefined, responder: () => responder };
      await startBridge(baseState());
      const first = chat();
      room.messages.push(first);
      room.handlers.onMention(first, first.seq, false);
      await waitUntil(() => responder.calls.length === 1);

      const late = chat({ content: "@agent-a 顺便看下 README" });
      room.messages.push(late);
      room.handlers.onMention(late, late.seq, false, true);
      await waitUntil(() => responder.steered.length === 1);
      await flush();
      expect(responder.steered[0]).toContain("README");
      expect(room.statuses(late.id)).toContain("running");
      expect(
        room.reports.find((report) => report.messageId === late.id && report.status === "running")
          ?.detail,
      ).toBe(`已并入当前任务（#${first.seq}）`);
      // 执行过程里标出引导
      expect(room.traces.some((trace) => trace.messageId === first.id)).toBe(true);

      responder.steerResult = false;
      const queued = chat({ content: "@agent-a 第三件事" });
      room.messages.push(queued);
      room.handlers.onMention(queued, queued.seq, false, true);
      await waitUntil(() => responder.steered.length === 2);

      responder.finish();
      await waitUntil(() => room.statuses(late.id).includes("completed"));
      // 注入失败的那条在下一轮单独处理
      await waitUntil(() => responder.calls.length === 2);
      expect(responder.calls[1]!.prompt).toContain("第三件事");
      expect(responder.calls[1]!.threadId).toBe("thread-1");
      responder.finish();
      await waitUntil(() => room.statuses(queued.id).includes("completed"));
    },
  );

  it.each(["unbound", "same checkout", "unbound steer"])(
    "batches and steers managed messages in %s",
    async (mode) => {
      const checkout = mode === "unbound" ? undefined : path.join(directory, "checkout");
      let unboundSteer: string | undefined;
      const resolve = vi.fn(async (id: string) => (id === unboundSteer ? undefined : checkout));
      const resolveMany = vi.fn(
        async (ids: string[]) =>
          new Map(ids.map((id) => [id, id === unboundSteer ? undefined : checkout])),
      );
      taskWorkspace = { resolve, resolveMany, responder: () => responder };
      await startBridge(baseState());
      const first = chat();
      const second = chat({ content: "@agent-a also update tests" });
      room.messages.push(first, second);
      room.handlers.onMention(first, first.seq, false);
      room.handlers.onMention(second, second.seq, false);
      await waitUntil(() => responder.calls.length === 1);
      expect((await store.load())?.inflight?.messageIds).toEqual([first.id, second.id]);
      expect(resolveMany).toHaveBeenCalledOnce();
      expect(resolveMany).toHaveBeenCalledWith([first.id, second.id]);
      expect(resolve).not.toHaveBeenCalled();
      const late = chat({ content: "@agent-a add one more assertion" });
      if (mode === "unbound steer") unboundSteer = late.id;
      room.messages.push(late);
      room.handlers.onMention(late, late.seq, false, true);
      await waitUntil(() => room.statuses(late.id).includes("running"));
      expect(responder.steered).toHaveLength(1);
      responder.finish();
      await waitUntil(() => room.statuses(late.id).includes("completed"));
      expect(room.statuses(first.id)).toContain("completed");
      expect(room.statuses(second.id)).toContain("completed");
      expect(responder.calls).toHaveLength(1);
      expect(resolve).toHaveBeenCalledOnce();
      expect(resolveMany).toHaveBeenCalledTimes(2);
    },
  );

  it("does not batch or steer messages across different managed checkouts", async () => {
    const first = chat();
    const second = chat({ content: "@agent-a unrelated task" });
    const same = chat({ content: "@agent-a refine the current task" });
    const paths = new Map([
      [first.id, path.join(directory, "first-checkout")],
      [same.id, path.join(directory, "first-checkout")],
      [second.id, path.join(directory, "second-checkout")],
    ]);
    const other = new ControlledResponder();
    taskWorkspace = {
      resolve: async (id) => paths.get(id),
      resolveMany: async (ids) => new Map(ids.map((id) => [id, paths.get(id)])),
      responder: (cwd) => (cwd === paths.get(second.id) ? other : responder),
    };
    await startBridge(baseState());
    room.messages.push(first, second);
    room.handlers.onMention(first, first.seq, false);
    room.handlers.onMention(second, second.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    expect((await store.load())?.inflight?.messageIds).toEqual([first.id]);
    room.handlers.onMention(second, second.seq, false, true);
    await waitUntil(() =>
      room.reports.some(
        (report) => report.messageId === second.id && report.detail?.includes("另一个工作目录"),
      ),
    );
    expect(responder.steered).toHaveLength(0);
    expect(other.calls).toHaveLength(0);
    room.messages.push(same);
    room.handlers.onMention(same, same.seq, false, true);
    await waitUntil(() => responder.steered.length === 1);
    responder.finish();
    await waitUntil(() => other.calls.length === 1);
    expect(other.calls[0]?.threadId).toBeUndefined();
    expect(other.calls[0]?.instructions).toContain(paths.get(second.id));
    expect(room.statuses(second.id)).not.toContain("completed");
    other.finish();
    await waitUntil(() => room.statuses(second.id).includes("completed"));
    expect(responder.calls).toHaveLength(1);
  });

  it("queues a managed steer that finishes resolving after the current turn ends", async () => {
    let resolveSteer!: (value: string | undefined) => void;
    const waiting = new Promise<string | undefined>((resolve) => {
      resolveSteer = resolve;
    });
    taskWorkspace = {
      resolve: () => waiting,
      resolveMany: async (ids) => new Map(ids.map((id) => [id, undefined])),
      responder: () => responder,
    };
    await startBridge(baseState());
    const first = chat();
    room.messages.push(first);
    room.handlers.onMention(first, first.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    const late = chat();
    room.messages.push(late);
    room.handlers.onMention(late, late.seq, false, true);
    responder.finish();
    await waitUntil(() => room.statuses(first.id).includes("completed"));
    resolveSteer(undefined);
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.steered).toHaveLength(0);
    responder.finish();
    await waitUntil(() => room.statuses(late.id).includes("completed"));
  });

  it("queues a late mention by default and inserts it only when a human asks", async () => {
    await startBridge(baseState());
    const first = chat();
    room.messages.push(first);
    room.handlers.onMention(first, first.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    const late = chat({ content: "@agent-a 另一件事" });
    room.messages.push(late);
    room.handlers.onMention(late, late.seq, false);
    await flush();
    expect(responder.steered).toHaveLength(0);
    // 人点「引导」：从队里拿出来插进去
    room.handlers.onMention(late, late.seq, false, true);
    await waitUntil(() => responder.steered.length === 1);
    await waitUntil(() => room.statuses(late.id).includes("running"));
    responder.finish();
    await waitUntil(() => room.statuses(late.id).includes("completed"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(responder.calls).toHaveLength(1);
  });

  it("runs a stop-and-switch message next, on its own, ahead of the rest of the queue", async () => {
    await startBridge(baseState());
    const first = chat();
    room.messages.push(first);
    room.handlers.onMention(first, first.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    const earlier = chat({ content: "@agent-a 早来的另一件事" });
    const urgent = chat({ content: "@agent-a 方向变了，改做这个" });
    room.messages.push(earlier, urgent);
    room.handlers.onMention(earlier, earlier.seq, false);
    room.handlers.onMention(urgent, urgent.seq, false);
    await flush();
    // 人点「停下当前，改做这条」：先排到队首，再停当前任务
    room.handlers.onMention(urgent, urgent.seq, false, false, true);
    room.handlers.onCancel!(first.id);
    await waitUntil(() => responder.calls.length === 2);
    // 只看这一轮要回应的触发消息（其它消息作为上下文出现是正常的）
    const triggers = (index: number) =>
      responder.calls[index]!.prompt.split("<trigger_message")[1] ?? "";
    expect(triggers(1)).toContain("改做这个");
    expect(triggers(1)).not.toContain("早来的另一件事");
    responder.finish();
    await waitUntil(() => responder.calls.length === 3);
    expect(triggers(2)).toContain("早来的另一件事");
    responder.finish();
  });

  it("explains why a steer request stayed queued when nothing is running", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false, true);
    await waitUntil(() =>
      room.reports.some((report) => report.detail?.includes("没有正在执行、能引导的任务")),
    );
    await waitUntil(() => responder.calls.length === 1);
    responder.finish();
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
  });

  it("aborts the provider when every message of the turn is cancelled", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    room.handlers.onCancel!(mention.id);
    await waitUntil(() => room.statuses(mention.id).includes("cancelled"));
    expect(room.sent).toHaveLength(0);
    expect(responder.calls[0]!.signal?.aborted).toBe(true);
    expect((await store.load())?.processedMessageIds).toContain(mention.id);

    // 停止一条还在排队的提及：直接出队，不调用 Provider
    const blocker = chat();
    const queued = chat();
    room.messages.push(blocker, queued);
    responder.steerResult = false;
    room.handlers.onMention(blocker, blocker.seq, false);
    await waitUntil(() => responder.calls.length === 2);
    room.handlers.onMention(queued, queued.seq, false, true);
    await waitUntil(() => responder.steered.length >= 1);
    await flush();
    room.handlers.onCancel!(queued.id);
    responder.finish();
    await waitUntil(() => room.statuses(blocker.id).includes("completed"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(responder.calls).toHaveLength(2);
  });

  it("does not rerun an execution that was interrupted by a crash", async () => {
    const pendingMention = chat();
    room.messages.push(pendingMention);
    await startBridge({
      ...baseState(),
      inflight: {
        executionId: "exec-1",
        messageIds: [pendingMention.id],
        startedAt: new Date().toISOString(),
      },
    });
    await flush();
    expect(room.reports).toContainEqual(
      expect.objectContaining({ messageId: pendingMention.id, status: "uncertain" }),
    );
    expect(responder.calls).toHaveLength(0);
    expect((await store.load())?.inflight).toBeUndefined();

    // 人在界面中重试：忽略"已处理"记录并重新执行
    room.handlers.onMention(pendingMention, pendingMention.seq, true);
    await waitUntil(() => responder.calls.length === 1);
    responder.finish();
    await waitUntil(() => room.statuses(pendingMention.id).includes("completed"));
  });

  it("only replays queued mentions on reconnect and leaves blocked ones alone", async () => {
    const queued = chat();
    const blocked = chat({ content: "@agent-a 被拦下的" });
    room.messages.push(queued, blocked);
    const invocation = (message: ChatMessage, status: Invocation["status"]): Invocation => ({
      id: message.id.replace(/0000$/, "ffff"),
      roomId: "general",
      messageId: message.id,
      agentId: SELF,
      agentName: "agent-a",
      status,
      attempts: 1,
    });
    await startBridge(baseState(), [invocation(queued, "queued"), invocation(blocked, "blocked")]);
    await waitUntil(() => responder.calls.length === 1);
    expect(responder.calls[0]!.prompt).toContain("帮忙");
    expect(responder.calls[0]!.prompt).not.toContain("<trigger_message>\n#" + blocked.seq);
    responder.finish();
    await waitUntil(() => room.statuses(queued.id).includes("completed"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(responder.calls).toHaveLength(1);
  });

  it("picks up queued mentions on first join without replaying older chat", async () => {
    const history = chat({ content: "@agent-a 早就处理过的旧消息" });
    const inWindow = chat({ content: "@agent-a 上线前就排队的" });
    const outOfWindow = chat({ content: "@agent-a 太早的排队提及" });
    room.messages.push(outOfWindow, history, inWindow);
    const invocation = (message: ChatMessage, status: Invocation["status"]): Invocation => ({
      id: message.id.replace(/0000$/, "ffff"),
      roomId: "general",
      messageId: message.id,
      agentId: SELF,
      agentName: "agent-a",
      status,
      attempts: 1,
    });
    // 不传 state：本地没有状态文件，即首次加入；快照窗口里只有后两条消息
    await startBridge(
      undefined,
      [invocation(outOfWindow, "queued"), invocation(inWindow, "queued")],
      [history, inWindow],
    );
    await waitUntil(() => responder.calls.length === 1);
    expect(responder.calls[0]!.prompt).toContain("上线前就排队的");
    expect(room.reports).toContainEqual(
      expect.objectContaining({ messageId: outOfWindow.id, status: "failed" }),
    );
    responder.finish();
    await waitUntil(() => room.statuses(inWindow.id).includes("completed"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    // 没有 queued 调用的历史 @ 不补做
    expect(responder.calls).toHaveLength(1);
    expect(room.statuses(history.id)).toEqual([]);
  });

  it("retries failures with a stable idempotency key and dead-letters after three attempts", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.fail("网络错误");
    await waitUntil(() => responder.calls.length === 2, 3_000);
    responder.fail("网络错误");
    await waitUntil(() => responder.calls.length === 3, 5_000);
    responder.fail("网络错误");
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    const failed = room.reports.find((report) => report.status === "failed");
    expect(failed?.detail).toContain("连续失败 3 次");
    expect((await store.load())?.processedMessageIds).toContain(mention.id);
  }, 10_000);

  it("sends the trace steps still waiting to be batched before reporting the turn as done", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    // 最后一段思考刚结束、还没到合批时间，回合就结束了
    responder.calls[0]!.onTrace?.({
      id: "th",
      kind: "thinking",
      status: "ok",
      text: "最后想到的",
      startedAt: new Date().toISOString(),
    });
    responder.finish("做完了");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    expect(room.traces.at(-1)?.steps).toEqual([
      expect.objectContaining({ id: "th", text: "最后想到的" }),
    ]);
    expect(room.order.lastIndexOf("trace")).toBeLessThan(room.order.lastIndexOf("completed"));
  });

  /** 先跑完一轮，让 Bridge 记住会话 old-thread，再对下一条 @ 开始一轮（续接旧会话、只带新消息） */
  async function resumeTurn(): Promise<ChatMessage> {
    await completePromptTurn("old-thread");
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.calls[1]!.threadId).toBe("old-thread");
    expect(responder.calls[1]!.refreshInstructions).toBe(false);
    return mention;
  }

  const encrypted =
    "The encrypted content for item rs_1 could not be verified. Reason: Encrypted content could not be decrypted or parsed.";

  it("drops a broken session and reruns once in a new session with the full context", async () => {
    await startBridge(baseState());
    const mention = await resumeTurn();
    responder.fail(new AgentSessionInvalidError(encrypted));
    await waitUntil(() => responder.calls.length === 3);
    const rerun = responder.calls[2]!;
    expect(rerun.threadId).toBeUndefined();
    expect(rerun.refreshInstructions).toBe(true);
    expect(rerun.prompt).toContain("<room_members>");
    expect(rerun.prompt).toContain(mention.content);
    expect(room.statuses(mention.id)).not.toContain("failed");
    const retrying = room.reports.find((report) => report.progress?.includes("已开新会话重试"));
    expect(retrying?.detailText?.key).toBe("bridge.sessionRetrying");
    expect((await store.load())?.threadId).toBeUndefined();
    responder.finish("做完了", "new-thread");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    expect((await store.load())?.threadId).toBe("new-thread");
  });

  it("marks the task failed when the new session fails too, and a retry starts fresh", async () => {
    await startBridge(baseState());
    const mention = await resumeTurn();
    responder.fail(new AgentSessionInvalidError(encrypted));
    await waitUntil(() => responder.calls.length === 3);
    responder.fail(new AgentSessionInvalidError("previous response not found"));
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    const failed = room.reports.find((report) => report.status === "failed");
    expect(failed?.detail).toMatch(/^会话已失效：previous response not found/);
    expect(failed?.detail).toContain("开了新会话还是失败");
    expect(failed?.detail).toContain("点「重试」会开新会话");
    expect(failed?.detailText?.key).toBe("bridge.sessionInvalid");
    await flush();
    expect(responder.calls).toHaveLength(3);

    // 人点「重试」：一定是新会话，而且又可以自动重跑一次
    room.handlers.onMention(mention, mention.seq, true);
    await waitUntil(() => responder.calls.length === 4);
    expect(responder.calls[3]!.threadId).toBeUndefined();
    expect(responder.calls[3]!.refreshInstructions).toBe(true);
    responder.finish("好了", "fresh");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
  });

  it("does not rerun a broken session once a tool has run", async () => {
    await startBridge(baseState());
    const mention = await resumeTurn();
    // 只读工具也算：会话坏了说明之前的回复不可信，不能确定重跑不会重复做事
    responder.calls[1]!.onTrace?.({
      id: "r",
      kind: "tool",
      tool: "read",
      summary: "a.ts",
      startedAt: new Date().toISOString(),
    });
    responder.fail(new AgentSessionInvalidError(encrypted));
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    const failed = room.reports.find((report) => report.status === "failed");
    expect(failed?.detail).toContain("这一轮已经开始执行工具，不自动重跑");
    expect(failed?.detail).toContain("点「重试」会开新会话");
    await flush();
    expect(responder.calls).toHaveLength(2);
    expect((await store.load())?.threadId).toBeUndefined();

    room.handlers.onMention(mention, mention.seq, true);
    await waitUntil(() => responder.calls.length === 3);
    expect(responder.calls[2]!.threadId).toBeUndefined();
    expect(responder.calls[2]!.refreshInstructions).toBe(true);
    responder.finish();
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
  });

  it("does not rerun when the runtime reports it had already started a tool", async () => {
    await startBridge(baseState());
    const mention = await resumeTurn();
    responder.fail(new AgentSessionInvalidError(encrypted, true));
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    await flush();
    expect(responder.calls).toHaveLength(2);
  });

  async function writeSettings(settings: { model?: string }) {
    settingsFile = path.join(directory, "agent-settings.json");
    await writeFile(settingsFile, JSON.stringify({ mcpDisabled: [], ...settings }));
  }

  it("uses the model from the agent settings on every turn", async () => {
    await writeSettings({ model: "gpt-main" });
    await startBridge(baseState());
    await completePromptTurn();
    expect(responder.calls[0]!.model).toBe("gpt-main");
    // 网页上改了模型：下一轮就用新的，不用重启
    await writeSettings({ model: "gpt-other" });
    await completePromptTurn();
    expect(responder.calls[1]!.model).toBe("gpt-other");
  });

  it("never switches models on its own; a retired model fails right away with a hint", async () => {
    await writeSettings({ model: "gpt-old" });
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    // 模型下线：等多久都不会好，不自动重试、也不自动换模型，交给人
    responder.fail(new AgentUpstreamError("model_not_found: gpt-old", "s1", "model"));
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    const failed = room.reports.find((report) => report.status === "failed");
    expect(failed?.detail).toBe(
      "模型用不了：model_not_found: gpt-old。等多久都不会好，点「换个模型重试」选别的模型，或者在 Agent 设置里改模型。",
    );
    // 不是「上游出错、点继续」那种：网页上不会把「继续」当主按钮
    expect(failed?.detailText?.key).toBe("bridge.modelFailed");
    await flush();
    expect(responder.calls).toHaveLength(1);
  });

  it("keeps using the same model while retrying an overloaded upstream", async () => {
    await writeSettings({ model: "gpt-main" });
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    for (let call = 1; call <= 3; call += 1) {
      await waitUntil(() => responder.calls.length === call);
      expect(responder.calls[call - 1]!.model).toBe("gpt-main");
      responder.fail(new AgentUpstreamError("API Error: 529 overloaded", "s1"));
    }
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    await flush();
    expect(responder.calls).toHaveLength(3);
  });

  it("retries once with the model a person picked", async () => {
    await writeSettings({ model: "gpt-main" });
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.fail(new AgentNonRetryableError("boom"));
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    room.handlers.onMention(mention, mention.seq, true, false, false, false, "gpt-picked");
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.calls[1]!.model).toBe("gpt-picked");
    const using = room.reports.find((report) => report.detailText?.key === "bridge.usingModel");
    expect(using?.progress).toBe("这次用 gpt-picked 重试");
    responder.fail(new AgentNonRetryableError("boom again"));
    await waitUntil(() => room.statuses(mention.id).filter((s) => s === "failed").length === 2);
    // 普通「重试」回到设置里的模型
    room.handlers.onMention(mention, mention.seq, true);
    await waitUntil(() => responder.calls.length === 3);
    expect(responder.calls[2]!.model).toBe("gpt-main");
    responder.finish();
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
  });

  it("continues automatically on the same session after an upstream failure when nothing was changed", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    // 只读了文件、跑了只读命令
    const now = new Date().toISOString();
    responder.calls[0]!.onTrace?.({
      id: "r",
      kind: "tool",
      tool: "read",
      summary: "a.ts",
      startedAt: now,
    });
    responder.calls[0]!.onTrace?.({
      id: "c",
      kind: "tool",
      tool: "command",
      summary: "git status && ls -la",
      startedAt: now,
    });
    responder.fail(new AgentUpstreamError("API Error: 429 rate limited", "session-upstream"));
    await waitUntil(() =>
      room.reports.some(
        (report) => report.messageId === mention.id && report.progress?.includes("自动继续"),
      ),
    );
    expect(room.statuses(mention.id)).not.toContain("failed");
    // 等着自动继续时还算忙：对话流里是「执行中」，成员列表也不能显示空闲
    expect(room.typing.at(-1)).toBe(true);
    // 等一会儿接着原会话继续，并提醒从断点往下做
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.calls[1]!.threadId).toBe("session-upstream");
    expect(responder.calls[1]!.prompt).toContain("因上游模型服务出错在中途中断：API Error: 429");
    responder.finish("做完了", "session-upstream");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
  });

  it("stops for a human to continue after an upstream failure once something was changed", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.calls[0]!.onTrace?.({
      id: "w",
      kind: "tool",
      tool: "write",
      summary: "src/a.ts",
      startedAt: new Date().toISOString(),
    });
    responder.fail(new AgentUpstreamError("API Error: 529 overloaded", "session-x"));
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    const failed = room.reports.find((report) => report.status === "failed");
    expect(failed?.detail).toMatch(/^上游模型服务出错：API Error: 529 overloaded/);
    expect(failed?.detail).toContain("点「继续」");
    await flush();
    expect(responder.calls).toHaveLength(1);

    // 人点「继续」（即重试）：接着原会话、带上断点提示
    room.handlers.onMention(mention, mention.seq, true);
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.calls[1]!.threadId).toBe("session-x");
    expect(responder.calls[1]!.prompt).toContain("不要重复已经完成的");
    responder.finish("继续做完", "session-x");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
  });

  it("runs a task waiting to auto-continue only once even if the mention arrives again", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.fail(new AgentUpstreamError("API Error: 429", "s1"));
    await waitUntil(() => room.reports.some((report) => report.progress?.includes("自动继续")));
    // 等待期间重连补拉、或同一条 @ 又到了
    room.handlers.onMention(mention, mention.seq, false);
    await room.handlers.onSnapshot({
      self,
      latestSeq: mention.seq,
      messages: [mention],
      participants: [self],
      invocations: [],
    });
    await waitUntil(() => responder.calls.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(responder.calls).toHaveLength(2);
    responder.finish("完成", "s1");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(responder.calls).toHaveLength(2);
  });

  it("confirms a stop right away while waiting to auto-continue", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.fail(new AgentUpstreamError("API Error: 429", "s1"));
    await waitUntil(() => room.reports.some((report) => report.progress?.includes("自动继续")));
    expect(room.typing.at(-1)).toBe(true);
    room.handlers.onCancel?.(mention.id);
    await waitUntil(() => room.statuses(mention.id).includes("cancelled"));
    // 停掉以后不再算忙
    expect(room.typing.at(-1)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(responder.calls).toHaveLength(1);
  });

  it("answers a stop right away for a turn that already ended with an unknown result", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.fail(new AgentExecutionUncertainError("结果未知"));
    await waitUntil(() => room.statuses(mention.id).includes("uncertain"));
    const before = room.reports.length;
    room.handlers.onCancel?.(mention.id);
    await waitUntil(() => room.reports.length > before);
    expect(room.reports.at(-1)).toMatchObject({ status: "uncertain" });
    expect(room.reports.at(-1)?.detail).toContain("没有在跑的回合");
    expect(responder.calls).toHaveLength(1);
  });

  it("gives up auto-continuing after the configured attempts", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    for (let call = 1; call <= 3; call += 1) {
      await waitUntil(() => responder.calls.length === call);
      responder.fail(new AgentUpstreamError("rate limit exceeded"));
    }
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    expect(room.reports.find((report) => report.status === "failed")?.detail).toContain(
      "已自动继续 2 次仍未成功",
    );
  });

  it("sends the full context only for new sessions or periodically", async () => {
    await startBridge(baseState());
    for (let turn = 0; turn < 3; turn += 1) {
      const mention = chat();
      room.messages.push(mention);
      room.handlers.onMention(mention, mention.seq, false);
      await waitUntil(() => responder.calls.length === turn + 1);
      responder.finish();
      await waitUntil(() => room.statuses(mention.id).includes("completed"));
    }
    expect(responder.calls.map((call) => call.refreshInstructions)).toEqual([true, false, false]);
    expect(responder.calls[0]!.prompt).toContain("<room_members>");
    expect(responder.calls[1]!.prompt).not.toContain("<room_members>");
    // Fetch cheaply on each wake so member changes are detected; only changes enter prompts.
    expect(room.participantCalls).toBe(3);
  });

  it("does not resend unchanged whiteboard/members after timestamp changes or reordering", async () => {
    seedPromptContext();
    await startBridge(baseState());
    const first = await completePromptTurn();
    expect(first.prompt).toContain("summary-a");
    expect(first.prompt).toContain("reviewer");
    room.whiteboard = room.whiteboard
      .reverse()
      .map((entry) => ({ ...entry, updatedAt: "2026-10-31T01:00:00Z" }));
    room.participants = room.participants
      .reverse()
      .map((member) => ({ ...member, lastSeenAt: "2026-10-31T01:00:00Z" }));
    const next = await completePromptTurn();
    expect(next.refreshInstructions).toBe(false);
    expect(next.prompt).not.toContain("<room_whiteboard>");
    expect(next.prompt).not.toContain("<room_members>");
    expect((await store.load())?.promptContext?.whiteboard?.entries).toHaveLength(2);
  });

  it("sends only semantic deltas for whiteboard slot/content changes and member status changes", async () => {
    seedPromptContext();
    room.participants.push({ ...self, id: "stable", username: "unchanged-member" });
    await startBridge(baseState());
    await completePromptTurn();
    room.whiteboard[0] = { ...room.whiteboard[0]!, slot: "blocked", summary: "needs-input" };
    room.participants[1] = { ...room.participants[1]!, status: "busy" };
    const next = await completePromptTurn();
    expect(next.prompt).toContain("增量：");
    expect(next.prompt).toContain("阻塞：");
    expect(next.prompt).toContain("[a] needs-input");
    expect(next.prompt).not.toContain("summary-b");
    expect(next.prompt).toContain("reviewer（agent，busy）");
    expect(next.prompt).not.toContain("unchanged-member");
    const stable = await completePromptTurn();
    expect(stable.prompt).not.toContain("<room_whiteboard>");
    expect(stable.prompt).not.toContain("<room_members>");
  });

  it("sends removals when lists clear, then stays quiet", async () => {
    seedPromptContext();
    await startBridge(baseState());
    await completePromptTurn();
    room.whiteboard = [];
    room.participants = [self];
    const cleared = await completePromptTurn();
    expect(cleared.prompt).toContain("从摘要移除");
    expect(cleared.prompt).toContain("- [a]");
    expect(cleared.prompt).toContain("- [b]");
    expect(cleared.prompt).toContain("移出成员列表：\n- reviewer");
    const next = await completePromptTurn();
    expect(next.prompt).not.toContain("<room_whiteboard>");
    expect(next.prompt).not.toContain("<room_members>");
  });

  it("preserves context snapshots across Bridge restart and forces complete periodic refreshes", async () => {
    seedPromptContext();
    await startBridge(baseState());
    await completePromptTurn();
    await bridge.stop();
    await startBridge(await store.load());
    const resumed = await completePromptTurn();
    expect(resumed.prompt).not.toContain("<room_whiteboard>");
    expect(resumed.prompt).not.toContain("<room_members>");
    const state = (await store.load())!;
    await bridge.stop();
    await startBridge({ ...state, briefTurns: 8 });
    const periodic = await completePromptTurn();
    expect(periodic.refreshInstructions).toBe(true);
    expect(periodic.prompt).toContain("完整快照");
    expect(periodic.prompt).toContain("summary-a");
    expect(periodic.prompt).toContain("summary-b");
    expect(periodic.prompt).toContain("reviewer");
  });

  it("resends full unchanged context after the time-based refresh interval", async () => {
    seedPromptContext();
    await startBridge(baseState());
    await completePromptTurn();
    const state = (await store.load())!;
    await bridge.stop();
    await startBridge({ ...state, lastFullPromptAt: "2000-01-01T00:00:00Z" });
    const periodic = await completePromptTurn();
    expect(periodic.refreshInstructions).toBe(true);
    expect(periodic.prompt).toContain("完整快照");
    expect(periodic.prompt).toContain("summary-b");
    expect(periodic.prompt).toContain("reviewer");
  });

  it("never reuses the old topic baseline when the new topic's first fetch fails", async () => {
    seedPromptContext();
    await startBridge(baseState());
    await completePromptTurn();
    room.messages.push(chat({ kind: "topic", content: "new topic", mentions: [] }));
    vi.spyOn(room, "fetchWhiteboard").mockRejectedValueOnce(new Error("offline"));
    const first = await completePromptTurn("thread-new-topic");
    expect(first.threadId).toBeUndefined();
    expect(first.refreshInstructions).toBe(true);
    expect(first.prompt).toContain("reviewer");
    expect((await store.load())?.promptContext?.whiteboard).toBeUndefined();
    const next = await completePromptTurn("thread-new-topic");
    expect(next.prompt).toContain("完整快照");
    expect(next.prompt).toContain("summary-a");
    expect(next.prompt).not.toContain("<room_members>");
  });

  it("migrates legacy fingerprints to one full context snapshot without resetting the conversation", async () => {
    seedPromptContext();
    await startBridge(baseState());
    await completePromptTurn();
    const state = (await store.load())!;
    delete state.promptContext;
    state.whiteboardDigest = "legacy-digest";
    await bridge.stop();
    await startBridge(state);
    const migrated = await completePromptTurn();
    expect(migrated.threadId).toBe("thread-1");
    expect(migrated.refreshInstructions).toBe(false);
    expect(migrated.prompt).toContain("完整快照");
    expect(migrated.prompt).toContain("summary-b");
    expect((await store.load())?.whiteboardDigest).toBeUndefined();
    expect((await completePromptTurn()).prompt).not.toContain("<room_whiteboard>");
  });

  it("does not treat failed fetches as removals or lose changes observed after recovery", async () => {
    seedPromptContext();
    await startBridge(baseState());
    await completePromptTurn();
    const previous = (await store.load())!.promptContext;
    room.whiteboard[0] = { ...room.whiteboard[0]!, summary: "after-outage" };
    room.participants[1] = { ...room.participants[1]!, status: "offline" };
    vi.spyOn(room, "fetchWhiteboard").mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(room, "fetchParticipants").mockRejectedValueOnce(new Error("offline"));
    const failed = await completePromptTurn();
    expect(failed.prompt).not.toContain("<room_whiteboard>");
    expect(failed.prompt).not.toContain("<room_members>");
    expect((await store.load())!.promptContext).toEqual(previous);
    const recovered = await completePromptTurn();
    expect(recovered.prompt).toContain("[a] after-outage");
    expect(recovered.prompt).not.toContain("summary-b");
    expect(recovered.prompt).toContain("reviewer（agent，offline）");
  });

  it("supplies missing baseline after the first full fetch failed", async () => {
    seedPromptContext();
    await startBridge(baseState());
    vi.spyOn(room, "fetchWhiteboard").mockRejectedValueOnce(new Error("offline"));
    const first = await completePromptTurn();
    expect(first.prompt).not.toContain("<room_whiteboard>");
    const recovered = await completePromptTurn();
    expect(recovered.refreshInstructions).toBe(false);
    expect(recovered.prompt).toContain("完整快照");
    expect(recovered.prompt).toContain("summary-a");
    expect(recovered.prompt).toContain("summary-b");
    expect(recovered.prompt).not.toContain("<room_members>");
  });

  it("does not checkpoint an unacknowledged prompt when the provider fails", async () => {
    seedPromptContext();
    await startBridge(baseState());
    await completePromptTurn();
    const previous = (await store.load())!.promptContext;
    room.whiteboard[0] = { ...room.whiteboard[0]!, summary: "unacknowledged" };
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 2);
    responder.fail(new AgentNonRetryableError("failed before completion"));
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    expect((await store.load())!.promptContext).toEqual(previous);
    expect((await completePromptTurn()).prompt).toContain("[a] unacknowledged");
  });

  it("refreshes full context after a runtime silently replaced its missing thread", async () => {
    seedPromptContext();
    await startBridge(baseState());
    await completePromptTurn();
    await completePromptTurn("thread-replacement");
    expect((await store.load())!.promptContext).toBeUndefined();
    const next = await completePromptTurn("thread-replacement");
    expect(next.prompt).toContain("完整快照");
    expect(next.prompt).toContain("summary-b");
    expect(next.prompt).toContain("reviewer");
  });

  it("re-injects the rules right away when they changed since the session last saw them", async () => {
    await startBridge({
      ...baseState(),
      threadId: "thread-old",
      briefTurns: 1,
      lastFullPromptAt: new Date().toISOString(),
      instructionsDigest: "rules-before-upgrade",
    });
    for (let turn = 0; turn < 2; turn += 1) {
      const mention = chat();
      room.messages.push(mention);
      room.handlers.onMention(mention, mention.seq, false);
      await waitUntil(() => responder.calls.length === turn + 1);
      responder.finish();
      await waitUntil(() => room.statuses(mention.id).includes("completed"));
    }
    // 第一轮因规则变化发完整上下文，之后恢复增量
    expect(responder.calls.map((call) => call.refreshInstructions)).toEqual([true, false]);
    expect((await store.load())?.instructionsDigest).not.toBe("rules-before-upgrade");
  });

  it("drops the provider session and old context when someone starts a new topic", async () => {
    seedPromptContext();
    await startBridge({ ...baseState(), threadId: "thread-old" });
    room.messages.push(chat({ content: "旧话题里讨论的方案 A", mentions: [] }));
    const topic = chat({ kind: "topic", content: "Alice 开启了新话题", mentions: [] });
    room.messages.push(topic);
    room.messages.push(chat({ content: "新话题：改做方案 B", mentions: [] }));
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);

    const first = responder.calls[0]!;
    // 不再续用旧会话，并重新注入完整规则；上下文只剩分隔之后的消息
    expect(first.threadId).toBeUndefined();
    expect(first.refreshInstructions).toBe(true);
    expect(first.prompt).toContain("方案 B");
    expect(first.prompt).toContain("summary-a");
    expect(first.prompt).toContain("reviewer");
    expect(first.prompt).not.toContain("方案 A");
    responder.finish("好的", "thread-new");
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    expect((await store.load())?.topicSeq).toBe(topic.seq);

    // 同一个话题里的下一轮续用新会话，不会再次重置
    const next = chat();
    room.messages.push(next);
    room.handlers.onMention(next, next.seq, false);
    await waitUntil(() => responder.calls.length === 2);
    expect(responder.calls[1]!.threadId).toBe("thread-new");
    responder.finish();
    await waitUntil(() => room.statuses(next.id).includes("completed"));
  });

  it("reports heartbeat-only waiting without treating it as runtime progress or retrying", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.reports.at(-1)?.progress).toBe("仅 Bridge 心跳；1分0秒未收到 Runtime 新进度");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.reports.at(-1)?.progress).toContain("2分0秒未收到 Runtime 新进度，状态待核实");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.reports.at(-1)?.progress).toContain("3分0秒未收到 Runtime 新进度，状态待核实");
    expect(room.statuses(mention.id)).not.toContain("failed");
    expect(room.sent).toHaveLength(0);
    expect(responder.calls).toHaveLength(1);
    expect(responder.calls[0]!.signal?.aborted).toBe(false);

    responder.finish();
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    const reportsAtCompletion = room.reports.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(room.reports).toHaveLength(reportsAtCompletion);
  });

  it("labels old progress as historical and clears a stale warning on fresh runtime progress", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    const progress = responder.calls[0]!.onProgress!;
    progress("执行命令：读取项目");
    expect(room.reports.at(-1)?.progress).toBe("执行命令：读取项目");

    await vi.advanceTimersByTimeAsync(120_000);
    expect(room.reports.at(-1)?.progress).toContain("状态待核实；上次：执行命令：读取项目");
    // 刚发过心跳也不得节流掉新的真实进度，否则告警会继续误留在界面上。
    progress("调用工具：读取测试结果");
    expect(room.reports.at(-1)?.progress).toBe("调用工具：读取测试结果");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.reports.at(-1)?.progress).toContain("1分0秒未收到 Runtime 新进度");
    expect(room.reports.at(-1)?.progress).not.toContain("状态待核实");
  });

  it("tracks throttled runtime events without letting heartbeat reset the idle clock", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    const progress = responder.calls[0]!.onProgress!;
    progress("第一个动作");
    const reportsBeforeThrottle = room.reports.length;
    await vi.advanceTimersByTimeAsync(1_000);
    progress("第二个动作");
    expect(room.reports).toHaveLength(reportsBeforeThrottle);

    await vi.advanceTimersByTimeAsync(119_000);
    expect(room.reports.at(-1)?.progress).toContain("1分59秒未收到 Runtime 新进度");
    expect(room.reports.at(-1)?.progress).toContain("上次：第二个动作");
    expect(room.reports.at(-1)?.progress).not.toContain("状态待核实");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.reports.at(-1)?.progress).toContain("2分59秒未收到 Runtime 新进度，状态待核实");
  });

  it("keeps heartbeat warnings inside the progress wire limit even after a long tool label", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.calls[0]!.onProgress!("很长的工具名称".repeat(100));
    await vi.advanceTimersByTimeAsync(120_000);
    const warning = room.reports.at(-1)?.progress ?? "";
    expect(warning).toContain("状态待核实");
    expect(warning.length).toBeLessThanOrEqual(200);
  });

  it("streams structured facts, throttles activity but not errors, and ignores late callbacks", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    const emit = responder.calls[0]!.onRuntimeEvent!;
    emit({ kind: "capabilities", observability: "partial" });
    emit({ kind: "activity", phase: "tool_running", tool: "read" });
    const count = room.reports.length;
    for (let i = 0; i < 20; i++) emit({ kind: "activity", phase: "tool_running", tool: "read" });
    expect(room.reports).toHaveLength(count);
    emit({ kind: "provider_error", code: 429 });
    expect(room.reports.at(-1)?.runtimeEvent).toEqual({ kind: "provider_error", code: 429 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(room.reports.at(-1)?.runtimeEvent).toBeUndefined();
    expect(room.reports.at(-1)?.progress).toContain("状态待核实");
    emit({ kind: "recovered" });
    expect(room.reports.at(-1)?.runtimeEvent?.kind).toBe("recovered");
    responder.finish();
    await waitUntil(() => room.statuses(mention.id).includes("completed"));
    const finishedCount = room.reports.length;
    emit({ kind: "provider_error", code: 500 });
    expect(room.reports).toHaveLength(finishedCount);
  });

  it("reports a non-retryable startup failure once and preserves it across reconnect", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.fail(
      new AgentNonRetryableError("Codex app-server initialize 超时；不会自动降级或重试。"),
    );
    await waitUntil(() => room.statuses(mention.id).includes("failed"));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    room.handlers.onMention(mention, mention.seq, false);
    expect(responder.calls).toHaveLength(1);
    expect(room.reports.at(-1)?.detail).toContain("initialize");
    expect((await store.load())?.processedMessageIds).toContain(mention.id);
  });

  it("does not requeue a steer with unknown delivery", async () => {
    await startBridge(baseState());
    const first = chat();
    room.messages.push(first);
    room.handlers.onMention(first, first.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    vi.spyOn(responder, "steer").mockRejectedValue(new AgentExecutionUncertainError("ack lost"));
    const extra = chat();
    room.messages.push(extra);
    room.handlers.onMention(extra, extra.seq, false, true);
    await waitUntil(() => room.statuses(extra.id).includes("uncertain"));
    responder.finish("first complete");
    await waitUntil(() => room.statuses(first.id).includes("completed"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(responder.calls).toHaveLength(1);
    expect((await store.load())?.processedMessageIds).toContain(extra.id);
  });

  it("does not automatically replay a provider execution whose result was lost", async () => {
    await startBridge(baseState());
    const mention = chat();
    room.messages.push(mention);
    room.handlers.onMention(mention, mention.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    responder.fail(new AgentExecutionUncertainError());
    await waitUntil(() => room.statuses(mention.id).includes("uncertain"));
    expect(room.reports.at(-1)?.detail).toContain("已禁止自动重放");
    expect((await store.load())?.processedMessageIds).toContain(mention.id);
    room.handlers.onMention(mention, mention.seq, false);
    await flush();
    expect(responder.calls).toHaveLength(1);
  });

  it("waits for the whole batch to finish before acknowledging a partial cancellation", async () => {
    await startBridge(baseState());
    const first = chat();
    const second = chat();
    room.messages.push(first, second);
    room.handlers.onMention(first, first.seq, false);
    room.handlers.onMention(second, second.seq, false);
    await waitUntil(() => responder.calls.length === 1);
    room.handlers.onCancel!(first.id);
    expect(room.statuses(first.id)).not.toContain("cancelled");
    expect(responder.calls[0]!.signal?.aborted).toBe(false);
    responder.finish();
    await waitUntil(() => room.statuses(first.id).includes("cancelled"));
    expect(room.statuses(second.id)).toContain("completed");
  });

  it("picks the deepest trigger as the reply parent", () => {
    const human = chat({ hopCount: 0 });
    const agent = chat({ hopCount: 2, senderType: "agent" });
    const later = chat({ hopCount: 0 });
    expect(pickReplyParent([human, agent, later]).id).toBe(agent.id);
  });
});
