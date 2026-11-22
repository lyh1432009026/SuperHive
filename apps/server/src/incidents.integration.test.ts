import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerEvent } from "@superhive/protocol";
import { buildApp } from "./app.js";
import type { IncidentDesk } from "./incident-desk.js";
import { Peer } from "./test-peer.js";

let cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** 一个最小的 git 仓库，当作 Server 自己的源码仓库 */
function sourceRepo(): { repo: string; head: string } {
  const repo = mkdtempSync(path.join(tmpdir(), "hive-incident-repo-"));
  cleanup.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  writeFileSync(path.join(repo, "README.md"), "hi\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return { repo, head: git(repo, ["rev-parse", "HEAD"]) };
}

async function startRoom(options: { incidentRepo?: string | false } = {}) {
  const app = await buildApp({
    databasePath: ":memory:",
    token: "test-token",
    staticDir: "/definitely-not-present",
    incidentRepo: options.incidentRepo ?? false,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(() => app.close());
  const port = (app.server.address() as AddressInfo).port;
  const desk = (app as unknown as { incidentDesk: IncidentDesk }).incidentDesk;
  const join = async (username: string, participantType: "human" | "agent") => {
    const peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
    cleanup.push(() => peer.socket.close());
    peer.send({
      type: "participant.join",
      username,
      participantType,
      roomId: "general",
      token: "test-token",
      ...(participantType === "agent" ? { provider: "claude" } : {}),
    });
    await peer.next((event) => event.type === "room.snapshot");
    return peer;
  };
  const mcp = async (agentName: string) => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          Authorization: "Bearer test-token",
          "X-Hive-Room": "general",
          "X-Hive-Agent-Name": agentName,
        },
      },
    });
    const client = new Client({ name: "hive-incident-test", version: "0.1.0" });
    await client.connect(transport as unknown as Transport);
    cleanup.push(() => client.close());
    return client;
  };
  return { app, port, desk, join, mcp };
}

const until = async (check: () => boolean, timeoutMs = 1_500) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** Alice @ 一个 Agent，Agent 回报这一轮结果未知（原因键 key） */
async function failTurn(
  alice: Peer,
  agent: Peer,
  name: string,
  key: string,
  clientMessageId: string,
) {
  alice.send({ type: "message.send", clientMessageId, content: `@${name} 看一下` });
  const mentioned = (await agent.next(
    (event) =>
      event.type === "agent.mentioned" && event.message.clientMessageId === clientMessageId,
  )) as Extract<ServerEvent, { type: "agent.mentioned" }>;
  agent.send({
    type: "invocation.report",
    messageId: mentioned.message.id,
    status: "uncertain",
    detailText: { key },
  });
}

