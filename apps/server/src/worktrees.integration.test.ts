import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  ChatMessage,
  Invocation,
  ManagedWorktree,
  ServerEvent,
  WorktreeStatus,
} from "@superhive/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { HiveDatabase } from "./database.js";
import { Peer } from "./test-peer.js";
import { worktreeGit } from "./worktrees.js";
import type { SpawnAgent } from "./local-agents.js";

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ text: string }>;
};
const cleanup: Array<() => void | Promise<void>> = [];
async function nextEvent(peer: Peer, label: string, predicate: (event: ServerEvent) => boolean) {
  try {
    return await peer.next(predicate, 5_000);
  } catch {
    throw new Error(`${label}: ${peer.events.map((event) => event.type).join(", ")}`);
  }
}
afterEach(async () => {
  try {
    for (const step of cleanup.splice(0).reverse()) await step();
  } finally {
    vi.useRealTimers();
  }
});

async function start(now?: () => number) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "hive-worktree-mcp-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  const git = async (cwd: string, args: string[]) => {
    const result = await worktreeGit(cwd, args);
    if (result.code) throw new Error(result.stderr);
  };
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@example.invalid"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(repo, "test.txt"), "initial\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  const filename = path.join(root, "db.sqlite");
  const seed = new HiveDatabase(filename);
  seed.updateRoom("general", { workspace: repo });
  for (const [name, access] of [
    ["helper", "full"],
    ["reader", "read-only"],
    ["writer", "workspace"],
  ] as const) {
    seed.createLocalAgent({ name, access, provider: "codex", cwd: repo, model: null });
  }
  seed.close();
  let pid = 9_000_000;
  const spawn: SpawnAgent = () => {
    let exit: ((code: number | null) => void) | undefined;
    return {
      pid: pid++,
      onOutput: () => undefined,
      onExit: (listener) => {
        exit = listener;
      },
      kill: () => exit?.(0),
    };
  };
  const open = () =>
    buildApp({
      databasePath: filename,
      token: "test-token",
      staticDir: "/not-present",
      localAgents: { cli: { command: "fake", args: [] }, serverUrl: "http://127.0.0.1", spawn },
      ...(now ? { now, invocationSweepMs: 20 } : {}),
    });
  let app = await open();
  await app.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(() => app.close());
  let port = (app.server.address() as AddressInfo).port;
  const restart = async () => {
    await app.close();
    app = await open();
    await app.listen({ host: "127.0.0.1", port: 0 });
    port = (app.server.address() as AddressInfo).port;
  };
  const join = async (name: string, type: "human" | "agent", token = "test-token") => {
    const peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
    cleanup.push(() => peer.socket.close());
    peer.send({
      type: "participant.join",
      username: name,
      participantType: type,
      roomId: "general",
      token,
    });
    const joined = await nextEvent(
      peer,
      `join ${name}`,
      (event) => event.type === "room.snapshot" || event.type === "error",
    );
    if (joined.type === "error") throw new Error(joined.message);
    return peer;
  };
  const mcp = async (name: string, headers: Record<string, string> = {}) => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          Authorization: "Bearer test-token",
          "X-Hive-Room": "general",
          "X-Hive-Agent-Name": name,
          ...headers,
        },
      },
    });
    const client = new Client({ name: "worktree-test", version: "1" });
    await client.connect(transport as unknown as Transport);
    cleanup.push(() => client.close());
    return (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args }) as Promise<ToolResult>;
  };
  const run = async (owner: Peer, agent: Peer, name: string, text = "work", observer = owner) => {
    owner.send({
      type: "message.send",
      clientMessageId: `${name}-${Math.random()}`,
      content: `@${name} ${text}`,
    });
    const event = await nextEvent(
      agent,
      `deliver ${name}`,
      (event) => event.type === "agent.mentioned",
    );
    const message = (event as Extract<ServerEvent, { type: "agent.mentioned" }>).message;
    agent.send({ type: "invocation.report", messageId: message.id, status: "running" });
    await nextEvent(
      observer,
      `running ${name}`,
      (event) =>
        event.type === "invocation.updated" &&
        event.invocation.messageId === message.id &&
        event.invocation.status === "running",
    );
    return message;
  };
  const finish = async (owner: Peer, agent: Peer, message: ChatMessage) => {
    agent.send({
      type: "message.send",
      clientMessageId: `reply-${message.id}`,
      content: "done",
      parentMessageId: message.id,
    });
    await nextEvent(
      owner,
      "finished",
      (event) =>
        event.type === "invocation.updated" &&
        event.invocation.messageId === message.id &&
        event.invocation.status === "completed",
    );
  };
  return {
    get app() {
      return app;
    },
    repo,
    git,
    join,
    mcp,
    run,
    finish,
    restart,
  };
}

