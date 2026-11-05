import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ChatMessage, Schedule, ServerEvent } from "@superhive/protocol";
import { buildApp } from "./app.js";
import { HiveDatabase } from "./database.js";
import { Peer } from "./test-peer.js";

/** 测试时钟的起点取真实时间（取整到分钟）：调用的超时判断按真实写入时间算，差太多会被当成卡住 */
const BASE = Math.floor(Date.now() / 60_000) * 60_000;
const utc = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();
/** 同一时刻写成东八区偏移，例如 2026-11-04T00:07:00+08:00 */
const local8 = (minutes: number) =>
  `${new Date(BASE + minutes * 60_000 + 8 * 3_600_000).toISOString().slice(0, 19)}+08:00`;
const shanghai = (minutes: number) =>
  `${new Date(BASE + minutes * 60_000 + 8 * 3_600_000).toISOString().slice(0, 16).replace("T", " ")}（Asia/Shanghai）`;

let cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

/** 时钟可拨：定时任务按 now() 判断到点；拨过去后调用 runSchedules() 让扫描立刻跑一次 */
async function startRoom(options: { databasePath?: string; now?: () => number } = {}) {
  let time = BASE;
  const app = await buildApp({
    databasePath: options.databasePath ?? ":memory:",
    token: "test-token",
    staticDir: "/definitely-not-present",
    now: options.now ?? (() => time),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
  };
  cleanup.push(close);
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
    const snapshot = await peer.next((event) => event.type === "room.snapshot");
    return { peer, snapshot: snapshot as Extract<ServerEvent, { type: "room.snapshot" }> };
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
    const client = new Client({ name: "hive-schedule-test", version: "0.1.0" });
    await client.connect(transport as unknown as Transport);
    cleanup.push(() => client.close());
    return client;
  };
  return {
    app,
    port,
    join,
    mcp,
    close,
    /** 拨快时钟并立刻跑一次定时扫描 */
    advance: (ms: number) => {
      time += ms;
      (app as unknown as { runSchedules: () => void }).runSchedules();
    },
    now: () => time,
  };
}

const scheduleOf = (event: ServerEvent): Schedule =>
  (event as Extract<ServerEvent, { type: "schedule.updated" }>).schedule;
const messageOf = (event: ServerEvent): ChatMessage =>
  (event as Extract<ServerEvent, { type: "message.created" }>).message;

/** Alice @ helper，helper 开工；返回 helper 的 MCP 客户端与创建定时任务的快捷方法 */
async function executingRoom() {
  const started = await startRoom();
  const { peer: alice } = await started.join("Alice", "human");
  const { peer: helper } = await started.join("helper", "agent");
  alice.send({ type: "message.send", clientMessageId: "root", content: "@helper 今晚 0 点提醒我" });
  const mentioned = await helper.next((event) => event.type === "agent.mentioned");
  const trigger = (mentioned as Extract<ServerEvent, { type: "agent.mentioned" }>).message;
  helper.send({ type: "invocation.report", messageId: trigger.id, status: "running" });
  await alice.next(
    (event) => event.type === "invocation.updated" && event.invocation.status === "running",
  );
  const client = await started.mcp("helper");
  const create = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: "hive_schedule_create", arguments: args });
    return result as { isError?: boolean; structuredContent?: Record<string, unknown> } & {
      content: Array<{ text: string }>;
    };
  };
  return { ...started, alice, helper, trigger, client, create };
}

