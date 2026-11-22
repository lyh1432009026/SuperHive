import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TraceStep } from "./hive-protocol.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AcpResponder,
  decideAcpPermission,
  isInsideDir,
  type AcpResponderOptions,
} from "./acp-responder.js";
import {
  AgentCancelledError,
  AgentNonRetryableError,
  AgentSessionInvalidError,
  AgentUpstreamError,
} from "./responder.js";
import type { StdioExit, StdioTransport } from "./stdio-transport.js";

const hive = {
  serverUrl: "http://localhost:8787",
  roomId: "general",
  username: "acp-agent",
  token: "test-token",
};

type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: any };
type Handler = (message: Message, agent: FakeAgent) => void;

/** 假的 ACP Agent：记录客户端发出的消息，并按 handlers 自动应答 */
class FakeAgent implements StdioTransport {
  readonly sent: Message[] = [];
  private lineListeners: Array<(line: string) => void> = [];
  private exitListeners: Array<(exit: StdioExit) => void> = [];
  killed = false;

  constructor(
    readonly args: string[],
    readonly env: Record<string, string> | undefined,
    private readonly handlers: Record<string, Handler>,
  ) {}

  write(line: string) {
    const message = JSON.parse(line) as Message;
    this.sent.push(message);
    if (message.method && this.handlers[message.method]) {
      queueMicrotask(() => this.handlers[message.method!]!(message, this));
    }
  }
  onLine(listener: (line: string) => void) {
    this.lineListeners.push(listener);
  }
  onExit(listener: (exit: StdioExit) => void) {
    this.exitListeners.push(listener);
  }
  kill() {
    this.killed = true;
  }

  emit(message: unknown) {
    for (const listener of this.lineListeners) listener(JSON.stringify(message));
  }
  update(sessionId: string, update: Record<string, unknown>) {
    this.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  }
  exit(exit: Partial<StdioExit> = {}) {
    for (const listener of this.exitListeners) {
      listener({ code: 1, signal: null, stderr: "", ...exit });
    }
  }
  methods() {
    return this.sent.filter((message) => message.method).map((message) => message.method);
  }
  request(method: string) {
    return this.sent.find((message) => message.method === method);
  }
  requests(method: string) {
    return this.sent.filter((message) => message.method === method);
  }
  responseTo(id: unknown) {
    return this.sent.find((message) => message.id === id && !message.method);
  }
}

const ok =
  (result: unknown): Handler =>
  (message, agent) =>
    agent.emit({ id: message.id, result });

const text = (value: string) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: value },
});

const initializeResult = (extra: Record<string, unknown> = {}) => ({
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
  ...extra,
});

/** 默认 handlers：握手、新会话、回合输出一段文字后正常结束 */
function defaultHandlers(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    initialize: ok(initializeResult()),
    "session/new": ok({ sessionId: "ses-new" }),
    "session/resume": ok({}),
    "session/load": ok(null),
    "session/prompt": (message, agent) => {
      agent.update(message.params.sessionId, text("done"));
      agent.emit({ id: message.id, result: { stopReason: "end_turn" } });
    },
    ...overrides,
  };
}

