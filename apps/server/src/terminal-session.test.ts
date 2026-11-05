import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { ServerEvent } from "@superhive/protocol";
import { buildApp } from "./app.js";
import type { ChildHandle, SpawnAgent } from "./local-agents.js";
import { Peer } from "./test-peer.js";

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

/** 不真的起 Agent 进程：只要本机 Agent 记录在 */
const spawn: SpawnAgent = () =>
  ({
    pid: 4242,
    onOutput: () => undefined,
    onExit: () => undefined,
    kill: () => undefined,
    release: () => undefined,
  }) as ChildHandle;

describe("open an agent's session in a terminal", () => {
  it("resumes the same session the agent reported, only while it is idle", async () => {
    const opened: string[] = [];
    const app = await buildApp({
      databasePath: ":memory:",
      token: "join-token",
      staticDir: "/definitely-not-present",
      openTerminal: vi.fn(async (command: string) => {
        opened.push(command);
      }),
      localAgents: {
        cli: { command: "/usr/bin/node", args: ["/opt/superhive/dist/cli.js"] },
        serverUrl: "http://127.0.0.1:8787",
        spawn,
        probe: async () => ({ installed: true, version: "2.0.0" }),
      },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    cleanup.push(() => app.close());
    const { ownerToken } = (await app.inject({ method: "GET", url: "/api/local/session" })).json();
    const owner = { "x-hive-owner": ownerToken as string };
    const created = await app.inject({
      method: "POST",
      url: "/api/local/agents",
      headers: owner,
      payload: { provider: "claude", name: "rd-claude", access: "read-only" },
    });
    expect(created.statusCode).toBe(201);
    const agentId = created.json().agent.id as string;
    const terminal = () =>
      app.inject({
        method: "POST",
        url: `/api/local/agents/${agentId}/terminal`,
        headers: owner,
        payload: { roomId: "general" },
      });
    // 还没回复过：没有会话可接
    expect((await terminal()).json().code).toBe("SESSION_UNAVAILABLE");

    const port = (app.server.address() as AddressInfo).port;
    const join = async (username: string, participantType: "human" | "agent") => {
      const peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
      cleanup.push(() => peer.socket.close());
      peer.send({
        type: "participant.join",
        username,
        participantType,
        roomId: "general",
        token: "join-token",
      });
      const snapshot = await peer.next((event) => event.type === "room.snapshot");
      return { peer, snapshot: snapshot as Extract<ServerEvent, { type: "room.snapshot" }> };
    };
    const { peer: agent, snapshot } = await join("rd-claude", "agent");
    expect(snapshot.features).toContain("session");
    agent.send({ type: "agent.session", sessionId: "sess-1", cwd: "/repo/web" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const info = await app.inject({
      method: "GET",
      url: `/api/local/agents/${agentId}/session?roomId=general`,
      headers: owner,
    });
    expect(info.json()).toMatchObject({
      available: true,
      busy: false,
      command: "cd /repo/web && claude --resume sess-1",
    });

    // 不像会话 ID 的上报不收
    agent.send({
      type: "agent.session",
      sessionId: "--dangerously-skip-permissions",
      cwd: "/evil",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/local/agents/${agentId}/session?roomId=general`,
          headers: owner,
        })
      ).json().command,
    ).toBe("cd /repo/web && claude --resume sess-1");

    // 排队中、正在执行时都不开，免得两边同时写一个会话
    const { peer: alice } = await join("Alice", "human");
    alice.send({ type: "message.send", clientMessageId: "m1", content: "@rd-claude 做点事" });
    const mentioned = await agent.next((event) => event.type === "agent.mentioned");
    const messageId = (mentioned as Extract<ServerEvent, { type: "agent.mentioned" }>).message.id;
    expect((await terminal()).json().code).toBe("AGENT_BUSY");
    agent.send({ type: "invocation.report", messageId, status: "running" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await terminal()).json().code).toBe("AGENT_BUSY");
    expect(opened).toEqual([]);
    // 确认后执行中也能打开（只想看看它做到哪了）
    const forced = await app.inject({
      method: "POST",
      url: `/api/local/agents/${agentId}/terminal`,
      headers: owner,
      payload: { roomId: "general", force: true },
    });
    expect(forced.json()).toMatchObject({ opened: true });
    opened.length = 0;

    agent.send({ type: "invocation.report", messageId, status: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const ok = await terminal();
    expect(ok.json()).toMatchObject({ opened: true });
    expect(opened).toEqual(["cd /repo/web && claude --resume sess-1"]);

    // 开新话题后 Agent 下一轮换新会话：旧的不再能接着
    alice.send({ type: "topic.start" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await terminal()).json().code).toBe("SESSION_UNAVAILABLE");

    // 只限本机：其他设备上不能在这台电脑上开窗口
    const remote = await app.inject({
      method: "POST",
      url: `/api/local/agents/${agentId}/terminal`,
      headers: owner,
      payload: { roomId: "general" },
      remoteAddress: "10.0.0.20",
    });
    expect(remote.statusCode).toBe(403);
  });
});