describe("hive_schedule", () => {
  it("lists the schedule tools with the server's current time", async () => {
    const { client } = await executingRoom();
    const { tools } = await client.listTools();
    const create = tools.find((tool) => tool.name === "hive_schedule_create");
    expect(create?.description).toContain("当前服务端时间：");
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["hive_schedule_list", "hive_schedule_cancel"]),
    );
  });

  it("fires at the scheduled time as the requester, wakes only the creator and needs no extra report on a reply", async () => {
    const { alice, helper, trigger, create, advance, join } = await executingRoom();
    const created = await create({
      runAt: local8(247),
      task: "提醒 Alice 看部署结果，顺便 @rd-codex 一下",
      timeZone: "Asia/Shanghai",
      clientMessageId: "s1",
    });
    expect(created.isError).toBeFalsy();
    const view = created.structuredContent!.schedule as Record<string, string>;
    expect(view).toMatchObject({
      status: "scheduled",
      runAt: utc(247),
      runAtLocal: shanghai(247),
      requester: "Alice",
      agent: "helper",
    });
    const announced = scheduleOf(await alice.next((event) => event.type === "schedule.updated"));
    expect(announced).toMatchObject({ id: view.id, originMessageId: trigger.id });

    // 同一个幂等键重试不会建出第二个
    const retried = await create({
      runAt: local8(247),
      task: "x",
      clientMessageId: "s1",
    });
    expect((retried.structuredContent!.schedule as { id: string }).id).toBe(view.id);
    expect(retried.structuredContent!.created).toBe(false);

    // 网页刷新/重新进入时能看到
    const { snapshot } = await join("Bob", "human");
    expect(snapshot.schedules).toEqual([expect.objectContaining({ id: view.id })]);

    // 这一轮照常结束
    helper.send({ type: "invocation.report", messageId: trigger.id, status: "completed" });

    advance(4 * 60 * 60_000 + 7 * 60_000 + 1_000);
    const triggerEvent = await helper.next(
      (event) => event.type === "agent.mentioned" && event.message.kind === "schedule",
      3_000,
    );
    const fired = (triggerEvent as Extract<ServerEvent, { type: "agent.mentioned" }>).message;
    expect(fired).toMatchObject({
      senderName: "Alice",
      senderType: "human",
      mentions: ["helper"],
      replyToMessageId: trigger.id,
      hopCount: 0,
    });
    // 任务正文里的 @ 被转义，不会借定时任务唤醒别人
    expect(fired.content).toContain("＠rd-codex");
    expect(fired.content).toContain("Hive 代 Alice 发出");
    const firedSchedule = scheduleOf(
      await alice.next(
        (event) => event.type === "schedule.updated" && event.schedule.status === "fired",
      ),
    );
    expect(firedSchedule).toMatchObject({ triggerMessageId: fired.id });
    const invocation = await alice.next(
      (event) =>
        event.type === "invocation.updated" && event.invocation.id === firedSchedule.invocationId,
    );
    expect(invocation).toMatchObject({
      invocation: { requesterName: "Alice", agentName: "helper", status: "queued" },
    });

    helper.send({ type: "invocation.report", messageId: fired.id, status: "running" });
    helper.send({
      type: "message.send",
      clientMessageId: "done",
      content: "提醒：部署已完成（回执 #42）",
      parentMessageId: fired.id,
    });
    await alice.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "completed",
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    // 正常回复了：服务端不再补发说明
    expect(
      alice.events.some(
        (event) => event.type === "message.created" && event.message.kind === "receipt",
      ),
    ).toBe(false);
  });

  it("posts one note to the requester when the run ends without a reply", async () => {
    const { alice, helper, trigger, create, advance } = await executingRoom();
    await create({ runAt: utc(5), task: "推送日报", clientMessageId: "s" });
    helper.send({ type: "invocation.report", messageId: trigger.id, status: "completed" });
    advance(5 * 60_000 + 1_000);
    const mentioned = await helper.next(
      (event) => event.type === "agent.mentioned" && event.message.kind === "schedule",
      3_000,
    );
    const fired = (mentioned as Extract<ServerEvent, { type: "agent.mentioned" }>).message;
    helper.send({ type: "invocation.report", messageId: fired.id, status: "running" });
    // NO_REPLY：只报完成，没有回复消息
    helper.send({ type: "invocation.report", messageId: fired.id, status: "completed" });
    const note = messageOf(
      await alice.next(
        (event) => event.type === "message.created" && event.message.kind === "receipt",
        3_000,
      ),
    );
    expect(note).toMatchObject({
      senderName: "helper",
      mentions: ["Alice"],
      parentMessageId: fired.id,
    });
    expect(note.content).toContain("没有回复");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(
      alice.events.filter(
        (event) => event.type === "message.created" && event.message.kind === "receipt",
      ),
    ).toHaveLength(0);
  });

  it("follows the run into the continued invocation when the scheduled turn asks a human", async () => {
    const { alice, helper, trigger, create, advance, client } = await executingRoom();
    const created = await create({ runAt: utc(1), task: "发布前先问一下", clientMessageId: "q" });
    const scheduleId = (created.structuredContent!.schedule as { id: string }).id;
    helper.send({ type: "invocation.report", messageId: trigger.id, status: "completed" });
    advance(61_000);
    const mentioned = await helper.next(
      (event) => event.type === "agent.mentioned" && event.message.kind === "schedule",
      3_000,
    );
    const fired = (mentioned as Extract<ServerEvent, { type: "agent.mentioned" }>).message;
    helper.send({ type: "invocation.report", messageId: fired.id, status: "running" });
    await alice.next(
      (event) =>
        event.type === "invocation.updated" &&
        event.invocation.messageId === fired.id &&
        event.invocation.status === "running",
    );
    const asked = await client.callTool({
      name: "hive_ask_human",
      arguments: { question: "发正式环境吗？" },
    });
    const questionId = (asked.structuredContent as { questionMessageId: string }).questionMessageId;
    // 提问后这一轮只回 NO_REPLY：不算「没有回复」
    helper.send({ type: "invocation.report", messageId: fired.id, status: "completed" });
    alice.send({
      type: "message.send",
      clientMessageId: "answer",
      content: "发",
      replyToMessageId: questionId,
    });
    const answer = await helper.next(
      (event) => event.type === "agent.mentioned" && event.message.replyToMessageId === questionId,
      3_000,
    );
    const answerMessage = (answer as Extract<ServerEvent, { type: "agent.mentioned" }>).message;
    const continued = await alice.next(
      (event) =>
        event.type === "invocation.updated" && event.invocation.messageId === answerMessage.id,
    );
    const continuedId = (continued as Extract<ServerEvent, { type: "invocation.updated" }>)
      .invocation.id;
    // 定时任务改指向续上的调用
    await alice.next(
      (event) =>
        event.type === "schedule.updated" &&
        event.schedule.id === scheduleId &&
        event.schedule.invocationId === continuedId,
      3_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      alice.events.some(
        (event) => event.type === "message.created" && event.message.kind === "receipt",
      ),
    ).toBe(false);

    // 续上的调用失败了：照样给发起人补一条说明
    helper.send({ type: "invocation.report", messageId: answerMessage.id, status: "running" });
    helper.send({
      type: "invocation.report",
      messageId: answerMessage.id,
      status: "failed",
      detail: "部署命令退出码 1",
    });
    const note = messageOf(
      await alice.next(
        (event) => event.type === "message.created" && event.message.kind === "receipt",
        3_000,
      ),
    );
    expect(note.mentions).toEqual(["Alice"]);
    expect(note.content).toContain("部署命令退出码 1");
  });

  it("refuses ambiguous, past, nested or out-of-turn schedules", async () => {
    const { alice, helper, create, trigger, advance, join, mcp } = await executingRoom();
    // 没在处理消息的 Agent 不能排定时
    await join("idle", "agent");
    const idle = await mcp("idle");
    const outside = await idle.callTool({
      name: "hive_schedule_create",
      arguments: { runAt: utc(60), task: "x" },
    });
    expect(outside.isError).toBe(true);
    expect((outside.content as Array<{ text: string }>)[0]!.text).toContain("处理某条消息的过程中");

    const noOffset = await create({ runAt: utc(60).replace(/Z$/, ""), task: "x" });
    expect(noOffset.isError).toBe(true);
    expect(noOffset.content[0]!.text).toContain("时区偏移");
    const past = await create({ runAt: utc(-1), task: "x" });
    expect(past.isError).toBe(true);
    const tooFar = await create({ runAt: utc(61 * 24 * 60), task: "x" });
    expect(tooFar.isError).toBe(true);
    const badZone = await create({
      runAt: utc(60),
      task: "x",
      timeZone: "Mars/Olympus",
    });
    expect(badZone.isError).toBe(true);

    // 定时任务触发的这一轮里不能再排定时（避免自我续命）
    await create({ runAt: utc(1), task: "第一次", clientMessageId: "n1" });
    helper.send({ type: "invocation.report", messageId: trigger.id, status: "completed" });
    advance(61_000);
    const mentioned = await helper.next(
      (event) => event.type === "agent.mentioned" && event.message.kind === "schedule",
      3_000,
    );
    const fired = (mentioned as Extract<ServerEvent, { type: "agent.mentioned" }>).message;
    helper.send({ type: "invocation.report", messageId: fired.id, status: "running" });
    await alice.next(
      (event) =>
        event.type === "invocation.updated" &&
        event.invocation.messageId === fired.id &&
        event.invocation.status === "running",
    );
    const nested = await create({ runAt: utc(60), task: "再来一次" });
    expect(nested.isError).toBe(true);
    expect(nested.content[0]!.text).toContain("不能再创建定时任务");
  });

  it("lets a human cancel before it fires, refuses after, and limits agents to their own", async () => {
    const room = await executingRoom();
    const { alice, helper, trigger, create, advance, client } = room;
    const first = await create({ runAt: utc(30), task: "A", clientMessageId: "a" });
    const second = await create({ runAt: utc(1), task: "B", clientMessageId: "b" });
    const firstId = (first.structuredContent!.schedule as { id: string }).id;
    const secondId = (second.structuredContent!.schedule as { id: string }).id;
    helper.send({ type: "invocation.report", messageId: trigger.id, status: "completed" });

    alice.send({ type: "schedule.cancel", scheduleId: firstId });
    const cancelled = scheduleOf(
      await alice.next(
        (event) => event.type === "schedule.updated" && event.schedule.status === "cancelled",
      ),
    );
    expect(cancelled).toMatchObject({ id: firstId, cancelledBy: "Alice" });

    advance(61_000);
    await alice.next(
      (event) =>
        event.type === "schedule.updated" &&
        event.schedule.id === secondId &&
        event.schedule.status === "fired",
      3_000,
    );
    alice.send({ type: "schedule.cancel", scheduleId: secondId });
    const refused = await alice.next((event) => event.type === "error");
    expect(refused).toMatchObject({ code: "SCHEDULE_NOT_PENDING" });

    // 另一个 Agent 不能取消 helper 的定时任务
    await room.join("other", "agent");
    const other = await room.mcp("other");
    const third = await create({ runAt: utc(120), task: "C", clientMessageId: "c" });
    expect(third.isError).toBe(true); // helper 这一轮已结束，不在执行中
    const listed = await client.callTool({ name: "hive_schedule_list", arguments: {} });
    expect((listed.structuredContent as { schedules: unknown[] }).schedules).toHaveLength(2);
    const foreign = await other.callTool({
      name: "hive_schedule_cancel",
      arguments: { scheduleId: secondId },
    });
    expect(foreign.isError).toBe(true);
  });
});

