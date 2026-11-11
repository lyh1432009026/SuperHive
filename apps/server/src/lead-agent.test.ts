import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { ServerEvent } from "@superhive/protocol";
import { buildApp } from "./app.js";
import { Peer } from "./test-peer.js";

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

type Mentioned = Extract<ServerEvent, { type: "agent.mentioned" }>;

async function room() {
  const app = await buildApp({
    databasePath: ":memory:",
    token: "test-token",
    staticDir: "/definitely-not-present",
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(() => app.close());
  const port = (app.server.address() as AddressInfo).port;
  const join = async (username: string, participantType: "human" | "agent") => {
    const peer = await Peer.connect(`ws://127.0.0.1:${port}/ws`);
    cleanup.push(() => peer.socket.close());
    peer.send({
      type: "participant.join",
      username,
      participantType,
      roomId: "general",
      token: "test-token",
    });
    await peer.next((event) => event.type === "room.snapshot");
    return peer;
  };
  const alice = await join("Alice", "human");
  const lead = await join("Lead", "agent");
  const other = await join("other", "agent");
  const setLead = (leadAgent: string | null) =>
    app.inject({
      method: "PATCH",
      url: "/api/rooms/general",
      headers: { authorization: "Bearer test-token" },
      payload: { leadAgent },
    });
  return { alice, lead, other, setLead, join };
}

describe("room lead agent", () => {
  it("hands human messages without any @ to the lead agent", async () => {
    const { alice, lead, other, setLead } = await room();
    // 没设主 Agent：不带 @ 的消息没人接
    alice.send({ type: "message.send", clientMessageId: "before", content: "大家好" });
    await expect(lead.next((event) => event.type === "agent.mentioned", 150)).rejects.toThrow();

    const response = await setLead("lead");
    expect(response.statusCode).toBe(200);
    // 按房间里的大小写存
    expect(response.json().room.leadAgent).toBe("Lead");

    alice.send({ type: "message.send", clientMessageId: "plain", content: "帮我看下 README" });
    const mentioned = (await lead.next((event) => event.type === "agent.mentioned")) as Mentioned;
    expect(mentioned.message.content).toBe("帮我看下 README");
    expect(mentioned.lead).toBe(true);
    const queued = await alice.next(
      (event) =>
        event.type === "invocation.updated" &&
        event.invocation.messageId === mentioned.message.id &&
        event.invocation.agentName === "Lead",
    );
    expect(queued).toBeTruthy();

    // 带了 @：只发给被 @ 的，主 Agent 不跟着醒
    alice.send({ type: "message.send", clientMessageId: "at", content: "@other 你来做" });
    await other.next((event) => event.type === "agent.mentioned");
    await expect(lead.next((event) => event.type === "agent.mentioned", 150)).rejects.toThrow();

    // Agent 发的不带 @ 的消息不交给主 Agent，免得互相接话
    other.send({ type: "message.send", clientMessageId: "agent", content: "做完了" });
    await expect(lead.next((event) => event.type === "agent.mentioned", 150)).rejects.toThrow();

    // 取消后恢复原样
    expect((await setLead(null)).json().room.leadAgent).toBeUndefined();
    alice.send({ type: "message.send", clientMessageId: "after", content: "还有人吗" });
    await expect(lead.next((event) => event.type === "agent.mentioned", 150)).rejects.toThrow();
  });

  it("hands a message whose @ names nobody present to the lead", async () => {
    const { alice, lead, other, setLead, join } = await room();
    await setLead("Lead");

    // @ 的名字不在房间里：交给主 Agent，并标成主 Agent 接手
    alice.send({ type: "message.send", clientMessageId: "ghost", content: "@nobody 帮我看下" });
    const ghost = (await lead.next((event) => event.type === "agent.mentioned")) as Mentioned;
    expect(ghost.message.content).toBe("@nobody 帮我看下");
    expect(ghost.lead).toBe(true);

    // @ 到在场的人：是人和人说话，主 Agent 不插手
    await join("Bob", "human");
    alice.send({ type: "message.send", clientMessageId: "human", content: "@Bob 你看下" });
    await expect(lead.next((event) => event.type === "agent.mentioned", 150)).rejects.toThrow();

    // @ 的 Agent 刚断开（重启这种）：照旧排队等它回来，主 Agent 不接
    other.socket.close();
    await alice.next(
      (event) =>
        event.type === "presence.changed" &&
        event.participant.username === "other" &&
        event.participant.status === "offline",
    );
    alice.send({ type: "message.send", clientMessageId: "brief", content: "@other 改一下" });
    const queued = await alice.next(
      (event) => event.type === "invocation.updated" && event.invocation.agentName === "other",
    );
    expect(queued).toBeTruthy();
    await expect(lead.next((event) => event.type === "agent.mentioned", 150)).rejects.toThrow();

    // 离线超过两分钟：主 Agent 接手，不再给它排队
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 3 * 60_000);
    alice.send({ type: "message.send", clientMessageId: "away", content: "@other 再改一下" });
    const away = (await lead.next((event) => event.type === "agent.mentioned")) as Mentioned;
    expect(away.message.content).toBe("@other 再改一下");
    expect(away.lead).toBe(true);
    await expect(
      alice.next(
        (event) =>
          event.type === "invocation.updated" &&
          event.invocation.agentName === "other" &&
          event.invocation.messageId === away.message.id,
        150,
      ),
    ).rejects.toThrow();
  });

  it("sends a reply to an agent's message to that agent, not the lead", async () => {
    const { alice, lead, other, setLead } = await room();
    await setLead("Lead");
    other.send({ type: "message.send", clientMessageId: "done", content: "改好了" });
    const done = (await alice.next(
      (event) => event.type === "message.created" && event.message.senderName === "other",
    )) as Extract<ServerEvent, { type: "message.created" }>;
    alice.send({
      type: "message.send",
      clientMessageId: "reply",
      content: "这里再改一下",
      replyToMessageId: done.message.id,
    });
    const mentioned = (await other.next((event) => event.type === "agent.mentioned")) as Mentioned;
    expect(mentioned.message.content).toBe("这里再改一下");
    expect(mentioned.lead).toBeUndefined();
    await expect(lead.next((event) => event.type === "agent.mentioned", 150)).rejects.toThrow();
  });

  it("only accepts an agent of this room as the lead", async () => {
    const { setLead } = await room();
    expect((await setLead("Alice")).statusCode).toBe(400);
    expect((await setLead("nobody")).json().code).toBe("ROOM_LEAD_INVALID");
  });
});