describe("incidents in the running server", () => {
  it("files our failures and external ones separately, merging repeats", async () => {
    const { desk, join } = await startRoom();
    const alice = await join("Alice", "human");
    const worker = await join("worker", "agent");
    await failTurn(alice, worker, "worker", "bridge.reconnectedGone", "m1");
    await failTurn(alice, worker, "worker", "bridge.reconnectedGone", "m2");
    await failTurn(alice, worker, "worker", "bridge.upstreamFailed", "m3");
    await until(() => desk.snapshot().incidents.length === 2);
    await until(() => desk.snapshot().incidents.some((incident) => incident.count === 2));
    const incidents = desk.snapshot().incidents;
    expect(incidents.find((incident) => incident.origin === "internal")).toMatchObject({
      fingerprint: "invocation:bridge.reconnectedGone:claude",
      count: 2,
      samples: [{ agentName: "worker", provider: "claude", roomId: "general" }, {}],
    });
    expect(incidents.find((incident) => incident.origin === "external")).toMatchObject({
      fingerprint: "invocation:bridge.upstreamFailed:claude",
      count: 1,
    });
  });

  it("keeps the failure kind the bridge reports and files upstream failures by it", async () => {
    const { desk, join } = await startRoom();
    const alice = await join("Alice", "human");
    const worker = await join("worker", "agent");
    alice.send({ type: "message.send", clientMessageId: "q1", content: "@worker 看一下" });
    const mentioned = (await worker.next(
      (event) => event.type === "agent.mentioned" && event.message.clientMessageId === "q1",
    )) as Extract<ServerEvent, { type: "agent.mentioned" }>;
    const messageId = mentioned.message.id;
    // 限流，等着自动继续：带着失败原因
    worker.send({
      type: "invocation.report",
      messageId,
      status: "running",
      detail: "上游模型服务出错：API Error: 429",
      failure: "rate_limited",
    });
    const waiting = (await alice.next(
      (event) =>
        event.type === "invocation.updated" &&
        event.invocation.messageId === messageId &&
        event.invocation.status === "running" &&
        Boolean(event.invocation.detail),
    )) as Extract<ServerEvent, { type: "invocation.updated" }>;
    expect(waiting.invocation.failure).toBe("rate_limited");
    // 最后是额度用完：换成新的原因
    worker.send({
      type: "invocation.report",
      messageId,
      status: "failed",
      detailText: { key: "bridge.upstreamFailed", params: { reason: "Quota exceeded", why: "" } },
      failure: "quota",
    });
    const failed = (await alice.next(
      (event) =>
        event.type === "invocation.updated" &&
        event.invocation.messageId === messageId &&
        event.invocation.status === "failed",
    )) as Extract<ServerEvent, { type: "invocation.updated" }>;
    expect(failed.invocation.failure).toBe("quota");
    await until(() => desk.snapshot().incidents.length === 1);
    expect(desk.snapshot().incidents[0]).toMatchObject({
      origin: "external",
      fingerprint: "invocation:bridge.upstreamFailed:quota:claude",
    });
  });

  it("files server exceptions (5xx) but not client errors (4xx)", async () => {
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/definitely-not-present",
      incidentRepo: false,
    });
    cleanup.push(() => app.close());
    app.get("/test/boom", async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'id')");
    });
    const desk = (app as unknown as { incidentDesk: IncidentDesk }).incidentDesk;
    expect((await app.inject({ url: "/test/boom" })).statusCode).toBe(500);
    expect((await app.inject({ url: "/test/boom" })).statusCode).toBe(500);
    // 请求体不是合法 JSON：Fastify 回 400，是请求的问题，不归档
    const bad = await app.inject({
      method: "POST",
      url: "/api/client-errors",
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    expect(bad.statusCode).toBe(400);
    expect(desk.snapshot().incidents).toMatchObject([
      {
        source: "server",
        origin: "internal",
        count: 2,
        title: "TypeError: Cannot read properties of undefined (reading 'id')",
        samples: [{ route: "GET /test/boom" }, { route: "GET /test/boom" }],
      },
    ]);
  });

  it("files malformed events from an agent as a protocol incident", async () => {
    const { desk, join } = await startRoom();
    const worker = await join("worker", "agent");
    worker.send({ type: "invocation.report", messageId: "not-a-uuid", status: "completed" });
    await worker.next((event) => event.type === "error");
    await until(() => desk.snapshot().incidents.length === 1);
    expect(desk.snapshot().incidents[0]).toMatchObject({
      source: "protocol",
      origin: "internal",
      fingerprint: "protocol:invocation.report:messageId:invalid_string",
    });
  });

  it("accepts web error reports from the owner only", async () => {
    const { desk, port } = await startRoom();
    const report = { kind: "error", name: "TypeError", message: "x is undefined" };
    const anonymous = await fetch(`http://127.0.0.1:${port}/api/client-errors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    });
    expect(anonymous.status).toBe(401);
    const owner = await fetch(`http://127.0.0.1:${port}/api/client-errors`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer test-token",
        "X-Hive-Room": "general",
      },
      body: JSON.stringify(report),
    });
    expect(owner.status).toBe(204);
    expect(desk.snapshot().incidents[0]).toMatchObject({
      source: "web",
      samples: [{ roomId: "general" }],
    });
  });

  it("dispatches to the fixer, takes its report and keeps the lesson", async () => {
    const { repo, head } = sourceRepo();
    const { desk, join, mcp } = await startRoom({ incidentRepo: repo });
    const alice = await join("Alice", "human");
    const worker = await join("worker", "agent");
    const fixer = await join("fixer", "agent");
    desk.updateSettings({
      autoDispatch: true,
      roomId: "general",
      requester: "Alice",
      fixer: "fixer",
      reviewer: "worker",
      threshold: 2,
    });
    await failTurn(alice, worker, "worker", "bridge.steerEndRace", "f1");
    await failTurn(alice, worker, "worker", "bridge.steerEndRace", "f2");
    const assigned = (await fixer.next(
      (event) => event.type === "agent.mentioned" && event.message.content.includes("🩺 故障单"),
    )) as Extract<ServerEvent, { type: "agent.mentioned" }>;
    expect(assigned.message.senderName).toBe("Alice");
    expect(assigned.message.content).toContain(`在跑的代码 ${head.slice(0, 12)}`);
    const incident = desk.snapshot().incidents[0]!;
    expect(incident.status).toBe("fixing");
    expect(assigned.message.content).toContain(incident.id);

    // 修复提交在任务分支上
    git(repo, ["checkout", "-q", "-b", "fix/incident"]);
    writeFileSync(path.join(repo, "fix.ts"), "export const fixed = true;\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", `fix: steer race\n\nIncident: ${incident.id.slice(0, 8)}`]);
    const commit = git(repo, ["rev-parse", "HEAD"]);

    // 别的 Agent 不能替它回报
    const other = await mcp("worker");
    const denied = await other.callTool({
      name: "hive_incident_report",
      arguments: { incidentId: incident.id, status: "failed", reason: "x" },
    });
    expect(denied.isError).toBe(true);

    const client = await mcp("fixer");
    const missing = await client.callTool({
      name: "hive_incident_report",
      arguments: { incidentId: incident.id, status: "fixed", commit },
    });
    expect(missing.isError).toBe(true);
    const reported = await client.callTool({
      name: "hive_incident_report",
      arguments: {
        incidentId: incident.id,
        status: "fixed",
        commit,
        branch: "fix/incident",
        symptom: "引导和回合结束撞上",
        cause: "没等回合真正结束",
        fix: "按回合号判断",
      },
    });
    expect(reported.isError).toBeFalsy();
    expect(reported.structuredContent).toMatchObject({ status: "fix_submitted" });
    expect(desk.snapshot()).toMatchObject({
      incidents: [{ status: "fix_submitted", fixCommit: commit }],
      lessons: [{ symptom: "引导和回合结束撞上", verified: false }],
    });
  });

  it("adds approved rule proposals to /agent.md", async () => {
    const { desk, join, mcp, port } = await startRoom();
    await join("worker", "agent");
    const client = await mcp("worker");
    const proposed = await client.callTool({
      name: "hive_rule_propose",
      arguments: { text: "合入前先跑五个包的全量测试", reason: "这次漏跑了 docs 的测试" },
    });
    expect(proposed.isError).toBeFalsy();
    const { proposalId } = proposed.structuredContent as { proposalId: string };
    const before = await (await fetch(`http://127.0.0.1:${port}/agent.md`)).text();
    expect(before).not.toContain("合入前先跑五个包的全量测试");
    desk.decide(proposalId, "approve", "local-owner");
    const after = await (await fetch(`http://127.0.0.1:${port}/agent.md`)).text();
    expect(after).toContain("房主批准的补充规则");
    expect(after).toContain("1. 合入前先跑五个包的全量测试");
  });
});