describe("schedules across restarts", () => {
  function seedRoom(databasePath: string) {
    const seed = new HiveDatabase(databasePath);
    const human = seed.upsertParticipant({ roomId: "general", username: "Alice", type: "human" });
    const agent = seed.upsertParticipant({ roomId: "general", username: "helper", type: "agent" });
    const origin = seed.createMessage(human, {
      content: "@helper 到点提醒我",
      clientMessageId: "origin",
    }).message;
    const add = (clientId: string, runAt: string) =>
      seed.createSchedule({
        roomId: "general",
        agent,
        requester: human,
        origin,
        clientId,
        task: `任务 ${clientId}`,
        runAt,
        timeZone: "Asia/Shanghai",
      }).schedule;
    return { seed, human, agent, origin, add };
  }

  it("marks schedules missed beyond the grace period, fires those within it, and finishes an interrupted fire exactly once", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hive-schedule-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const databasePath = path.join(directory, "hive.sqlite");
    const now = BASE;
    const { seed, add } = seedRoom(databasePath);
    const missed = add("missed", utc(-30));
    const late = add("late", utc(-5));
    const interrupted = add("interrupted", utc(-2));
    const future = add("future", utc(60));
    seed.transitionSchedule(interrupted.id, ["scheduled"], "firing");
    seed.close();

    const room = await startRoom({ databasePath, now: () => now });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await room.close();

    const after = new HiveDatabase(databasePath);
    cleanup.push(() => after.close());
    expect(after.getSchedule(missed.id)).toMatchObject({ status: "missed" });
    expect(after.getSchedule(late.id)).toMatchObject({ status: "fired" });
    expect(after.getSchedule(interrupted.id)).toMatchObject({ status: "fired" });
    expect(after.getSchedule(future.id)).toMatchObject({ status: "scheduled" });
    const messages = after.getMessages("general", 0, 100);
    const triggers = messages.filter((message) => message.kind === "schedule");
    expect(triggers.map((message) => message.content.match(/任务 (\w+)/)?.[1]).sort()).toEqual([
      "interrupted",
      "late",
    ]);
    // 错过的那个给发起人留了一条说明，只有一条
    const notes = messages.filter((message) => message.kind === "receipt");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ senderName: "helper", mentions: ["Alice"] });
    expect(notes[0]!.content).toContain("已错过");
    // 每次触发都建了调用，等 Agent 上线后处理
    for (const message of triggers) {
      expect(after.invocationsForMessage(message.id)).toEqual([
        expect.objectContaining({ status: "queued", requesterName: "Alice" }),
      ]);
    }
  });

  it("marks an interrupted fire as missed when the server comes back after the grace period", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hive-schedule-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const databasePath = path.join(directory, "hive.sqlite");
    const { seed, add } = seedRoom(databasePath);
    const schedule = add("stale", utc(-180));
    seed.transitionSchedule(schedule.id, ["scheduled"], "firing");
    seed.close();
    const room = await startRoom({ databasePath, now: () => BASE });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await room.close();
    const after = new HiveDatabase(databasePath);
    cleanup.push(() => after.close());
    expect(after.getSchedule(schedule.id)).toMatchObject({ status: "missed" });
    const messages = after.getMessages("general", 0, 100);
    expect(messages.filter((message) => message.kind === "schedule")).toHaveLength(0);
    expect(messages.filter((message) => message.kind === "receipt")).toHaveLength(1);
  });

  it("re-uses the trigger message when a fire was interrupted after writing it", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hive-schedule-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const databasePath = path.join(directory, "hive.sqlite");
    const { seed, human, add } = seedRoom(databasePath);
    const schedule = add("half", utc(-1));
    seed.transitionSchedule(schedule.id, ["scheduled"], "firing");
    // 触发消息已写入，调用还没建立就断电了
    seed.createMessage(human, {
      content: "@helper ⏰ 定时任务",
      clientMessageId: `schedule-${schedule.id}`,
      kind: "schedule",
    });
    seed.close();

    const room = await startRoom({
      databasePath,
      now: () => BASE,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await room.close();
    const after = new HiveDatabase(databasePath);
    cleanup.push(() => after.close());
    const triggers = after
      .getMessages("general", 0, 100)
      .filter((message) => message.kind === "schedule");
    expect(triggers).toHaveLength(1);
    expect(after.getSchedule(schedule.id)).toMatchObject({
      status: "fired",
      triggerMessageId: triggers[0]!.id,
    });
    expect(after.invocationsForMessage(triggers[0]!.id)).toHaveLength(1);
  });

  it("excludes scheduled triggers from human presence and cancels pending ones when the room is cleared", () => {
    const { seed, human, origin, add } = seedRoom(":memory:");
    const pending = add("p", utc(60));
    const before = seed.lastHumanMessageSeq("general");
    expect(before).toBe(origin.seq);
    seed.createMessage(human, {
      content: "@helper ⏰ 定时任务",
      clientMessageId: "trigger",
      kind: "schedule",
    });
    expect(seed.lastHumanMessageSeq("general")).toBe(before);

    seed.clearRoom("general", "Alice");
    expect(seed.getSchedule(pending.id)).toMatchObject({
      status: "cancelled",
      cancelledBy: "Alice",
    });
    expect(seed.listUnreportedSchedules()).toEqual([]);
    seed.close();
  });
});