function setup(
  handlers: Record<string, Handler> = defaultHandlers(),
  extra: Partial<AcpResponderOptions> = {},
  deps: { requestTimeoutMs?: number; cancelGraceMs?: number; idleTimeoutMs?: number } = {},
) {
  const agents: FakeAgent[] = [];
  const createTransport = vi.fn(
    (_command: string, args: string[], options: { cwd: string; env?: Record<string, string> }) => {
      const agent = new FakeAgent(args, options.env, handlers);
      agents.push(agent);
      return agent;
    },
  );
  const log = vi.fn();
  const responder = new AcpResponder(
    {
      label: "TestAgent",
      command: "test-agent",
      args: ["acp"],
      env: { TEST_ENV: "1" },
      cwd: "/workspace",
      hive,
      log,
      ...extra,
    },
    { createTransport, clientVersion: "9.9.9", ...deps },
  );
  return { responder, agents, createTransport, log };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("AcpResponder", () => {
  it("initializes, injects the Hive MCP into a new session and prefixes the rules", async () => {
    const { responder, agents, createTransport } = setup();

    await expect(responder.reply({ instructions: "rules", prompt: "hi" })).resolves.toEqual({
      text: "done",
      threadId: "ses-new",
    });

    expect(createTransport).toHaveBeenCalledWith("test-agent", ["acp"], {
      cwd: "/workspace",
      env: { TEST_ENV: "1" },
    });
    const agent = agents[0]!;
    expect(agent.methods()).toEqual(["initialize", "session/new", "session/prompt"]);
    expect(agent.request("initialize")?.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "superhive", title: "SuperHive", version: "9.9.9" },
    });
    expect(agent.request("session/new")?.params).toEqual({
      cwd: "/workspace",
      mcpServers: [
        {
          type: "http",
          name: "hive",
          url: "http://localhost:8787/mcp",
          headers: [
            { name: "Authorization", value: "Bearer test-token" },
            { name: "X-Hive-Room", value: "general" },
            { name: "X-Hive-Agent-Name", value: "acp-agent" },
          ],
        },
      ],
    });
    expect(agent.request("session/prompt")?.params).toEqual({
      sessionId: "ses-new",
      prompt: [{ type: "text", text: "rules\n\n---\n\nhi" }],
    });
  });

  it("puts thought chunks on one thinking step and ends it when the agent starts talking", async () => {
    const { responder } = setup(
      defaultHandlers({
        "session/prompt": (message, agent) => {
          const sessionId = message.params.sessionId;
          for (const piece of ["先读 ", "README，", "token=abcdef123456"]) {
            agent.update(sessionId, {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: piece },
            });
          }
          agent.update(sessionId, text("好了。"));
          agent.emit({ id: message.id, result: { stopReason: "end_turn" } });
        },
      }),
    );
    const steps: TraceStep[] = [];
    await responder.reply({ instructions: "r", prompt: "p", onTrace: (step) => steps.push(step) });
    const thinking = steps.filter((step) => step.kind === "thinking");
    expect(new Set(thinking.map((step) => step.id)).size).toBe(1);
    expect(thinking.at(-1)).toMatchObject({ status: "ok", text: "先读 README，token=***" });
  });

  it("returns the final answer after tool calls and reports tool progress", async () => {
    const { responder } = setup(
      defaultHandlers({
        "session/prompt": (message, agent) => {
          const sessionId = message.params.sessionId;
          agent.update(sessionId, {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "…" },
          });
          agent.update(sessionId, text("先看一下成员。"));
          agent.update(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId: "t1",
            title: "bash",
            kind: "execute",
            status: "pending",
          });
          agent.update(sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId: "t1",
            title: "ls -la",
            kind: "execute",
            status: "in_progress",
          });
          agent.update(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId: "t2",
            title: "hive_members_list",
            kind: "other",
            status: "pending",
          });
          agent.update(sessionId, text("房间里有 "));
          agent.update(sessionId, text("4 位成员。"));
          // 其他会话的更新不应混进来
          agent.update("ses-other", text("无关内容"));
          agent.emit({ id: message.id, result: { stopReason: "end_turn" } });
        },
      }),
    );
    const progress: string[] = [];

    await expect(
      responder.reply({ instructions: "rules", prompt: "hi", onProgress: (p) => progress.push(p) }),
    ).resolves.toEqual({ text: "房间里有 4 位成员。", threadId: "ses-new" });
    expect(progress).toEqual([
      "思考中",
      "执行命令：bash",
      "执行命令：ls -la",
      "调用工具：hive_members_list",
    ]);
  });

  it("resumes an existing session without repeating the rules unless asked to", async () => {
    const { responder, agents } = setup();

    await responder.reply({ instructions: "rules", prompt: "first", threadId: "ses-old" });
    await responder.reply({
      instructions: "rules",
      prompt: "second",
      threadId: "ses-old",
      refreshInstructions: true,
    });

    const agent = agents[0]!;
    // 同一进程内已恢复的会话不再重复 resume
    expect(agent.methods()).toEqual([
      "initialize",
      "session/resume",
      "session/prompt",
      "session/prompt",
    ]);
    expect(agent.request("session/resume")?.params).toMatchObject({
      sessionId: "ses-old",
      cwd: "/workspace",
    });
    const prompts = agent.sent.filter((message) => message.method === "session/prompt");
    expect(prompts[0]?.params.prompt[0].text).toBe("first");
    expect(prompts[1]?.params.prompt[0].text).toBe("rules\n\n---\n\nsecond");
  });

  it("falls back to session/load and ignores the replayed history", async () => {
    const { responder, agents } = setup(
      defaultHandlers({
        initialize: ok({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
        "session/load": (message, agent) => {
          agent.update(message.params.sessionId, text("历史回放"));
          agent.emit({ id: message.id, result: null });
        },
      }),
    );

    await expect(
      responder.reply({ instructions: "rules", prompt: "hi", threadId: "ses-old" }),
    ).resolves.toEqual({ text: "done", threadId: "ses-old" });
    expect(agents[0]!.methods()).toEqual(["initialize", "session/load", "session/prompt"]);
  });

  it("starts a new session with the rules when the old one cannot be restored", async () => {
    const { responder, agents, log } = setup(
      defaultHandlers({
        "session/resume": (message, agent) =>
          agent.emit({ id: message.id, error: { code: -32602, message: "session not found" } }),
      }),
    );

    await expect(
      responder.reply({
        instructions: "rules",
        prompt: "hi",
        threadId: "ses-gone",
        refreshInstructions: true,
      }),
    ).resolves.toEqual({ text: "done", threadId: "ses-new" });
    expect(agents[0]!.request("session/prompt")?.params.prompt[0].text).toBe("rules\n\n---\n\nhi");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("旧会话 ses-gone 已失效"));
  });

  it("hands a failed restore back to the bridge when the prompt only has new messages", async () => {
    const { responder, agents } = setup(
      defaultHandlers({
        "session/resume": (message, agent) =>
          agent.emit({ id: message.id, error: { code: -32602, message: "session not found" } }),
      }),
    );
    const failure = responder.reply({ instructions: "rules", prompt: "hi", threadId: "ses-gone" });
    await expect(failure).rejects.toBeInstanceOf(AgentSessionInvalidError);
    // 新会话看不到房间上下文：不在这里开，等 Bridge 带完整上下文重来
    expect(agents[0]!.methods()).not.toContain("session/new");
    expect(agents[0]!.methods()).not.toContain("session/prompt");
  });

  it("reports a prompt rejected for a missing session as a broken session", async () => {
    const { responder } = setup(
      defaultHandlers({
        "session/prompt": (message, agent) =>
          agent.emit({
            id: message.id,
            error: { code: -32603, message: "Session not found: ses-old" },
          }),
      }),
    );
    const failure = responder.reply({ instructions: "rules", prompt: "hi", threadId: "ses-old" });
    await expect(failure).rejects.toBeInstanceOf(AgentSessionInvalidError);
    expect(((await failure.catch((error) => error)) as AgentSessionInvalidError).executed).toBe(
      false,
    );
  });

  it("switches the session model through session/set_config_option when it is offered", async () => {
    const configOptions = [
      {
        id: "model",
        currentValue: "anthropic/main",
        options: [
          { value: "anthropic/main", name: "Main" },
          { value: "openai/backup", name: "Backup" },
        ],
      },
    ];
    const { responder, agents } = setup(
      defaultHandlers({
        "session/new": ok({ sessionId: "ses-new", configOptions }),
        "session/set_config_option": ok({ configOptions }),
      }),
    );
    await responder.reply({ instructions: "rules", prompt: "hi", model: "openai/backup" });
    expect(agents[0]!.methods()).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/prompt",
    ]);
    expect(agents[0]!.request("session/set_config_option")?.params).toEqual({
      sessionId: "ses-new",
      configId: "model",
      value: "openai/backup",
    });
    // 已经是这个模型：不再切
    await responder.reply({
      instructions: "rules",
      prompt: "a",
      threadId: "ses-new",
      model: "openai/backup",
    });
    const switches = () =>
      agents[0]!.requests("session/set_config_option").map((message: any) => message.params.value);
    expect(switches()).toEqual(["openai/backup"]);
    // 没指定模型的回合切回会话原来的模型：「换个模型重试」只管那一次
    await responder.reply({ instructions: "rules", prompt: "b", threadId: "ses-new" });
    expect(switches()).toEqual(["openai/backup", "anthropic/main"]);
    // 人指定了运行时没有的模型：明说，不悄悄用原模型跑
    const failure = responder.reply({
      instructions: "rules",
      prompt: "c",
      threadId: "ses-new",
      model: "nope/x",
    });
    await expect(failure).rejects.toThrow("没有模型 nope/x");
    expect(((await failure.catch((error) => error)) as AgentUpstreamError).kind).toBe(
      "model_unavailable",
    );
  });

  it("ends an idle agent process and restores the session in a fresh one next time", async () => {
    const { responder, agents, createTransport, log } = setup(
      defaultHandlers(),
      {},
      {
        idleTimeoutMs: 30,
      },
    );
    await expect(responder.reply({ instructions: "rules", prompt: "hi" })).resolves.toMatchObject({
      threadId: "ses-new",
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(agents[0]!.killed).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("已空闲"));

    await expect(
      responder.reply({ instructions: "rules", prompt: "again", threadId: "ses-new" }),
    ).resolves.toMatchObject({ text: "done", threadId: "ses-new" });
    expect(createTransport).toHaveBeenCalledTimes(2);
    expect(agents[1]!.methods()).toEqual(["initialize", "session/resume", "session/prompt"]);
    expect(agents[1]!.request("session/resume")?.params).toMatchObject({ sessionId: "ses-new" });
    await responder.close();
  });

  it("answers permission requests according to the access mode", async () => {
    const options = [
      { optionId: "yes", name: "Allow once", kind: "allow_once" },
      { optionId: "always", name: "Always allow", kind: "allow_always" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ];
    const permissionHandlers = defaultHandlers({
      "session/prompt": (message, agent) => {
        const sessionId = message.params.sessionId;
        agent.emit({
          jsonrpc: "2.0",
          id: "p1",
          method: "session/request_permission",
          params: { sessionId, options, toolCall: { title: "ls", kind: "execute" } },
        });
        agent.emit({
          jsonrpc: "2.0",
          id: "p2",
          method: "session/request_permission",
          params: {
            sessionId,
            options,
            toolCall: { title: "edit", kind: "edit", locations: [{ path: "/workspace/a.ts" }] },
          },
        });
        agent.emit({
          jsonrpc: "2.0",
          id: "p3",
          method: "session/request_permission",
          params: {
            sessionId,
            options,
            toolCall: { title: "rm", kind: "delete", rawInput: { path: "../outside.txt" } },
          },
        });
        agent.update(sessionId, text("ok"));
        agent.emit({ id: message.id, result: { stopReason: "end_turn" } });
      },
    });
    const asked: string[] = [];
    const outcomes = async (access: "read-only" | "workspace" | "full", allow?: boolean) => {
      const { responder, agents } = setup(permissionHandlers, { access });
      await responder.reply({
        instructions: "rules",
        prompt: "hi",
        ...(allow === undefined
          ? {}
          : {
              requestApproval: async (request) => {
                asked.push(`${request.tool}:${request.summary}`);
                return allow;
              },
            }),
      });
      await new Promise((resolve) => setImmediate(resolve));
      return ["p1", "p2", "p3"].map(
        (id) => agents[0]!.responseTo(id)?.result.outcome.optionId as string,
      );
    };

    expect(await outcomes("read-only")).toEqual(["no", "no", "no"]);
    expect(await outcomes("workspace")).toEqual(["yes", "yes", "no"]);
    expect(await outcomes("full")).toEqual(["yes", "yes", "yes"]);
    // 工作区档超出范围的交给人批：批了放行，拒了照旧拒绝；只读档不问人
    expect(await outcomes("workspace", true)).toEqual(["yes", "yes", "yes"]);
    expect(await outcomes("workspace", false)).toEqual(["yes", "yes", "no"]);
    expect(await outcomes("read-only", true)).toEqual(["no", "no", "no"]);
    expect(asked).toEqual(["delete:rm", "delete:rm"]);
  });

  it("cancels the turn with session/cancel when the signal aborts", async () => {
    const { responder, agents } = setup(
      defaultHandlers({
        "session/prompt": () => undefined,
        "session/cancel": (_message, agent) => {
          const prompt = agent.request("session/prompt")!;
          agent.emit({ id: prompt.id, result: { stopReason: "cancelled" } });
        },
      }),
    );
    const controller = new AbortController();

    const reply = responder.reply({
      instructions: "rules",
      prompt: "hi",
      signal: controller.signal,
    });
    await flush();
    controller.abort();

    await expect(reply).rejects.toBeInstanceOf(AgentCancelledError);
    expect(agents[0]!.request("session/cancel")?.params).toEqual({ sessionId: "ses-new" });
    expect(agents[0]!.killed).toBe(false);
  });

  it("kills the agent when it does not stop within the grace period, then recovers", async () => {
    let hang = true;
    const { responder, agents } = setup(
      defaultHandlers({
        "session/prompt": (message, agent) => {
          if (hang) return;
          agent.update(message.params.sessionId, text("recovered"));
          agent.emit({ id: message.id, result: { stopReason: "end_turn" } });
        },
      }),
      {},
      { cancelGraceMs: 10 },
    );
    const controller = new AbortController();

    const reply = responder.reply({
      instructions: "rules",
      prompt: "hi",
      signal: controller.signal,
    });
    await flush();
    controller.abort();

    await expect(reply).rejects.toBeInstanceOf(AgentCancelledError);
    expect(agents[0]!.killed).toBe(true);

    hang = false;
    await expect(
      responder.reply({ instructions: "rules", prompt: "again", threadId: "ses-new" }),
    ).resolves.toEqual({ text: "recovered", threadId: "ses-new" });
    expect(agents[1]!.methods()).toEqual(["initialize", "session/resume", "session/prompt"]);
  });

  it("rejects the turn when the agent exits and restores the session in a new process", async () => {
    let first = true;
    const { responder, agents } = setup(
      defaultHandlers({
        "session/prompt": (message, agent) => {
          if (first) {
            first = false;
            agent.exit({ code: 1, stderr: "boom" });
            return;
          }
          agent.update(message.params.sessionId, text("recovered"));
          agent.emit({ id: message.id, result: { stopReason: "end_turn" } });
        },
      }),
    );

    await expect(responder.reply({ instructions: "rules", prompt: "hi" })).rejects.toThrow(
      /TestAgent 意外退出（code=1）。\nboom/,
    );
    await expect(
      responder.reply({ instructions: "rules", prompt: "again", threadId: "ses-new" }),
    ).resolves.toEqual({ text: "recovered", threadId: "ses-new" });
    expect(agents).toHaveLength(2);
    expect(agents[1]!.methods()).toEqual(["initialize", "session/resume", "session/prompt"]);
  });

  it("reports a missing command clearly", async () => {
    const { responder, agents } = setup(defaultHandlers({ initialize: () => undefined }));

    const reply = responder.reply({ instructions: "rules", prompt: "hi" });
    await flush();
    agents[0]!.exit({ code: null, error: Object.assign(new Error("spawn"), { code: "ENOENT" }) });

    await expect(reply).rejects.toThrow("找不到 TestAgent 命令 “test-agent”");
  });

  it("refuses incompatible protocol versions", async () => {
    const { responder, agents } = setup(
      defaultHandlers({ initialize: ok({ protocolVersion: 2 }) }),
    );

    await expect(responder.reply({ instructions: "rules", prompt: "hi" })).rejects.toThrow(
      "ACP 协议版本为 2",
    );
    expect(agents[0]!.killed).toBe(true);
  });

  it("keeps partial answers on max_tokens and rejects refusals or empty replies", async () => {
    const withStop = (stopReason: string, body?: string) =>
      setup(
        defaultHandlers({
          "session/prompt": (message, agent) => {
            if (body) agent.update(message.params.sessionId, text(body));
            agent.emit({ id: message.id, result: { stopReason } });
          },
        }),
      ).responder.reply({ instructions: "rules", prompt: "hi" });

    await expect(withStop("max_tokens", "部分回答")).resolves.toEqual({
      text: "部分回答",
      threadId: "ses-new",
    });
    // 模型拒答：原样重跑还是拒绝，按上游出错交给 Bridge，不自动重试
    const refused = await withStop("refusal", "不行").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AgentUpstreamError);
    expect((refused as AgentUpstreamError).kind).toBe("refused");
    await expect(withStop("end_turn")).rejects.toThrow("TestAgent 没有返回可发送的文本。");
    await expect(withStop("max_turn_requests")).rejects.toThrow("（max_turn_requests）");
  });

  it("declines client methods it did not advertise", async () => {
    const { responder, agents } = setup(
      defaultHandlers({
        "session/prompt": (message, agent) => {
          agent.emit({
            jsonrpc: "2.0",
            id: "fs1",
            method: "fs/read_text_file",
            params: { sessionId: message.params.sessionId, path: "/etc/passwd" },
          });
          agent.update(message.params.sessionId, text("ok"));
          agent.emit({ id: message.id, result: { stopReason: "end_turn" } });
        },
      }),
    );

    await responder.reply({ instructions: "rules", prompt: "hi" });
    expect(agents[0]!.responseTo("fs1")?.error).toEqual({
      code: -32601,
      message: "SuperHive 不支持的请求：fs/read_text_file",
    });
  });

  it("steers into the running turn only when the agent supports it", async () => {
    let release: (() => void) | undefined;
    const handlers = (steering: boolean) =>
      defaultHandlers({
        initialize: ok(
          initializeResult(steering ? { _meta: { steering: { supported: true } } } : {}),
        ),
        "session/prompt": (message, agent) => {
          release = () => {
            agent.update(message.params.sessionId, text("done"));
            agent.emit({ id: message.id, result: { stopReason: "end_turn" } });
          };
        },
        "_session/steering": ok({ outcome: "injected", queue: "steer" }),
      });

    const supported = setup(handlers(true));
    await expect(supported.responder.steer("too early")).resolves.toBe(false);
    const reply = supported.responder.reply({ instructions: "rules", prompt: "hi" });
    await flush();
    await expect(supported.responder.steer("新消息")).resolves.toBe(true);
    expect(supported.agents[0]!.request("_session/steering")?.params).toEqual({
      sessionId: "ses-new",
      prompt: [{ type: "text", text: "新消息" }],
    });
    release!();
    await reply;

    const unsupported = setup(handlers(false));
    const second = unsupported.responder.reply({ instructions: "rules", prompt: "hi" });
    await flush();
    await expect(unsupported.responder.steer("新消息")).resolves.toBe(false);
    expect(unsupported.agents[0]!.request("_session/steering")).toBeUndefined();
    release!();
    await second;
  });

  it("does not allow overlapping turns", async () => {
    const { responder } = setup(defaultHandlers({ "session/prompt": () => undefined }));

    const first = responder.reply({ instructions: "rules", prompt: "hi" });
    await expect(responder.reply({ instructions: "rules", prompt: "again" })).rejects.toThrow(
      "已有进行中的回合",
    );
    await flush();
    await responder.close();
    await expect(first).rejects.toThrow("TestAgent 已关闭。");
  });
});

