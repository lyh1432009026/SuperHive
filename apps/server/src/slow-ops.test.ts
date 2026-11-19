import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SlowOperationsResponse } from "@superhive/protocol";
import { buildApp } from "./app.js";
import { HiveDatabase } from "./database.js";
import { createHiveMcpServer, type HiveMcpContext } from "./hive-mcp.js";
import {
  DEFAULT_SLOW_OPS,
  SlowOps,
  gitOperationName,
  slowOps,
  slowOpsSettingsFromEnv,
} from "./slow-ops.js";
import { WorktreeManager, worktreeGit } from "./worktrees.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("slow operation recorder", () => {
  it("records only operations at or over the threshold, newest first, up to capacity", () => {
    const warnings: Array<Record<string, unknown>> = [];
    const recorder = new SlowOps();
    recorder.configure(
      { thresholdMs: 100, requestThresholdMs: 500, capacity: 2 },
      { warn: (object) => warnings.push(object) },
    );
    expect(recorder.record({ kind: "git", name: "git status", durationMs: 99 })).toBe(false);
    expect(recorder.record({ kind: "git", name: "git status", durationMs: 100.4 })).toBe(true);
    // 锁按排队 + 持有合计判断
    expect(
      recorder.record({ kind: "lock", name: "worktrees.lock create", waitMs: 80, durationMs: 30 }),
    ).toBe(true);
    // HTTP 请求用单独的阈值
    expect(recorder.record({ kind: "request", name: "GET /api/rooms", durationMs: 300 })).toBe(
      false,
    );
    expect(recorder.record({ kind: "request", name: "GET /api/rooms", durationMs: 600 })).toBe(
      true,
    );
    const { operations, thresholdMs, requestThresholdMs, capacity } = recorder.list();
    expect({ thresholdMs, requestThresholdMs, capacity }).toEqual({
      thresholdMs: 100,
      requestThresholdMs: 500,
      capacity: 2,
    });
    expect(operations.map((item) => item.name)).toEqual([
      "GET /api/rooms",
      "worktrees.lock create",
    ]);
    expect(operations[1]).toMatchObject({ waitMs: 80, durationMs: 30 });
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatchObject({ slowOp: { name: "git status", durationMs: 100 } });
  });

  it("tags nested operations with the enclosing source and records failures", async () => {
    const recorder = new SlowOps();
    recorder.configure({ thresholdMs: 0 });
    await recorder.within({ source: "GET /api/rooms/:roomId/workspace", roomId: "general" }, () =>
      recorder.track("workspace.overviewDetail", {}, async () => {
        recorder.record({ kind: "git", name: "git log", durationMs: 1 });
      }),
    );
    await expect(
      recorder.track("worktrees.list", { repo: "/repo" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const [failed, outer, inner] = recorder.list().operations;
    expect(inner).toMatchObject({
      name: "git log",
      source: "workspace.overviewDetail",
      roomId: "general",
    });
    expect(outer).toMatchObject({
      name: "workspace.overviewDetail",
      source: "GET /api/rooms/:roomId/workspace",
      roomId: "general",
    });
    expect(failed).toMatchObject({ name: "worktrees.list", repo: "/repo", failed: true });
    expect(failed!.source).toBeUndefined();
  });

  it("names git calls by subcommand only and reads thresholds from the environment", () => {
    expect(
      gitOperationName(["-c", "core.fsmonitor=false", "-C", "/r", "status", "--porcelain"]),
    ).toBe("git status");
    expect(gitOperationName(["--no-pager", "log", "--format=%H", "feat/secret-branch"])).toBe(
      "git log",
    );
    expect(slowOpsSettingsFromEnv({})).toEqual(DEFAULT_SLOW_OPS);
    expect(
      slowOpsSettingsFromEnv({
        HIVE_SLOW_OP_MS: "1500",
        HIVE_SLOW_REQUEST_MS: "8000",
        HIVE_SLOW_OP_HISTORY: "nope",
      }),
    ).toEqual({ ...DEFAULT_SLOW_OPS, thresholdMs: 1500, requestThresholdMs: 8000 });
  });
});

describe("slow operations in the server", () => {
  let root: string;
  let database: HiveDatabase;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "hive-slow-ops-")));
    database = new HiveDatabase(":memory:");
    slowOps.clear();
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
    slowOps.configure(DEFAULT_SLOW_OPS);
    slowOps.clear();
  });

  it("measures how long the worktree lock was waited for and held", async () => {
    slowOps.configure({ thresholdMs: 60 });
    const manager = new WorktreeManager({ database, activeInvocations: () => [] });
    const serial = (
      manager as unknown as {
        serial: <T>(repo: string, name: string, operation: () => Promise<T>) => Promise<T>;
      }
    ).serial.bind(manager);
    const holder = serial(root, "remove", () => sleep(120));
    const waiter = serial(root, "runtimeWorkspaces", async () => undefined);
    await Promise.all([holder, waiter]);
    const locks = slowOps.list().operations.filter((item) => item.kind === "lock");
    const held = locks.find((item) => item.name === "worktrees.lock remove")!;
    const waited = locks.find((item) => item.name === "worktrees.lock runtimeWorkspaces")!;
    expect(held.durationMs).toBeGreaterThanOrEqual(100);
    expect(held.waitMs).toBeLessThan(50);
    // 排在后面的：等了差不多整段持有时间，自己几乎不占锁
    expect(waited.waitMs).toBeGreaterThanOrEqual(100);
    expect(waited.durationMs).toBeLessThan(50);
    expect(waited.repo).toBe(root);
  });

  it("records git subprocesses without their arguments", async () => {
    slowOps.configure({ thresholdMs: 0 });
    await slowOps.within({ source: "worktrees.list" }, () =>
      worktreeGit(root, ["init", "-b", "secret-branch-name"]),
    );
    const entry = slowOps.list().operations.find((item) => item.kind === "git")!;
    expect(entry).toMatchObject({ name: "git init", repo: root, source: "worktrees.list" });
    expect(JSON.stringify(entry)).not.toContain("secret-branch-name");
  });

  it("times MCP tool calls as requests, except the ones that wait on purpose", async () => {
    slowOps.configure({ thresholdMs: 0, requestThresholdMs: 0 });
    const server = createHiveMcpServer({
      roomId: "general",
      username: "helper",
      listMembers: () => [],
      takeInbox: () => undefined,
      wait: async () => ({ done: true }),
      now: () => Date.now(),
      timeZone: "UTC",
      formatScheduleTime: (iso: string) => iso,
    } as unknown as HiveMcpContext);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "slow-ops-test", version: "0.1.0" });
    await client.connect(clientTransport);
    try {
      await client.callTool({ name: "hive_members_list", arguments: {} });
      await client.callTool({
        name: "hive_wait",
        arguments: { invocationId: "00000000-0000-4000-8000-000000000000" },
      });
      const names = slowOps.list().operations.map((item) => item.name);
      expect(names).toContain("MCP hive_members_list");
      expect(names).not.toContain("MCP hive_wait");
      expect(
        slowOps.list().operations.find((item) => item.name === "MCP hive_members_list"),
      ).toMatchObject({ kind: "request", roomId: "general" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("records slow HTTP requests by route template and serves them to the local owner only", async () => {
    const lines: string[] = [];
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/definitely-not-present",
      slowOps: { thresholdMs: 60_000, requestThresholdMs: 0 },
      logger: { level: "warn", stream: { write: (line: string) => void lines.push(line) } },
      localAgents: {
        cli: { command: "/usr/bin/node", args: ["/opt/superhive/dist/cli.js"] },
        serverUrl: "http://127.0.0.1:8787",
        probe: async () => ({ installed: false, version: null }),
      },
    });
    try {
      await app.inject({
        method: "GET",
        url: "/api/rooms/general/messages?afterSeq=0&secret=hunter2",
        headers: { authorization: "Bearer test-token" },
      });
      const { ownerToken } = (await app.inject({ url: "/api/local/session" })).json() as {
        ownerToken: string;
      };
      const read = (headers: Record<string, string>, remoteAddress = "127.0.0.1") =>
        app.inject({ method: "GET", url: "/api/local/slow-ops", headers, remoteAddress });
      // 总令牌（Agent 也有）、别的电脑都不行
      expect((await read({ "x-hive-owner": "test-token" })).statusCode).toBe(401);
      expect((await read({ "x-hive-owner": ownerToken }, "10.0.0.9")).statusCode).toBe(403);
      const response = await read({ "x-hive-owner": ownerToken });
      expect(response.statusCode).toBe(200);
      const body = response.json() as SlowOperationsResponse;
      expect(body.requestThresholdMs).toBe(0);
      const request = body.operations.find(
        (item) => item.name === "GET /api/rooms/:roomId/messages",
      );
      expect(request).toMatchObject({ kind: "request", status: 200, roomId: "general" });
      expect(JSON.stringify(body)).not.toContain("hunter2");
      const logged = lines.map((line) => JSON.parse(line) as { msg: string; slowOp?: unknown });
      expect(logged.some((line) => line.msg === "slow operation")).toBe(true);
      expect(lines.join("\n")).not.toContain("hunter2");
    } finally {
      await app.close();
    }
  });
});