describe("live execution trace", () => {
  it("relays an agent's steps only to the owner's pages while running and drops them when it ends", async () => {
    const room = await startRoom();
    const { peer: alice, snapshot } = await room.join("Alice", "human");
    expect(snapshot.features).toContain("trace");
    const { peer: helper } = await room.join("helper", "agent");
    const { peer: other } = await room.join("other", "agent");
    alice.send({ type: "message.send", clientMessageId: "go", content: "@helper 提交一下" });
    const mentioned = await helper.next((event) => event.type === "agent.mentioned");
    const trigger = (mentioned as Extract<ServerEvent, { type: "agent.mentioned" }>).message;
    const step = {
      id: "t1",
      kind: "tool",
      tool: "command",
      summary: "git status",
      status: "running",
      startedAt: new Date().toISOString(),
    };
    // 还没开始执行：不转发
    helper.send({ type: "invocation.trace", messageId: trigger.id, steps: [step] });
    helper.send({ type: "invocation.report", messageId: trigger.id, status: "running" });
    await alice.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "running",
    );
    helper.send({ type: "invocation.trace", messageId: trigger.id, steps: [step] });
    const relayed = await alice.next((event) => event.type === "invocation.trace");
    expect(relayed).toMatchObject({ steps: [{ id: "t1", summary: "git status" }] });
    expect(alice.events.filter((event) => event.type === "invocation.trace")).toHaveLength(0);

    // 别的 Agent 不能替它上报，也收不到
    other.send({ type: "invocation.trace", messageId: trigger.id, steps: [step] });

    // 房主刷新页面：补上当前的过程
    const { peer: reopened } = await room.join("Alice", "human");
    const replay = await reopened.next((event) => event.type === "invocation.trace");
    expect(replay).toMatchObject({ steps: [{ id: "t1" }] });

    helper.send({ type: "invocation.report", messageId: trigger.id, status: "completed" });
    const ended = await alice.next(
      (event) => event.type === "invocation.trace" && event.ended === true,
    );
    expect(ended).toMatchObject({ steps: [] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(other.events.some((event) => event.type === "invocation.trace")).toBe(false);
    expect(alice.events.some((event) => event.type === "invocation.trace")).toBe(false);
  });

  it("relays steps to guests invited with the trace switch on, not to those invited with it off", async () => {
    const room = await startRoom();
    const owner = { Authorization: "Bearer test-token", "Content-Type": "application/json" };
    const base = `http://127.0.0.1:${room.port}`;
    const guestToken = async (showTrace: boolean | undefined, username: string) => {
      const invite = (await (
        await fetch(`${base}/api/rooms/general/invites`, {
          method: "POST",
          headers: owner,
          body: JSON.stringify({
            expiresInMinutes: 60,
            allowAgents: true,
            ...(showTrace === undefined ? {} : { showTrace }),
          }),
        })
      ).json()) as { token: string; invite: { showTrace: boolean } };
      expect(invite.invite.showTrace).toBe(showTrace ?? true);
      const redeemed = (await (
        await fetch(`${base}/api/invites/redeem`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: invite.token, username }),
        })
      ).json()) as { token: string; showTrace: boolean };
      expect(redeemed.showTrace).toBe(showTrace ?? true);
      return redeemed.token;
    };
    const joinGuest = async (username: string, token: string) => {
      const peer = await Peer.connect(`ws://127.0.0.1:${room.port}/ws`);
      cleanup.push(() => peer.socket.close());
      peer.send({
        type: "participant.join",
        username,
        participantType: "human",
        roomId: "general",
        token,
      });
      await peer.next((event) => event.type === "room.snapshot");
      return peer;
    };
    // 不带开关默认可以看
    const viewer = await joinGuest("viewer", await guestToken(undefined, "viewer"));
    const hidden = await joinGuest("hidden", await guestToken(false, "hidden"));
    const { peer: alice } = await room.join("Alice", "human");
    const { peer: helper } = await room.join("helper", "agent");
    alice.send({ type: "message.send", clientMessageId: "go", content: "@helper 提交一下" });
    const mentioned = await helper.next((event) => event.type === "agent.mentioned");
    const trigger = (mentioned as Extract<ServerEvent, { type: "agent.mentioned" }>).message;
    helper.send({ type: "invocation.report", messageId: trigger.id, status: "running" });
    await alice.next(
      (event) => event.type === "invocation.updated" && event.invocation.status === "running",
    );
    const step = {
      id: "t1",
      kind: "tool",
      tool: "command",
      summary: "git status",
      status: "running",
      startedAt: new Date().toISOString(),
    };
    helper.send({ type: "invocation.trace", messageId: trigger.id, steps: [step] });
    await alice.next((event) => event.type === "invocation.trace");
    expect(await viewer.next((event) => event.type === "invocation.trace")).toMatchObject({
      steps: [{ summary: "git status" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(hidden.events.some((event) => event.type === "invocation.trace")).toBe(false);
  });
});

describe("hive_room_create", () => {
  it("creates a room with a workspace for the owner, and refuses outside an owner's task", async () => {
    const { alice, client, mcp, join } = await executingRoom();
    const workspace = mkdtempSync(path.join(tmpdir(), "hive-room-ws-"));
    cleanup.push(() => rmSync(workspace, { recursive: true, force: true }));
    const call = async (c: typeof client, args: Record<string, unknown>) =>
      (await c.callTool({ name: "hive_room_create", arguments: args })) as {
        isError?: boolean;
        structuredContent?: Record<string, any>;
        content: Array<{ text: string }>;
      };
    const created = await call(client, { id: "z-code", name: "Z Code", workspace });
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent!.room).toMatchObject({ id: "z-code", name: "Z Code" });
    const changed = await alice.next(
      (event) => event.type === "rooms.changed" && "room" in event && event.room?.id === "z-code",
    );
    expect((changed as any).room.createdBy).toBe("Alice");
    expect((changed as any).room.workspace).toBeTruthy();

    expect((await call(client, { id: "z-code" })).isError).toBe(true);
    expect((await call(client, { id: "nope", workspace: "/definitely/not/here" })).isError).toBe(
      true,
    );

    // 不在执行任务的 Agent 不能建
    await join("helper2", "agent");
    const idle = await mcp("helper2");
    expect((await call(idle, { id: "idle-room" })).isError).toBe(true);
  });
});
