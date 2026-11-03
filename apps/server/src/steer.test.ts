import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { ServerEvent } from "@superhive/protocol";
import { buildApp } from "./app.js";
import { autoSteerKey } from "./local-agents.js";
import { Peer } from "./test-peer.js";

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
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
  const helper = await join("helper", "agent");
  const other = await join("other", "agent");
  // Alice 让 helper 开始一件事，helper 正在执行
  alice.send({ type: "message.send", clientMessageId: "first", content: "@helper 做第一件事" });
  const first = ((await helper.next((event) => event.type === "agent.mentioned")) as Mentioned)
    .message;
  helper.send({ type: "invocation.report", messageId: first.id, status: "running" });
  await alice.next(
    (event) => event.type === "invocation.updated" && event.invocation.status === "running",
  );
  const queueSecond = async (content = "@helper 顺便看下 README", steer?: boolean) => {
    alice.send({
      type: "message.send",
      clientMessageId: `m-${content}-${String(steer)}`,
      content,
      ...(steer ? { steer } : {}),
    });
    const mentioned = (await helper.next((event) => event.type === "agent.mentioned")) as Mentioned;
    const queued = await alice.next(
      (event) =>
        event.type === "invocation.updated" &&
        event.invocation.messageId === mentioned.message.id &&
        event.invocation.status === "queued",
    );
    return {
      mentioned,
      invocation: (queued as Extract<ServerEvent, { type: "invocation.updated" }>).invocation,
    };
  };
  return { app, alice, helper, other, first, queueSecond, join };
}

describe("steering a queued message into the running turn", () => {
  it("queues by default and lets a human insert it into the current task", async () => {
    const { alice, helper, queueSecond } = await room();
    const { mentioned, invocation } = await queueSecond();
    expect(mentioned.steer).toBeUndefined();

    alice.send({ type: "invocation.steer", invocationId: invocation.id });
    const steer = (await helper.next(
      (event) => event.type === "agent.mentioned" && event.steer === true,
    )) as Mentioned;
    expect(steer.message.id).toBe(mentioned.message.id);
    const updated = await alice.next(
      (event) =>
        event.type === "invocation.updated" &&
        event.invocation.id === invocation.id &&
        Boolean(event.invocation.detail?.includes("请求插入当前任务")),
    );
    expect(updated).toBeTruthy();
  });

  it("inserts right away with send-and-steer, but only while the agent is running", async () => {
    const { helper, queueSecond, first, alice } = await room();
    const { mentioned } = await queueSecond("@helper 补充一句", true);
    expect(mentioned.steer).toBe(true);

    // 当前任务结束后再「发送并插话」：没有可插的任务，照常排队
    helper.send({ type: "invocation.report", messageId: first.id, status: "completed" });
    helper.send({
      type: "invocation.report",
      messageId: mentioned.message.id,
      status: "completed",
    });
    await alice.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "completed",
    );
    await alice.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "completed",
    );
    const { mentioned: later } = await queueSecond("@helper 新的一件事", true);
    expect(later.steer).toBeUndefined();
  });

  it("auto-inserts human messages when the agent has auto-steer on", async () => {
    const { app, queueSecond } = await room();
    // 打开 helper 的自动插话（按名字存）
    (
      app as unknown as { hiveDatabase: { setSetting: (key: string, value: string) => void } }
    ).hiveDatabase.setSetting(autoSteerKey("helper"), "1");
    const { mentioned } = await queueSecond("@helper 自动插进去");
    expect(mentioned.steer).toBe(true);
  });

  it("refuses to steer messages that did not come straight from a human", async () => {
    const { alice, other, helper } = await room();
    // other 被 Alice 叫起来后 @ helper：Agent 发的消息不能插
    alice.send({ type: "message.send", clientMessageId: "o", content: "@other 去叫 helper" });
    const ask = ((await other.next((event) => event.type === "agent.mentioned")) as Mentioned)
      .message;
    other.send({ type: "invocation.report", messageId: ask.id, status: "running" });
    other.send({
      type: "message.send",
      clientMessageId: "relay",
      content: "@helper 帮个忙",
      parentMessageId: ask.id,
    });
    const relayed = (
      (await helper.next(
        (event) => event.type === "agent.mentioned" && event.message.senderName === "other",
      )) as Mentioned
    ).message;
    const queued = await alice.next(
      (event) =>
        event.type === "invocation.updated" &&
        event.invocation.messageId === relayed.id &&
        event.invocation.agentName === "helper",
    );
    const invocation = (queued as Extract<ServerEvent, { type: "invocation.updated" }>).invocation;
    alice.send({ type: "invocation.steer", invocationId: invocation.id });
    const error = await alice.next((event) => event.type === "error");
    expect(error).toMatchObject({ code: "STEER_UNAVAILABLE" });
  });

  it("stops the running task first when a human asks to switch to the queued one", async () => {
    const { alice, helper, first, queueSecond } = await room();
    const { invocation } = await queueSecond("@helper 方向变了，改做这个");
    alice.send({ type: "invocation.preempt", invocationId: invocation.id });
    const cancel = await helper.next((event) => event.type === "agent.cancel");
    expect(cancel).toMatchObject({ messageId: first.id });
    await alice.next(
      (event) =>
        event.type === "invocation.updated" &&
        event.invocation.messageId === first.id &&
        event.invocation.status === "cancelling",
    );
    await alice.next(
      (event) =>
        event.type === "invocation.updated" &&
        event.invocation.id === invocation.id &&
        Boolean(event.invocation.detail?.includes("停下后先做这一条")),
    );
  });
});