describe("AcpResponder extensions used by Gemini CLI and agy", () => {
  const options = [
    { optionId: "yes", kind: "allow_once" },
    { optionId: "no", kind: "reject_once" },
  ];
  const askFor = (toolCall: Record<string, unknown>): Handler =>
    function prompt(message, agent) {
      agent.emit({
        jsonrpc: "2.0",
        id: "p1",
        method: "session/request_permission",
        params: { sessionId: message.params.sessionId, options, toolCall },
      });
      agent.update(message.params.sessionId, text("ok"));
      agent.emit({ id: message.id, result: { stopReason: "end_turn" } });
    };

  it("lets Hive MCP tools through even in read-only mode, but nothing else", async () => {
    const isHiveTool = (toolCall: { name?: string }) => toolCall.name === "mcp_hive_hive_wait";
    const outcome = async (toolCall: Record<string, unknown>, extra = {}) => {
      const { responder, agents } = setup(defaultHandlers({ "session/prompt": askFor(toolCall) }), {
        access: "read-only",
        ...extra,
      });
      await responder.reply({ instructions: "rules", prompt: "hi" });
      return agents[0]!.responseTo("p1")?.result.outcome.optionId;
    };
    expect(await outcome({ kind: "other", name: "mcp_hive_hive_wait" }, { isHiveTool })).toBe(
      "yes",
    );
    expect(await outcome({ kind: "other", name: "mcp_other_tool" }, { isHiveTool })).toBe("no");
    expect(await outcome({ kind: "execute", name: "mcp_hive_hive_wait" })).toBe("no");
  });

  it("switches models with session/set_model when the agent only lists models", async () => {
    const models = {
      currentModelId: "gemini-2.5-pro",
      availableModels: [
        { modelId: "gemini-2.5-pro", name: "Pro" },
        { modelId: "gemini-3-flash", name: "Flash" },
      ],
    };
    const { responder, agents } = setup(
      defaultHandlers({
        "session/new": ok({ sessionId: "ses-new", models }),
        "session/set_model": ok({}),
      }),
    );
    await responder.reply({ instructions: "rules", prompt: "hi", model: "gemini-3-flash" });
    await responder.reply({ instructions: "rules", prompt: "b", threadId: "ses-new" });
    expect(agents[0]!.requests("session/set_model").map((message: any) => message.params)).toEqual([
      { sessionId: "ses-new", modelId: "gemini-3-flash" },
      { sessionId: "ses-new", modelId: "gemini-2.5-pro" },
    ]);
    expect(agents[0]!.requests("session/set_config_option")).toEqual([]);
  });

  it("uses the default model for turns that do not pick one", async () => {
    const configOptions = [
      { id: "model", currentValue: "a", options: [{ value: "a" }, { value: "b" }] },
    ];
    const { responder, agents } = setup(
      defaultHandlers({
        "session/new": ok({ sessionId: "ses-new", configOptions }),
        "session/set_config_option": ok({ configOptions }),
      }),
      { defaultModel: "b" },
    );
    await responder.reply({ instructions: "rules", prompt: "hi" });
    expect(agents[0]!.request("session/set_config_option")?.params).toMatchObject({ value: "b" });
  });

  const authRequired: Handler = (message, agent) =>
    agent.emit({ id: message.id, error: { code: -32000, message: "Authentication required" } });

  it("signs in with the API key when the agent needs auth, and again in a new process", async () => {
    let signedIn = false;
    const handlers = defaultHandlers({
      initialize: ok(
        initializeResult({ authMethods: [{ id: "oauth-personal" }, { id: "gemini-api-key" }] }),
      ),
      authenticate: (message, agent) => {
        signedIn = true;
        agent.emit({ id: message.id, result: {} });
      },
      "session/new": (message, agent) =>
        signedIn
          ? agent.emit({ id: message.id, result: { sessionId: "ses-new" } })
          : authRequired(message, agent),
      "session/resume": (message, agent) =>
        signedIn ? agent.emit({ id: message.id, result: {} }) : authRequired(message, agent),
    });
    const { responder, agents, log } = setup(
      handlers,
      { auth: { hint: "去登录", apiKeyMethod: "gemini-api-key", hasApiKey: true } },
      { idleTimeoutMs: 20 },
    );
    await expect(responder.reply({ instructions: "rules", prompt: "hi" })).resolves.toMatchObject({
      text: "done",
    });
    expect(agents[0]!.methods()).toEqual([
      "initialize",
      "session/new",
      "authenticate",
      "session/new",
      "session/prompt",
    ]);
    expect(agents[0]!.request("authenticate")?.params).toEqual({ methodId: "gemini-api-key" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("API key"));

    // 进程空闲退出后，新进程先登录再恢复会话，不会因为没登录把旧会话当成失效
    await new Promise((resolve) => setTimeout(resolve, 50));
    signedIn = false;
    await expect(
      responder.reply({ instructions: "rules", prompt: "again", threadId: "ses-new" }),
    ).resolves.toMatchObject({ threadId: "ses-new" });
    expect(agents[1]!.methods()).toEqual([
      "initialize",
      "authenticate",
      "session/resume",
      "session/prompt",
    ]);
    await responder.close();
  });

  it("asks people to sign in instead of retrying when there is no API key", async () => {
    const handlers = defaultHandlers({
      initialize: ok(initializeResult({ authMethods: [{ id: "gemini-api-key" }] })),
      "session/new": authRequired,
    });
    const noKey = setup(handlers, {
      label: "agy",
      auth: { hint: "先在终端运行 agy 登录", apiKeyMethod: "gemini-api-key", hasApiKey: false },
    });
    const failure = noKey.responder.reply({ instructions: "rules", prompt: "hi" });
    await expect(failure).rejects.toThrow("agy 还没有登录：先在终端运行 agy 登录");
    await expect(failure).rejects.toBeInstanceOf(AgentNonRetryableError);
    expect(noKey.agents[0]!.methods()).not.toContain("authenticate");

    // 没配置 auth 的 Agent（opencode、omp）：错误原样抛出，行为不变
    const plain = setup(handlers);
    const plainFailure = plain.responder.reply({ instructions: "rules", prompt: "hi" });
    await expect(plainFailure).rejects.toThrow("Authentication required");
    await expect(plainFailure).rejects.not.toBeInstanceOf(AgentNonRetryableError);
  });
});

describe("decideAcpPermission", () => {
  it("allows only read-like tools in read-only mode", () => {
    expect(decideAcpPermission("read-only", "/w", { kind: "read" })).toBe("allow");
    expect(decideAcpPermission("read-only", "/w", { kind: "search" })).toBe("allow");
    expect(decideAcpPermission("read-only", "/w", { kind: "execute" })).toBe("reject");
    expect(
      decideAcpPermission("read-only", "/w", { kind: "edit", locations: [{ path: "/w/a" }] }),
    ).toBe("reject");
    expect(decideAcpPermission("read-only", "/w", {})).toBe("reject");
  });

  it("confines workspace file changes to cwd and fails closed without a path", () => {
    expect(
      decideAcpPermission("workspace", "/w", {
        kind: "edit",
        locations: [{ path: "/w/src/a.ts" }],
      }),
    ).toBe("allow");
    expect(
      decideAcpPermission("workspace", "/w", { kind: "edit", rawInput: { filePath: "src/a.ts" } }),
    ).toBe("allow");
    expect(
      decideAcpPermission("workspace", "/w", {
        kind: "move",
        rawInput: { from: "/w/a", to: "/elsewhere/a" },
      }),
    ).toBe("reject");
    expect(
      decideAcpPermission("workspace", "/w", { kind: "edit", locations: [{ path: "/w-other/a" }] }),
    ).toBe("reject");
    expect(decideAcpPermission("workspace", "/w", { kind: "delete" })).toBe("reject");
    expect(decideAcpPermission("workspace", "/w", { kind: "execute" })).toBe("allow");
  });

  it("allows everything in full mode", () => {
    expect(
      decideAcpPermission("full", "/w", { kind: "delete", locations: [{ path: "/etc/x" }] }),
    ).toBe("allow");
  });

  it("accepts the real path of a symlinked cwd but not its siblings", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "acp-perm-")));
    const real = path.join(root, "real");
    mkdirSync(real);
    symlinkSync(real, path.join(root, "link"));
    const cwd = path.join(root, "link");
    try {
      // Agent 报上来的是真实路径（macOS 的 /tmp → /private/tmp）
      expect(
        decideAcpPermission("workspace", cwd, { kind: "edit", locations: [{ path: `${real}/a` }] }),
      ).toBe("allow");
      expect(
        decideAcpPermission("workspace", cwd, { kind: "edit", locations: [{ path: `${cwd}/a` }] }),
      ).toBe("allow");
      expect(
        decideAcpPermission("workspace", cwd, { kind: "edit", locations: [{ path: `${root}/x` }] }),
      ).toBe("reject");
      expect(
        decideAcpPermission("workspace", "/no/such/dir", {
          kind: "edit",
          locations: [{ path: "/elsewhere/a" }],
        }),
      ).toBe("reject");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe("symlinks inside cwd", () => {
    let root: string;
    let cwd: string;
    let outside: string;
    const edit = (target: string) =>
      decideAcpPermission("workspace", cwd, { kind: "edit", locations: [{ path: target }] });

    beforeEach(() => {
      root = realpathSync(mkdtempSync(path.join(tmpdir(), "acp-link-")));
      cwd = path.join(root, "work");
      outside = path.join(root, "outside");
      mkdirSync(path.join(cwd, "src"), { recursive: true });
      mkdirSync(outside);
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("rejects writes through a link that points outside cwd", () => {
      symlinkSync(outside, path.join(cwd, "escape"));
      writeFileSync(path.join(outside, "secret"), "x");
      expect(edit(path.join(cwd, "escape", "secret"))).toBe("reject");
      expect(edit("escape/new-file")).toBe("reject");
      expect(edit("escape/new/dir/file")).toBe("reject");
      // link/.. 在系统里是链接目标的上一级，不是 cwd
      mkdirSync(path.join(outside, "deep"));
      symlinkSync(path.join(outside, "deep"), path.join(cwd, "deep"));
      expect(edit("deep/../a")).toBe("reject");
      expect(edit("escape/../outside/a")).toBe("reject");
    });

    it("rejects a dangling link whose target would be created outside cwd", () => {
      symlinkSync(path.join(outside, "later"), path.join(cwd, "dangling"));
      symlinkSync("../outside/rel", path.join(cwd, "relative"));
      expect(edit("dangling")).toBe("reject");
      expect(edit("relative")).toBe("reject");
    });

    it("allows links that stay inside cwd", () => {
      symlinkSync(path.join(cwd, "src"), path.join(cwd, "alias"));
      symlinkSync("src", path.join(cwd, "relative-alias"));
      symlinkSync(path.join(cwd, "src", "pending"), path.join(cwd, "dangling-inside"));
      expect(edit("alias/a.ts")).toBe("allow");
      expect(edit(path.join(cwd, "relative-alias", "b.ts"))).toBe("allow");
      expect(edit("dangling-inside")).toBe("allow");
      expect(edit("src/../src/c.ts")).toBe("allow");
    });

    it("allows new nested directories and paths whose parents do not exist yet", () => {
      expect(edit("src/new/deeper/file.ts")).toBe("allow");
      expect(edit(path.join(cwd, "missing", "also-missing", "file.ts"))).toBe("allow");
      // newdir 不存在：mkdir -p 后 newdir/.. 回到 cwd，再经 escape 写到外面
      symlinkSync(outside, path.join(cwd, "escape"));
      expect(edit("newdir/../escape/x")).toBe("reject");
      expect(edit("newdir/../src/x.ts")).toBe("reject");
      expect(edit("newdir/sub/x")).toBe("allow");
      expect(edit("../outside/x")).toBe("reject");
    });

    it("rejects symlink loops instead of throwing", () => {
      symlinkSync(path.join(cwd, "loop-b"), path.join(cwd, "loop-a"));
      symlinkSync(path.join(cwd, "loop-a"), path.join(cwd, "loop-b"));
      symlinkSync("self", path.join(cwd, "self"));
      expect(edit("loop-a/file")).toBe("reject");
      expect(edit("self")).toBe("reject");
      expect(edit("src/ok.ts")).toBe("allow");
    });

    it("treats a symlinked cwd like its real path", () => {
      const link = path.join(root, "work-link");
      symlinkSync(cwd, link);
      expect(
        decideAcpPermission("workspace", link, { kind: "edit", locations: [{ path: `${cwd}/a` }] }),
      ).toBe("allow");
      expect(
        decideAcpPermission("workspace", link, { kind: "edit", rawInput: { filePath: "src/a" } }),
      ).toBe("allow");
      expect(
        decideAcpPermission("workspace", link, {
          kind: "edit",
          locations: [{ path: `${outside}/a` }],
        }),
      ).toBe("reject");
    });
  });

  it("compares Windows paths case-insensitively and rejects other drives", () => {
    expect(isInsideDir("C:\\Work\\Repo", "c:\\work\\repo\\src\\a.ts", path.win32)).toBe(true);
    expect(isInsideDir("C:\\Work\\Repo", "C:\\Work\\Repo", path.win32)).toBe(true);
    expect(isInsideDir("C:\\Work\\Repo", "D:\\Work\\Repo\\a.ts", path.win32)).toBe(false);
    expect(isInsideDir("C:\\Work\\Repo", "C:\\Work\\Repo-other\\a.ts", path.win32)).toBe(false);
    expect(isInsideDir("/w", "/w/a", path.posix)).toBe(true);
    expect(isInsideDir("/w", "/W/a", path.posix)).toBe(false);
  });
});
