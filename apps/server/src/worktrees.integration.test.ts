import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ChatMessage, ManagedWorktree, ServerEvent } from "@superhive/protocol";
import { afterEach, describe, expect, it } from "vitest";
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
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function start() {
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
  const app = await buildApp({
    databasePath: filename,
    token: "test-token",
    staticDir: "/not-present",
    localAgents: { cli: { command: "fake", args: [] }, serverUrl: "http://127.0.0.1", spawn },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(() => app.close());
  const port = (app.server.address() as AddressInfo).port;
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
  return { app, repo, git, join, mcp, run, finish };
}

describe("worktree MCP permissions and bindings", () => {
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

  it("notifies only the owner, requires owner/device management auth and batch-cleans safely", async () => {
    const { app, repo, git, join, mcp, run, finish } = await start();
    const owner = await join("Alice", "human");
    const helper = await join("helper", "agent");
    const task = await run(owner, helper, "helper");
    const created = await (await mcp("helper"))("hive_worktree_create", { slug: "cleanup" });
    const worktree = created.structuredContent!.worktree as ManagedWorktree;
    writeFileSync(path.join(worktree.path, "test.txt"), "feature\n");
    await git(worktree.path, ["add", "."]);
    await git(worktree.path, ["commit", "-m", "feature"]);
    await git(repo, ["merge", "--ff-only", worktree.branch]);
    await finish(owner, helper, task);
    await (app as unknown as { runWorktreeCleanup(): Promise<void> }).runWorktreeCleanup();
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
