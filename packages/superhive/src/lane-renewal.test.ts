import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./hive-protocol.js";
import {
  buildHandoffSummary,
  estimateTokens,
  nextSessionStats,
  pendingDelegations,
  renewalReason,
  renewalSettings,
} from "./lane-renewal.js";

let seq = 0;
function message(overrides: Partial<ChatMessage>): ChatMessage {
  seq += 1;
  return {
    id: `m-${seq}`,
    roomId: "r",
    seq,
    senderId: "human",
    senderName: "rd",
    senderType: "human",
    content: "hi",
    mentions: [],
    traceId: "t",
    hopCount: 0,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("lane renewal", () => {
  it("reads settings from the environment", () => {
    expect(renewalSettings({})).toEqual({ tokens: 200_000, idleTokens: 100_000 });
    expect(renewalSettings({ HIVE_LANE_RENEW: "0" })).toEqual({ tokens: 0, idleTokens: 0 });
    expect(
      renewalSettings({ HIVE_LANE_RENEW_TOKENS: "300000", HIVE_LANE_RENEW_IDLE_TOKENS: "x" }),
    ).toEqual({ tokens: 300_000, idleTokens: 100_000 });
  });

  it("estimates CJK as one token per character and other text as four characters", () => {
    expect(estimateTokens("你好世界")).toBe(4);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });

  it("prefers reported context sizes and otherwise accumulates estimates per thread", () => {
    const first = nextSessionStats({
      previous: undefined,
      threadId: "a",
      promptText: "abcd",
      replyText: "你好",
    });
    expect(first).toEqual({ threadId: "a", contextTokens: 3, estimated: true, turns: 1 });
    const second = nextSessionStats({
      previous: first,
      threadId: "a",
      promptText: "",
      replyText: "你",
    });
    expect(second.contextTokens).toBe(4);
    expect(
      nextSessionStats({
        previous: second,
        threadId: "a",
        contextTokens: 50_000,
        promptText: "",
        replyText: "",
      }),
    ).toEqual({ threadId: "a", contextTokens: 50_000, turns: 3 });
    expect(
      nextSessionStats({ previous: second, threadId: "b", promptText: "", replyText: "" }).turns,
    ).toBe(1);
  });

  it("renews on size, caps the threshold below the compaction window, and on expired cache", () => {
    const settings = { tokens: 200_000, idleTokens: 100_000 };
    const stats = (contextTokens: number) => ({ threadId: "a", contextTokens, turns: 5 });
    expect(renewalReason({ stats: stats(210_000), threadId: "a", settings })).toMatchObject({
      kind: "size",
      threshold: 200_000,
    });
    expect(renewalReason({ stats: stats(150_000), threadId: "a", settings })).toBeUndefined();
    expect(
      renewalReason({ stats: stats(150_000), threadId: "a", settings, compactWindow: 200_000 }),
    ).toMatchObject({ kind: "size", threshold: 120_000 });
    // 别的会话的统计不算
    expect(renewalReason({ stats: stats(900_000), threadId: "b", settings })).toBeUndefined();
    const now = Date.parse("2026-11-25T10:00:00Z");
    const ended = new Date(now - 6 * 60_000).toISOString();
    expect(
      renewalReason({
        stats: stats(120_000),
        threadId: "a",
        settings,
        lastTurnEndedAt: ended,
        now,
      }),
    ).toMatchObject({ kind: "idle", cacheTtlMs: 300_000 });
    expect(
      renewalReason({
        stats: stats(120_000),
        threadId: "a",
        settings,
        lastTurnEndedAt: ended,
        cacheTtlMs: 3_600_000,
        now,
      }),
    ).toBeUndefined();
    expect(
      renewalReason({ stats: stats(50_000), threadId: "a", settings, lastTurnEndedAt: ended, now }),
    ).toBeUndefined();
    expect(
      renewalReason({
        stats: stats(900_000),
        threadId: "a",
        settings: { tokens: 0, idleTokens: 0 },
      }),
    ).toBeUndefined();
  });

  it("finds delegations still waiting for a receipt", () => {
    const sent = message({ senderId: "me", kind: "delegation", content: "@b do it" });
    const done = message({ senderId: "me", kind: "delegation", content: "@c other" });
    const receipt = message({ senderId: "c", kind: "receipt", parentMessageId: done.id });
    expect(pendingDelegations([sent, done, receipt], "me").map((item) => item.id)).toEqual([
      sent.id,
    ]);
  });

  it("builds a handoff summary from asks, decisions, own replies and open subtasks", () => {
    const ask = message({ content: "@agent-a 做登录页", mentions: ["agent-a"] });
    const decision = message({ content: "用方案 B" });
    const reply = message({
      senderId: "me",
      senderName: "agent-a",
      senderType: "agent",
      content: "做好了 abc123",
    });
    const sub = message({
      senderId: "me",
      senderType: "agent",
      kind: "delegation",
      content: "@b 写测试",
    });
    const text = buildHandoffSummary({
      messages: [ask, decision, reply, sub],
      username: "agent-a",
      ownId: "me",
      reason: { kind: "size", contextTokens: 250_000, threshold: 200_000 },
      cwd: "/work",
      afterSeq: 0,
    });
    expect(text).toContain("250k token");
    expect(text).toContain(`【最近交给你的事】\n#${ask.seq} [rd] @agent-a 做登录页`);
    expect(text).toContain(`【人最近说的】\n#${decision.seq} [rd] 用方案 B`);
    expect(text).toContain("做好了 abc123");
    expect(text).toContain("【你派出去还没回执的子任务】");
    expect(text).toContain("【工作目录】/work");
    expect(text).toContain('hive_room_read({"afterSeq":0})');
  });
});