describe("worktree MCP permissions and bindings", () => {
  it("keeps an unfinished waiting turn's workspace valid and the finished question answerable after delay, restart and unrelated work", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = await start(Date.now);
    let owner = await fixture.join("Alice", "human");
    let helper = await fixture.join("helper", "agent");
    const trigger = await fixture.run(owner, helper, "helper");
    const call = await fixture.mcp("helper");
    const created = await call("hive_worktree_create", { slug: "waiting" });
    const worktree = created.structuredContent!.worktree as ManagedWorktree;
    const headers = {
      authorization: "Bearer test-token",
      "x-hive-room": "general",
      "x-hive-agent-name": "helper",
    };
    const validate = async (expected: number) => {
      const single = await fixture.app.inject({
        url: `/api/agent/worktree?messageId=${trigger.id}`,
        headers,
      });
      const batch = await fixture.app.inject({
        method: "POST",
        url: "/api/agent/worktree",
        headers,
        payload: { messageIds: [trigger.id] },
      });
      expect(single.statusCode).toBe(expected);
      expect(batch.statusCode).toBe(expected);
      if (expected === 200) {
        expect(single.json().worktree.path).toBe(worktree.path);
        expect(batch.json().worktrees[trigger.id].path).toBe(worktree.path);
      }
    };
    await validate(200);
    const asked = await call("hive_ask_human", { question: "继续吗？", options: ["继续", "停止"] });
    const questionId = asked.structuredContent!.questionMessageId as string;
    const invocationId = asked.structuredContent!.invocationId as string;
    await nextEvent(
      owner,
      "waiting",
      (event) =>
        event.type === "invocation.updated" &&
        event.invocation.id === invocationId &&
        event.invocation.status === "waiting_human",
    );
    await validate(200);
    helper.send({ type: "invocation.report", messageId: trigger.id, status: "running" });
    await validate(200);
    vi.setSystemTime(Date.now() + 30 * 60_000);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await validate(200);
    await fixture.join("reader", "agent");
    for (const restricted of [
      { ...headers, "x-forwarded-for": "203.0.113.1" },
      { ...headers, "x-hive-agent-name": "reader" },
    ]) {
      expect(
        (
          await fixture.app.inject({
            method: "POST",
            url: "/api/agent/worktree",
            headers: restricted,
            payload: { messageIds: [trigger.id] },
          })
        ).statusCode,
      ).toBe(403);
    }
    helper.send({ type: "invocation.report", messageId: trigger.id, status: "completed" });
    await nextEvent(
      owner,
      "waiting turn finished",
      (event) =>
        event.type === "invocation.updated" &&
        event.invocation.id === invocationId &&
        Boolean(event.invocation.finishedAt),
    );
    await validate(409);
    vi.setSystemTime(Date.now() + 30 * 60_000);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await fixture.restart();
    owner = await fixture.join("Alice", "human");
    helper = await fixture.join("helper", "agent");
    const unrelated = await fixture.run(owner, helper, "helper", "different task");
    const mixed = await fixture.app.inject({
      method: "POST",
      url: "/api/agent/worktree",
      headers,
      payload: { messageIds: [unrelated.id, trigger.id] },
    });
    expect(mixed.statusCode).toBe(409);
    const inventory = await fixture.app.inject({ url: "/api/rooms/general/invocations", headers });
    expect(
      inventory.json().invocations.find((item: Invocation) => item.id === invocationId),
    ).toMatchObject({ status: "waiting_human", finishedAt: expect.any(String) });
    await fixture.finish(owner, helper, unrelated);
    owner.send({
      type: "question.answer",
      clientMessageId: "answer-waiting",
      questionMessageId: questionId,
      selected: ["A"],
    });
    const woken = await nextEvent(
      helper,
      "answer wakes helper",
      (event) =>
        event.type === "agent.mentioned" && event.message.answer?.questionMessageId === questionId,
    );
    if (woken.type !== "agent.mentioned") throw new Error("No answer wakeup");
    await nextEvent(
      owner,
      "old wait completed",
      (event) =>
        event.type === "invocation.updated" &&
        event.invocation.id === invocationId &&
        event.invocation.status === "completed",
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    const answerInventory = await fixture.app.inject({
      url: "/api/rooms/general/invocations",
      headers,
    });
    expect(
      answerInventory
        .json()
        .invocations.find((item: Invocation) => item.messageId === woken.message.id),
    ).toMatchObject({ status: "queued" });
    const answerWorkspace = await fixture.app.inject({
      url: `/api/agent/worktree?messageId=${woken.message.id}`,
      headers,
    });
    expect(answerWorkspace.statusCode).toBe(200);
    expect(answerWorkspace.json().worktree.path).toBe(worktree.path);
    const answerBatch = await fixture.app.inject({
      method: "POST",
      url: "/api/agent/worktree",
      headers,
      payload: { messageIds: [woken.message.id] },
    });
    expect(answerBatch.statusCode).toBe(200);
    expect(answerBatch.json().worktrees[woken.message.id].path).toBe(worktree.path);
    owner.send({
      type: "question.answer",
      clientMessageId: "duplicate-answer",
      questionMessageId: questionId,
      selected: ["B"],
    });
    const duplicate = await nextEvent(
      owner,
      "duplicate rejected",
      (event) => event.type === "error",
    );
    expect(duplicate.type === "error" && duplicate.code).toBe("QUESTION_CLOSED");
  }, 15_000);

  it.each(["failed", "cancelled"] as const)(
    "rejects workspace execution and answers after a waiting turn is %s",
    async (status) => {
      const { app, join, mcp, run } = await start();
      const owner = await join("Alice", "human");
      const helper = await join("helper", "agent");
      const trigger = await run(owner, helper, "helper");
      const call = await mcp("helper");
      const asked = await call("hive_ask_human", {
        question: "继续吗？",
        options: ["继续", "停止"],
      });
      const invocationId = asked.structuredContent!.invocationId as string;
      if (status === "cancelled") {
        owner.send({ type: "invocation.cancel", invocationId });
        await nextEvent(
          owner,
          "cancelling",
          (event) =>
            event.type === "invocation.updated" &&
            event.invocation.id === invocationId &&
            event.invocation.status === "cancelling",
        );
      }
      helper.send({ type: "invocation.report", messageId: trigger.id, status });
      await nextEvent(
        owner,
        "terminal waiting",
        (event) =>
          event.type === "invocation.updated" &&
          event.invocation.id === invocationId &&
          event.invocation.status === status,
      );
      const headers = {
        authorization: "Bearer test-token",
        "x-hive-room": "general",
        "x-hive-agent-name": "helper",
      };
      expect(
        (await app.inject({ url: `/api/agent/worktree?messageId=${trigger.id}`, headers }))
          .statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/agent/worktree",
            headers,
            payload: { messageIds: [trigger.id] },
          })
        ).statusCode,
      ).toBe(409);
      owner.send({
        type: "question.answer",
        clientMessageId: "closed-answer",
        questionMessageId: asked.structuredContent!.questionMessageId,
        selected: ["A"],
      });
      const closed = await nextEvent(owner, "closed question", (event) => event.type === "error");
      expect(closed.type === "error" && closed.code).toBe("QUESTION_CLOSED");
    },
  );
  it("finishes a bound wakeup only after a vanished checkout is verified and keeps unrelated work runnable", async () => {
    const { app, repo, git, join, mcp, run, finish } = await start();
    const owner = await join("Alice", "human");
    const helper = await join("helper", "agent");
    const initial = await run(owner, helper, "helper");
    const call = await mcp("helper");
    const created = await call("hive_worktree_create", { slug: "vanished" });
    const worktree = created.structuredContent!.worktree as ManagedWorktree;
    const pending = await run(owner, helper, "helper", "followup");
    const headers = {
      authorization: "Bearer test-token",
      "x-hive-room": "general",
      "x-hive-agent-name": "helper",
    };
    const url = `/api/agent/worktree?messageId=${pending.id}`;
    expect((await app.inject({ url, headers })).statusCode).toBe(200);
    await finish(owner, helper, initial);
    await git(repo, ["worktree", "remove", worktree.path]);
    const refused = await app.inject({ url, headers });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "WORKTREE_IDENTITY", error: expect.any(String) });
    await git(repo, ["branch", "-d", worktree.branch]);
    const removed = await app.inject({ url, headers });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().worktree).toMatchObject({ id: worktree.id, removed: true });
    helper.send({
      type: "invocation.report",
      messageId: pending.id,
      status: "completed",
      detailText: { key: "bridge.worktreeCleaned", params: { path: worktree.path } },
    });
    const resolved = await nextEvent(
      owner,
      "cleaned workspace resolved",
      (event) =>
        event.type === "invocation.updated" &&
        event.invocation.messageId === pending.id &&
        event.invocation.resolution?.kind === "superseded",
    );
    expect(resolved.type === "invocation.updated" && resolved.invocation.status).toBe("completed");
    expect(
      resolved.type === "invocation.updated" && resolved.invocation.resolution?.noteText?.key,
    ).toBe("bridge.worktreeCleaned");
    const next = await run(owner, helper, "helper", "new work");
    const unbound = await app.inject({
      method: "POST",
      url: "/api/agent/worktree",
      headers,
      payload: { messageIds: [next.id] },
    });
    expect(unbound.json()).toEqual({ worktrees: { [next.id]: null } });
    helper.send({
      type: "invocation.report",
      messageId: next.id,
      status: "completed",
      detailText: { key: "bridge.worktreeCleaned", params: { path: worktree.path } },
    });
    const unrelated = await nextEvent(
      owner,
      "unrelated completed",
      (event) =>
        event.type === "invocation.updated" &&
        event.invocation.messageId === next.id &&
        event.invocation.status === "completed",
    );
    expect(
      unrelated.type === "invocation.updated" && unrelated.invocation.resolution,
    ).toBeUndefined();
  }, 15_000);

  it("lets the safe remove tool release a vanished registration and reuse the same slug", async () => {
    const { app, repo, git, join, mcp, run, finish } = await start();
    const owner = await join("Alice", "human");
    const helper = await join("helper", "agent");
    const initial = await run(owner, helper, "helper");
    const call = await mcp("helper");
    const created = await call("hive_worktree_create", { slug: "gone" });
    const worktree = created.structuredContent!.worktree as ManagedWorktree;
    await finish(owner, helper, initial);
    await git(repo, ["worktree", "remove", worktree.path]);
    await git(repo, ["branch", "-d", worktree.branch]);
    const next = await run(owner, helper, "helper", "cleanup");
    expect(
      (await call("hive_worktree_remove", { path: worktree.path })).structuredContent,
    ).toMatchObject({ removed: true, branchDeleted: true });
    const headers = {
      authorization: "Bearer test-token",
      "x-hive-room": "general",
      "x-hive-agent-name": "helper",
    };
    expect(
      (await app.inject({ url: `/api/agent/worktree?messageId=${next.id}`, headers })).json(),
    ).toEqual({ worktree: null });
    expect((await call("hive_worktree_create", { slug: "gone" })).structuredContent).toMatchObject({
      reused: false,
    });
  }, 15_000);

  it("resolves several local task bindings together without weakening authorization", async () => {
    const { app, join, mcp, run, finish } = await start();
    const owner = await join("Alice", "human");
    const helper = await join("helper", "agent");
    const first = await run(owner, helper, "helper");
    const second = await run(owner, helper, "helper");
    const headers = {
      authorization: "Bearer test-token",
      "x-hive-room": "general",
      "x-hive-agent-name": "helper",
    };
    const payload = { messageIds: [first.id, second.id] };
    const unbound = await app.inject({
      method: "POST",
      url: "/api/agent/worktree",
      headers,
      payload,
    });
    expect(unbound.statusCode).toBe(200);
    expect(unbound.json()).toEqual({ worktrees: { [first.id]: null, [second.id]: null } });
    const call = await mcp("helper");
    const created = await call("hive_worktree_create", { slug: "batch" });
    const worktree = created.structuredContent!.worktree as ManagedWorktree;
    const selected = await app.inject({
      method: "POST",
      url: "/api/agent/worktree",
      headers,
      payload,
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json().worktrees).toMatchObject({
      [first.id]: { path: worktree.path, agentName: "helper" },
      [second.id]: { path: worktree.path, agentName: "helper" },
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/agent/worktree",
          headers: { ...headers, "x-forwarded-for": "203.0.113.1" },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/agent/worktree",
          headers: { ...headers, "x-hive-agent-name": "writer" },
          payload,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/agent/worktree",
          headers,
          payload: { messageIds: [] },
        })
      ).statusCode,
    ).toBe(400);
    await finish(owner, helper, first);
    expect(
      (await app.inject({ method: "POST", url: "/api/agent/worktree", headers, payload }))
        .statusCode,
    ).toBe(409);
  });

  it("handles a task line whose branch was switched inside its checkout end to end", async () => {
    const { app, git, join, mcp, run, finish } = await start();
    const owner = await join("Alice", "human");
    const helper = await join("helper", "agent");
    const headers = {
      authorization: "Bearer test-token",
      "x-hive-room": "general",
      "x-hive-agent-name": "helper",
    };
    const session = (await app.inject({ method: "GET", url: "/api/local/session" })).json();
    const ownerHeaders = { "x-hive-owner": session.ownerToken };
    const lookup = (messageIds: string[]) =>
      app.inject({ method: "POST", url: "/api/agent/worktree", headers, payload: { messageIds } });
    const inventory = async () =>
      (await app.inject({ url: "/api/local/worktrees/general", headers: ownerHeaders })).json()
        .worktrees[0];
    const repair = (id: string, action: "restore" | "adopt") =>
      app.inject({
        method: "POST",
        url: `/api/local/worktrees/general/items/${id}/repair`,
        headers: ownerHeaders,
        payload: { action },
      });

    // 今晚的现场：建任务线 → Agent 在里面直接 checkout 新分支去做下一件事
    const first = await run(owner, helper, "helper", "slow ops");
    const call = await mcp("helper");
    const created = await call("hive_worktree_create", { slug: "slow-ops" });
    const worktree = created.structuredContent!.worktree as ManagedWorktree;
    await git(worktree.path, ["switch", "-c", "feat/helper-card-tiers"]);

    // 再查绑定的任务：拒绝，错误码和原因都在（Bridge 据此写进卡片）
    const bound = await lookup([first.id]);
    expect(bound.statusCode).toBe(403);
    expect(bound.json()).toMatchObject({ code: "WORKTREE_IDENTITY" });
    expect(bound.json().error).toContain(
      `登记的分支是 ${worktree.branch}，现在却在 feat/helper-card-tiers`,
    );
    await finish(owner, helper, first);

    // 再派新任务：不再卡死，也不静默：worktree 为空并带上说明
    const second = await run(owner, helper, "helper", "card tiers");
    const fresh = await lookup([second.id]);
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json()).toEqual({
      worktrees: { [second.id]: null },
      notices: {
        [second.id]: {
          kind: "focus_dropped",
          path: worktree.path,
          reason: expect.stringContaining("现在却在 feat/helper-card-tiers"),
        },
      },
    });
    const single = await app.inject({
      url: `/api/agent/worktree?messageId=${second.id}`,
      headers,
    });
    expect(single.json()).toEqual({ worktree: null });

    // 复用 slug：拒绝并说明怎么办
    const reused = await call("hive_worktree_create", { slug: "slow-ops" });
    expect(reused.isError).toBe(true);
    expect(reused.content[0]?.text).toContain("slug slow-ops 的任务目录");
    expect(reused.content[0]?.text).toContain("新的 slug");
    await finish(owner, helper, second);

    // 白板标阻塞；列表标换分支；登记的分支早已在 main 里，但清理扫描不碰
    const entry = (
      await app.inject({
        url: "/api/rooms/general/whiteboard",
        headers: { authorization: "Bearer test-token" },
      })
    ).json();
    const boardEntry = (entry.entries ?? entry).find(
      (item: { key: string }) => item.key === `worktree:${worktree.id}`,
    );
    expect(boardEntry).toMatchObject({ slot: "blocked" });
    expect(boardEntry.summary).toContain(
      `分支已被切换：登记 ${worktree.branch}，当前 feat/helper-card-tiers`,
    );
    expect(await inventory()).toMatchObject({
      removable: false,
      branchSwitched: { registered: worktree.branch, current: "feat/helper-card-tiers" },
    });
    await (app as unknown as { runWorktreeCleanup(): Promise<void> }).runWorktreeCleanup();
    expect(owner.events.some((event) => event.type === "worktree.cleanup")).toBe(false);
    expect(existsSync(worktree.path)).toBe(true);

    // 房主操作：要管理权限；有未跟踪文件不能切回；干净后切回，白板恢复，绑定任务能再开工
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/local/worktrees/general/items/${worktree.id}/repair`,
          headers: { authorization: "Bearer test-token" },
          payload: { action: "restore" },
        })
      ).statusCode,
    ).toBe(401);
    writeFileSync(path.join(worktree.path, "draft.txt"), "draft\n");
    const dirty = await repair(worktree.id, "restore");
    expect(dirty.statusCode).toBe(409);
    expect(dirty.json()).toMatchObject({ code: "WORKTREE_DIRTY" });
    rmSync(path.join(worktree.path, "draft.txt"));
    const restored = await repair(worktree.id, "restore");
    expect(restored.statusCode).toBe(200);
    expect(restored.json().worktree.branchSwitched).toBeUndefined();
    expect(await inventory()).not.toHaveProperty("branchSwitched");

    // 再切一次，这次按当前分支重新登记
    await git(worktree.path, ["switch", "-c", "feat/helper-renamed"]);
    const third = await run(owner, helper, "helper", "continue");
    const reuseAfter = await call("hive_worktree_create", { slug: "slow-ops" });
    expect(reuseAfter.isError).toBe(true);
    await finish(owner, helper, third);
    const adopted = await repair(worktree.id, "adopt");
    expect(adopted.statusCode).toBe(200);
    expect(adopted.json().worktree.worktree.branch).toBe("feat/helper-renamed");
    expect((await repair(worktree.id, "adopt")).json()).toMatchObject({
      code: "WORKTREE_NOT_SWITCHED",
    });
    const fourth = await run(owner, helper, "helper", "continue on the renamed line");
    const continued = await call("hive_worktree_create", { slug: "slow-ops" });
    expect(continued.isError).toBeFalsy();
    expect(continued.structuredContent).toMatchObject({
      reused: true,
      worktree: { branch: "feat/helper-renamed", path: worktree.path },
    });
    expect((await lookup([fourth.id])).json().worktrees[fourth.id]).toMatchObject({
      id: worktree.id,
      branch: "feat/helper-renamed",
    });
  }, 30_000);

  it("notifies only the owner, requires owner/device management auth and batch-cleans safely", async () => {
    const { app, repo, git, join, mcp, run, finish } = await start();
    const owner = await join("Alice", "human");
    const helper = await join("helper", "agent");
    const task = await run(owner, helper, "helper");
    const call = await mcp("helper");
    const created = await call("hive_worktree_create", { slug: "cleanup" });
    const worktree = created.structuredContent!.worktree as ManagedWorktree;
    // 登记时记下正在处理的消息；分支还停在起点（没有提交）时扫描不当成已合入
    const delivered = await call("hive_board_update", {
      key: "feature",
      slot: "ready",
      summary: "功能做完了，等 review",
      branch: worktree.branch,
    });
    expect(delivered.structuredContent).toMatchObject({
      entry: { slot: "ready", messageId: task.id, messageSeq: task.seq },
    });
    await (app as unknown as { runWorktreeCleanup(): Promise<void> }).runWorktreeCleanup();
    const unchanged = (
      await app.inject({
        url: "/api/rooms/general/whiteboard",
        headers: { authorization: "Bearer test-token" },
      })
    ).json() as { entries: Array<{ key: string; slot: string }> };
    expect(unchanged.entries.find((item) => item.key === "feature")?.slot).toBe("ready");
    writeFileSync(path.join(worktree.path, "test.txt"), "feature\n");
    await git(worktree.path, ["add", "."]);
    await git(worktree.path, ["commit", "-m", "feature"]);
    await git(repo, ["merge", "--ff-only", worktree.branch]);
    await finish(owner, helper, task);
    await (app as unknown as { runWorktreeCleanup(): Promise<void> }).runWorktreeCleanup();
    const board = (
      await app.inject({
        url: "/api/rooms/general/whiteboard",
        headers: { authorization: "Bearer test-token" },
      })
    ).json() as { entries: Array<{ key: string; slot: string; mergedAt?: string }> };
    expect(board.entries.find((item) => item.key === "feature")).toMatchObject({
      slot: "milestone",
      mergedAt: expect.any(String),
    });
    const notice = await owner.next((event) => event.type === "worktree.cleanup");
    expect(notice).toMatchObject({ type: "worktree.cleanup", count: 1, state: "available" });
    if (notice.type !== "worktree.cleanup") throw new Error("Missing cleanup notice");
    expect(helper.events.some((event) => event.type === "worktree.cleanup")).toBe(false);
    const session = (await app.inject({ method: "GET", url: "/api/local/session" })).json();
    const ownerHeaders = { "x-hive-owner": session.ownerToken };
    const inventory = await app.inject({
      method: "GET",
      url: "/api/local/worktrees/general",
      headers: ownerHeaders,
    });
    expect(inventory.statusCode).toBe(200);
    const item = inventory.json().worktrees[0];
    expect(item).toMatchObject({ removable: true, merged: true, headCommit: expect.any(String) });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/local/worktrees/general/cleanup",
          headers: { authorization: "Bearer test-token" },
          payload: { items: [{ id: worktree.id, headCommit: item.headCommit }] },
        })
      ).statusCode,
    ).toBe(401);
    const cleaned = await app.inject({
      method: "POST",
      url: "/api/local/worktrees/general/cleanup",
      headers: ownerHeaders,
      payload: { items: [{ id: worktree.id, headCommit: item.headCommit }], deleteBranch: true },
    });
    expect(cleaned.statusCode).toBe(200);
    expect(cleaned.json().results).toMatchObject([{ removed: true, branchDeleted: true }]);
    await nextEvent(
      owner,
      "expired cleanup banner",
      (event) =>
        event.type === "worktree.cleanup" &&
        event.state === "expired" &&
        event.batchId === notice.batchId,
    );
    const refreshed = await app.inject({
      url: "/api/local/worktrees/general",
      headers: ownerHeaders,
    });
    expect(refreshed.json().cleanupBatch).toBeNull();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/local/worktrees/general/batches/${notice.batchId}`,
          headers: ownerHeaders,
        })
      ).statusCode,
    ).toBe(409);
  }, 15_000);

  it("creates, reuses, reports occupancy and removes only after the original task finishes", async () => {
    const { repo, git, join, mcp, run, finish } = await start();
    const owner = await join("Alice", "human");
    const helper = await join("helper", "agent");
    const call = await mcp("helper");
    expect((await call("hive_worktree_create", { slug: "feature" })).isError).toBe(true);
    const task = await run(owner, helper, "helper");
    const created = await call("hive_worktree_create", { slug: "feature" });
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent?.requiresWorkspaceApproval).toBe(false);
    const worktree = created.structuredContent!.worktree as ManagedWorktree;
    expect(
      (await call("hive_worktree_create", { slug: "feature" })).structuredContent?.reused,
    ).toBe(true);
    const conflict = await call("hive_board_update", {
      key: "another-claim",
      slot: "in_progress",
      summary: "different entry",
      claim: { repo: worktree.path, branch: worktree.branch },
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.content[0]?.text).toContain(worktree.branch);
    const board = await owner.next(
      (event) =>
        event.type === "whiteboard.updated" && event.entry.key === `worktree:${worktree.id}`,
    );
    expect(board.type === "whiteboard.updated" && board.entry.claim?.branch).toBe(worktree.branch);
    writeFileSync(path.join(worktree.path, "test.txt"), "changed\n");
    await git(worktree.path, ["add", "."]);
    await git(worktree.path, ["commit", "-m", "feature"]);
    await git(repo, ["merge", "--ff-only", worktree.branch]);
    const listed = await call("hive_worktree_list");
    expect(listed.structuredContent?.worktrees).toMatchObject([
      { merged: true, removable: false, activeInvocationIds: expect.any(Array) },
    ]);
    expect((await call("hive_worktree_remove", { path: worktree.path })).isError).toBe(true);
    await finish(owner, helper, task);
    await run(owner, helper, "helper", "clean the merged worktree");
    const removed = await call("hive_worktree_remove", { path: worktree.path });
    expect(removed.isError).toBeFalsy();
    expect(removed.structuredContent).toMatchObject({ removed: true, branchDeleted: true });
  }, 15_000);

  it("counts only the owning agent's follow-up turns as occupying a task line, not work delegated to another agent", async () => {
    const { app, join, mcp, run, finish } = await start();
    const owner = await join("Alice", "human");
    const helper = await join("helper", "agent");
    const writer = await join("writer", "agent");
    const call = await mcp("helper");
    const task = await run(owner, helper, "helper");
    const worktree = (await call("hive_worktree_create", { slug: "feature" })).structuredContent!
      .worktree as ManagedWorktree;
    const session = (await app.inject({ method: "GET", url: "/api/local/session" })).json();
    const active = async () =>
      (
        (
          await app.inject({
            url: "/api/local/worktrees/general",
            headers: { "x-hive-owner": session.ownerToken },
          })
        ).json().worktrees as WorktreeStatus[]
      ).find((item) => item.worktree.id === worktree.id)!.activeInvocationIds;
    const delegated = await call("hive_invoke", { agent: "writer", task: "review it" });
    expect(delegated.isError).toBeFalsy();
    const mention = await nextEvent(
      writer,
      "deliver writer",
      (event) => event.type === "agent.mentioned",
    );
    const child = (mention as Extract<ServerEvent, { type: "agent.mentioned" }>).message;
    writer.send({ type: "invocation.report", messageId: child.id, status: "running" });
    await nextEvent(
      owner,
      "writer running",
      (event) =>
        event.type === "invocation.updated" &&
        event.invocation.messageId === child.id &&
        event.invocation.status === "running",
    );
    await finish(owner, helper, task);
    // 上游那一轮已结束，委派给 writer 的调用还在跑：它不用 helper 的任务目录，不算占用
    expect(await active()).toEqual([]);
    await finish(owner, writer, child);
    // writer 做完后回执唤醒 helper 接着做，这一轮是 helper 自己的后续调用，照旧算占用
    const receipt = await nextEvent(
      helper,
      "deliver receipt",
      (event) => event.type === "agent.mentioned",
    );
    const followUp = (receipt as Extract<ServerEvent, { type: "agent.mentioned" }>).message;
    helper.send({ type: "invocation.report", messageId: followUp.id, status: "running" });
    await nextEvent(
      owner,
      "receipt running",
      (event) =>
        event.type === "invocation.updated" &&
        event.invocation.messageId === followUp.id &&
        event.invocation.status === "running",
    );
    const occupying = await active();
    expect(occupying).toHaveLength(1);
    expect(occupying).not.toContain(task.id);
    await finish(owner, helper, followUp);
    expect(await active()).toEqual([]);
  }, 20_000);

  it("rejects readonly, unconfigured and proxied agents and explicitly marks workspace scope", async () => {
    const { app, join, mcp, run } = await start();
    const owner = await join("Alice", "human");
    for (const name of ["reader", "remote", "writer", "helper"]) {
      const peer = await join(name, "agent");
      const task = await run(owner, peer, name);
      const resolved = await app.inject({
        method: "GET",
        url: `/api/agent/worktree?messageId=${task.id}`,
        headers: {
          authorization: "Bearer test-token",
          "x-hive-room": "general",
          "x-hive-agent-name": name,
        },
      });
      expect(resolved.statusCode).toBe(["writer", "helper"].includes(name) ? 200 : 403);
      const call = await mcp(name, name === "helper" ? { "x-forwarded-for": "203.0.113.1" } : {});
      const created = await call("hive_worktree_create", { slug: "feature" });
      if (name === "writer") {
        expect(created.isError).toBeFalsy();
        expect(created.structuredContent?.requiresWorkspaceApproval).toBe(false);
        expect(created.structuredContent?.runtimeHandoff).toContain("new session");
      } else {
        expect(created.isError).toBe(true);
        expect(created.content[0]?.text).toContain("本机房主");
      }
    }
  });

  it("requires a fresh handoff capability after a local agent reconnects", async () => {
    const { app, join, mcp, run, finish } = await start();
    const owner = await join("Alice", "human");
    const writer = await join("writer", "agent");
    const headers = {
      authorization: "Bearer test-token",
      "x-hive-room": "general",
      "x-hive-agent-name": "writer",
    };
    const initial = await run(owner, writer, "writer");
    expect(
      (await app.inject({ url: `/api/agent/worktree?messageId=${initial.id}`, headers }))
        .statusCode,
    ).toBe(200);
    const call = await mcp("writer");
    expect((await call("hive_worktree_create", { slug: "feature" })).isError).toBeFalsy();
    await finish(owner, writer, initial);
    writer.socket.close();
    await nextEvent(
      owner,
      "writer disconnected",
      (event) =>
        event.type === "presence.changed" &&
        event.participant.username === "writer" &&
        event.participant.status === "offline",
    );
    const reconnected = await join("writer", "agent");
    const next = await run(owner, reconnected, "writer");
    const blocked = await call("hive_worktree_create", { slug: "feature" });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0]?.text).toContain("安全目录交接");
    expect(
      (await app.inject({ url: `/api/agent/worktree?messageId=${next.id}`, headers })).statusCode,
    ).toBe(200);
    expect((await call("hive_worktree_create", { slug: "feature" })).isError).toBeFalsy();
  });

  it("rejects a guest-origin task even when it targets a writable local agent", async () => {
    const { app, join, mcp } = await start();
    const owner = await join("Alice", "human");
    const helper = await join("helper", "agent");
    const invite = (
      await app.inject({
        method: "POST",
        url: "/api/rooms/general/invites",
        headers: { authorization: "Bearer test-token" },
        payload: { expiresInMinutes: 60, allowAgents: false },
      })
    ).json() as { token: string };
    const redeemed = (
      await app.inject({
        method: "POST",
        url: "/api/invites/redeem",
        payload: { token: invite.token, username: "Guest" },
      })
    ).json() as { token: string };
    const guest = await join("Guest", "human", redeemed.token);
    guest.send({ type: "message.send", clientMessageId: "guest-work", content: "@helper work" });
    const blocked = await nextEvent(
      owner,
      "guest approval",
      (event) => event.type === "invocation.updated" && event.invocation.status === "blocked",
    );
    if (blocked.type !== "invocation.updated") throw new Error("No guest approval");
    expect(blocked.invocation.blockReason).toBe("guest_approval");
    owner.send({ type: "invocation.retry", invocationId: blocked.invocation.id });
    const mentioned = await nextEvent(
      helper,
      "approved guest delivery",
      (event) => event.type === "agent.mentioned",
    );
    if (mentioned.type !== "agent.mentioned") throw new Error("No task");
    helper.send({ type: "invocation.report", messageId: mentioned.message.id, status: "running" });
    await nextEvent(
      owner,
      "approved guest running",
      (event) => event.type === "invocation.updated" && event.invocation.status === "running",
    );
    const call = await mcp("helper");
    const created = await call("hive_worktree_create", { slug: "feature" });
    expect(created.isError).toBe(true);
    expect(created.content[0]?.text).toContain("房主本人");
    expect((await call("hive_worktree_remove", { path: "/unregistered" })).isError).toBe(true);
    const guestAgent = (
      await app.inject({
        method: "POST",
        url: "/api/guest-agents",
        headers: { authorization: `Bearer ${redeemed.token}` },
        payload: { username: "guest-bot" },
      })
    ).json() as { token: string };
    await join("guest-bot", "agent", guestAgent.token);
    const guestCall = await mcp("guest-bot", { Authorization: `Bearer ${guestAgent.token}` });
    expect((await guestCall("hive_worktree_list")).isError).toBe(true);
    expect((await guestCall("hive_worktree_create", { slug: "feature" })).isError).toBe(true);
  }, 15_000);
});
