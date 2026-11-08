import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Invocation, ServerEvent } from "@superhive/protocol";
import { buildApp } from "./app.js";
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
  return { alice: await join("Alice", "human"), helper: await join("helper", "agent") };
}

const updated =
  (messageId: string, match: (invocation: Invocation) => boolean) => (event: ServerEvent) =>
    event.type === "invocation.updated" &&
    event.invocation.messageId === messageId &&
    match(event.invocation);

describe("recalling a message that dispatched work", () => {
  it("stops the running task when recalled with stop, and says why", async () => {
    const { alice, helper } = await room();
    alice.send({ type: "message.send", clientMessageId: "m1", content: "@helper 删掉 build" });
    const { message } = (await helper.next(
      (event) => event.type === "agent.mentioned",
    )) as Mentioned;
    helper.send({ type: "invocation.report", messageId: message.id, status: "running" });
    await alice.next(updated(message.id, (invocation) => invocation.status === "running"));

    alice.send({ type: "message.delete", messageId: message.id, stop: true });
    const cancel = await helper.next((event) => event.type === "agent.cancel");
    expect(cancel.type === "agent.cancel" && cancel.messageId).toBe(message.id);
    await alice.next(
      updated(
        message.id,
        (invocation) =>
          invocation.status === "cancelling" && Boolean(invocation.detail?.includes("消息已撤回")),
      ),
    );
    helper.send({
      type: "invocation.report",
      messageId: message.id,
      status: "cancelled",
      detail: "收到停止请求",
    });
    const done = await alice.next(
      updated(message.id, (invocation) => invocation.status === "cancelled"),
    );
    expect(done.type === "invocation.updated" && done.invocation.detail).toBe("消息已撤回，已停止");
  });

  it("cancels a queued task outright, and only-recall leaves running work alone", async () => {
    const { alice, helper } = await room();
    alice.send({ type: "message.send", clientMessageId: "q1", content: "@helper 排队的活" });
    const queued = ((await helper.next((event) => event.type === "agent.mentioned")) as Mentioned)
      .message;
    alice.send({ type: "message.delete", messageId: queued.id, stop: true });
    const cancelled = await alice.next(
      updated(queued.id, (invocation) => invocation.status === "cancelled"),
    );
    expect(cancelled.type === "invocation.updated" && cancelled.invocation.detail).toBe(
      "消息已撤回，未执行",
    );
    // Agent 那边也让它把排队的这条丢掉
    expect(await helper.next((event) => event.type === "agent.cancel")).toMatchObject({
      messageId: queued.id,
    });

    alice.send({ type: "message.send", clientMessageId: "r1", content: "@helper 继续做" });
    const running = ((await helper.next((event) => event.type === "agent.mentioned")) as Mentioned)
      .message;
    helper.send({ type: "invocation.report", messageId: running.id, status: "running" });
    await alice.next(updated(running.id, (invocation) => invocation.status === "running"));
    alice.send({ type: "message.delete", messageId: running.id });
    await alice.next((event) => event.type === "message.deleted");
    await expect(helper.next((event) => event.type === "agent.cancel", 200)).rejects.toThrow();
  });

  it("asks the agent to stop a delivered queued task, and files an unconfirmed stop as handled", async () => {
    const { alice, helper } = await room();
    alice.send({ type: "message.send", clientMessageId: "d1", content: "@helper 马上要开始" });
    const { message } = (await helper.next(
      (event) => event.type === "agent.mentioned",
    )) as Mentioned;
    helper.send({ type: "invocation.report", messageId: message.id, status: "received" });
    await alice.next(updated(message.id, (invocation) => Boolean(invocation.receivedAt)));

    alice.send({ type: "message.delete", messageId: message.id, stop: true });
    // 已经送达：不在服务端直接判成「未执行」，等 Agent 确认
    await alice.next(updated(message.id, (invocation) => invocation.status === "cancelling"));
    expect(await helper.next((event) => event.type === "agent.cancel")).toMatchObject({
      messageId: message.id,
    });
    helper.send({ type: "invocation.report", messageId: message.id, status: "uncertain" });
    const done = await alice.next(
      updated(
        message.id,
        (invocation) => invocation.status === "timed_out" && Boolean(invocation.resolution),
      ),
    );
    const invocation = (done as Extract<ServerEvent, { type: "invocation.updated" }>).invocation;
    expect(invocation.detail).toContain("消息已撤回，停止未确认");
    // 人已经在撤回确认里处理过，不再算作需要处理
    expect(invocation.resolution?.kind).toBe("dismissed");
  });
});
