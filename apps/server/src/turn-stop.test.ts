import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Invocation, ServerEvent } from "@superhive/protocol";
import { buildApp } from "./app.js";
import { Peer } from "./test-peer.js";

/** 一轮里合并处理了几条消息时，在其中一条下面点「停止」停的是整轮 */
describe("停止合在一轮里处理的几条消息", () => {
  let close: (() => Promise<void>) | undefined;
  const peers: Peer[] = [];
  afterEach(async () => {
    for (const peer of peers.splice(0)) peer.socket.close();
    await close?.();
  });

  const invocationOf = (event: ServerEvent): Invocation | undefined =>
    event.type === "invocation.updated" ? event.invocation : undefined;

  async function startRoom() {
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/definitely-not-present",
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    close = () => app.close();
    const port = (app.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const join = async (username: string, type: "human" | "agent", token = "test-token") => {
      const peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
      peers.push(peer);
      peer.send({ type: "participant.join", username, participantType: type, token });
      await peer.next((event) => event.type === "room.snapshot");
      return peer;
    };
    const joinGuest = async (username: string) => {
      const json = { Authorization: "Bearer test-token", "Content-Type": "application/json" };
      const invite = (await (
        await fetch(`${base}/api/rooms/general/invites`, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ expiresInMinutes: 60, allowAgents: true }),
        })
      ).json()) as { token: string };
      const redeemed = (await (
        await fetch(`${base}/api/invites/redeem`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: invite.token, username }),
        })
      ).json()) as { token: string };
      return join(username, "human", redeemed.token);
    };
    return { join, joinGuest };
  }

  /** 让 Agent 把几条 @ 合在一轮里开工，返回各自的消息 ID 和调用 */
  async function runTogether(
    observer: Peer,
    agent: Peer,
    senders: Array<{ peer: Peer; content: string }>,
  ) {
    const turn: Array<{ messageId: string; invocation: Invocation }> = [];
    for (const [index, { peer, content }] of senders.entries()) {
      peer.send({ type: "message.send", clientMessageId: `m${index}`, content });
      const mention = await agent.next((event) => event.type === "agent.mentioned");
      const messageId = mention.type === "agent.mentioned" ? mention.message.id : "";
      turn.push({ messageId, invocation: undefined as unknown as Invocation });
    }
    for (const item of turn) {
      agent.send({ type: "invocation.report", messageId: item.messageId, status: "running" });
      item.invocation = invocationOf(
        await observer.next(
          (event) =>
            invocationOf(event)?.messageId === item.messageId &&
            invocationOf(event)?.status === "running",
        ),
      )!;
    }
    return turn;
  }

  it("在其中一条下面点停止，同一轮的几条一起停下，Agent 一次收到整轮", async () => {
    const { join } = await startRoom();
    const rd = await join("rd", "human");
    const agent = await join("worker", "agent");
    const [first, second, third] = await runTogether(rd, agent, [
      { peer: rd, content: "@worker 第一件" },
      { peer: rd, content: "@worker 第二件" },
      { peer: rd, content: "@worker 第三件" },
    ]);

    rd.send({ type: "invocation.cancel", invocationId: second!.invocation.id });
    const stopping = new Set<string>();
    while (stopping.size < 3) {
      const updated = invocationOf(
        await rd.next((event) => invocationOf(event)?.status === "cancelling"),
      )!;
      stopping.add(updated.messageId);
    }
    const together = [first!.messageId, second!.messageId, third!.messageId].sort();
    expect([...stopping].sort()).toEqual(together);

    // 每条停止请求都带上整轮：Bridge 收到第一条就能一起停，不会误报「同轮还有没停的」
    for (let index = 0; index < 3; index += 1) {
      const cancel = await agent.next((event) => event.type === "agent.cancel");
      expect(cancel.type === "agent.cancel" && [...(cancel.turn ?? [])].sort()).toEqual(together);
    }

    for (const item of [first, second, third]) {
      agent.send({ type: "invocation.report", messageId: item!.messageId, status: "cancelled" });
      await rd.next(
        (event) =>
          invocationOf(event)?.messageId === item!.messageId &&
          invocationOf(event)?.status === "cancelled",
      );
    }
  });

  it("这一轮没停下时 Agent 如实回报，「停止中」改回执行中并写明原因", async () => {
    const { join } = await startRoom();
    const rd = await join("rd", "human");
    const agent = await join("worker", "agent");
    const [first] = await runTogether(rd, agent, [
      { peer: rd, content: "@worker 第一件" },
      { peer: rd, content: "@worker 第二件" },
    ]);
    rd.send({ type: "invocation.cancel", invocationId: first!.invocation.id });
    await rd.next((event) => invocationOf(event)?.status === "cancelling");

    // 比如旧版服务端只停了一条、或只撤回了其中一条：Bridge 说这一轮会继续
    agent.send({
      type: "invocation.report",
      messageId: first!.messageId,
      status: "running",
      stopDeferred: true,
      detail: "已请求停止，但同一轮还在处理其它没停的消息，这一轮会继续",
      detailText: { key: "bridge.stopDeferred" },
    });
    const deferred = invocationOf(
      await rd.next(
        (event) =>
          invocationOf(event)?.messageId === first!.messageId &&
          invocationOf(event)?.status === "running",
      ),
    )!;
    expect(deferred.detail).toContain("这一轮会继续");

    // 普通心跳不会把停止中冲回执行中（原有规则不变）
    rd.send({ type: "invocation.cancel", invocationId: first!.invocation.id });
    await rd.next(
      (event) =>
        invocationOf(event)?.messageId === first!.messageId &&
        invocationOf(event)?.status === "cancelling",
    );
    agent.send({ type: "invocation.report", messageId: first!.messageId, status: "running" });
    await expect(
      rd.next(
        (event) =>
          invocationOf(event)?.messageId === first!.messageId &&
          invocationOf(event)?.status === "running",
        200,
      ),
    ).rejects.toThrow();

    // 这一轮结束时这条落定为已停止
    agent.send({ type: "invocation.report", messageId: first!.messageId, status: "cancelled" });
    await rd.next(
      (event) =>
        invocationOf(event)?.messageId === first!.messageId &&
        invocationOf(event)?.status === "cancelled",
    );
  });

  it("访客停不了同一轮里有别人消息的这一轮，说清楚原因，状态不变", async () => {
    const { join, joinGuest } = await startRoom();
    const rd = await join("rd", "human");
    const agent = await join("worker", "agent");
    const guest = await joinGuest("visitor");
    const [mine] = await runTogether(rd, agent, [
      { peer: guest, content: "@worker 访客的事" },
      { peer: rd, content: "@worker 房主的事" },
    ]);
    expect(mine!.invocation.requesterName).toBe("visitor");

    guest.send({ type: "invocation.cancel", invocationId: mine!.invocation.id });
    const denied = await guest.next((event) => event.type === "error");
    expect(denied.type === "error" && denied.code).toBe("OWNER_ONLY");
    expect(denied.type === "error" && denied.message).toContain("访客没法停下这一轮");
    await expect(
      rd.next((event) => invocationOf(event)?.status === "cancelling", 200),
    ).rejects.toThrow();
    await expect(agent.next((event) => event.type === "agent.cancel", 100)).rejects.toThrow();
  });

  it("同一轮全是访客自己发起的，访客可以停下整轮", async () => {
    const { join, joinGuest } = await startRoom();
    const rd = await join("rd", "human");
    const agent = await join("worker", "agent");
    const guest = await joinGuest("visitor");
    const [first, second] = await runTogether(rd, agent, [
      { peer: guest, content: "@worker 第一件" },
      { peer: guest, content: "@worker 第二件" },
    ]);
    guest.send({ type: "invocation.cancel", invocationId: first!.invocation.id });
    const stopping = new Set<string>();
    while (stopping.size < 2) {
      stopping.add(
        invocationOf(await rd.next((event) => invocationOf(event)?.status === "cancelling"))!
          .messageId,
      );
    }
    expect([...stopping].sort()).toEqual([first!.messageId, second!.messageId].sort());
  });

  it("排队中的不算在这一轮里：停正在跑的不会连带排队的", async () => {
    const { join } = await startRoom();
    const rd = await join("rd", "human");
    const agent = await join("worker", "agent");
    const [running] = await runTogether(rd, agent, [{ peer: rd, content: "@worker 在跑的" }]);
    rd.send({ type: "message.send", clientMessageId: "q", content: "@worker 排队的" });
    await agent.next((event) => event.type === "agent.mentioned");
    const queued = invocationOf(
      await rd.next(
        (event) =>
          invocationOf(event)?.status === "queued" &&
          invocationOf(event)?.messageId !== running!.messageId,
      ),
    )!;
    rd.send({ type: "invocation.cancel", invocationId: running!.invocation.id });
    const cancel = await agent.next((event) => event.type === "agent.cancel");
    expect(cancel.type === "agent.cancel" && cancel.messageId).toBe(running!.messageId);
    expect(cancel.type === "agent.cancel" && cancel.turn).toBeUndefined();
    await expect(
      rd.next(
        (event) =>
          invocationOf(event)?.id === queued.id && invocationOf(event)?.status !== "queued",
        200,
      ),
    ).rejects.toThrow();
  });
});
