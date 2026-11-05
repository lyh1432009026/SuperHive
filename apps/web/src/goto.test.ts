// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { ChatMessage, Invocation, Participant, RoomSummary } from "@superhive/protocol";
import { collectAttention, nextAttention } from "./attention";
import { buildGoToItems, filterGoToItems } from "./goto";
import { isTypingTarget, matchShortcut } from "./shortcuts";

const at = "2026-11-06T10:00:00.000Z";
const room = (id: string, extra: Partial<RoomSummary> = {}): RoomSummary => ({
  id,
  name: id,
  createdAt: at,
  onlineCount: 1,
  latestSeq: 1,
  ...extra,
});
const message = (id: string, roomId: string, content: string): ChatMessage => ({
  id,
  roomId,
  seq: 1,
  senderId: "00000000-0000-4000-8000-000000000009",
  senderName: "rd",
  senderType: "human",
  content,
  mentions: [],
  traceId: "00000000-0000-4000-8000-000000000008",
  hopCount: 0,
  createdAt: at,
});
const invocation = (
  id: string,
  messageId: string,
  status: Invocation["status"],
  updatedAt = at,
  roomId = "build",
): Invocation => ({
  id,
  roomId,
  messageId,
  agentId: "agent-codex",
  agentName: "rd-codex",
  requesterName: "rd",
  requesterType: "human",
  status,
  attempts: 1,
  createdAt: at,
  updatedAt,
});
const agent: Participant = {
  id: "agent-codex",
  roomId: "build",
  username: "rd-codex",
  type: "agent",
  status: "busy",
  joinedAt: at,
  lastSeenAt: at,
};

const messages = new Map([
  ["m1", message("m1", "build", "跑一下测试")],
  ["m2", message("m2", "zwork", "修登录页")],
  ["m3", message("m3", "build", "看看 lint")],
]);
const invocations = [
  invocation("failed", "m1", "failed", "2026-11-06T10:01:00.000Z"),
  invocation("question", "m2", "waiting_human", "2026-11-06T10:05:00.000Z", "zwork"),
  invocation("running", "m3", "running"),
];

describe("Go To items", () => {
  const items = buildGoToItems({
    rooms: [room("build", { branch: "feat/x" }), room("zwork"), room("old", { archivedAt: at })],
    currentRoomId: "build",
    participants: [agent],
    invocations,
    attention: collectAttention(invocations),
    messages,
    statusLabel: (item) => item.status,
  });

  it("puts tasks needing attention first, waiting answers before failures", () => {
    expect(items.slice(0, 2).map((item) => item.key)).toEqual(["task:question", "task:failed"]);
    expect(items.some((item) => item.key === "room:old")).toBe(false);
    const build = items.find((item) => item.key === "room:build");
    expect(build).toMatchObject({ attention: 1, current: true, subtitle: "feat/x" });
    // Agent 指向它手上最需要看的那条任务
    const codex = items.find((item) => item.kind === "agent");
    expect(codex?.kind === "agent" && codex.task?.id).toBe("question");
  });

  it("filters by scope and ranks name prefix matches first", () => {
    expect(filterGoToItems(items, "", "room").map((item) => item.key)).toEqual([
      "room:build",
      "room:zwork",
    ]);
    expect(filterGoToItems(items, "", "attention").map((item) => item.key)).toEqual([
      "task:question",
      "task:failed",
      "room:build",
      "room:zwork",
      "agent:agent-codex",
    ]);
    expect(filterGoToItems(items, "zw", "all")[0]?.key).toBe("room:zwork");
    expect(filterGoToItems(items, "登录", "task").map((item) => item.key)).toEqual([
      "task:question",
    ]);
    expect(filterGoToItems(items, "没有这个", "all")).toEqual([]);
  });
});

describe("next attention", () => {
  it("cycles through attention.ts's ordering: answers before failures", () => {
    const items = collectAttention(invocations);
    const first = nextAttention(items);
    expect(first?.invocation.id).toBe("question");
    const second = nextAttention(items, first!.invocation.id);
    expect(second?.invocation.id).toBe("failed");
    expect(nextAttention(items, second!.invocation.id)?.invocation.id).toBe("question");
    expect(nextAttention(collectAttention([invocations[2]!]))).toBeUndefined();
  });
});

describe("shortcuts", () => {
  const key = (init: KeyboardEventInit, target?: EventTarget) => {
    const event = new KeyboardEvent("keydown", init);
    if (target) Object.defineProperty(event, "target", { value: target });
    return event;
  };

  it("matches by physical key so IME or Alt layouts still work", () => {
    expect(matchShortcut(key({ key: "p", code: "KeyP", metaKey: true }))).toBe("goto");
    expect(matchShortcut(key({ key: "π", code: "KeyP", ctrlKey: true }))).toBe("goto");
    expect(matchShortcut(key({ key: "j", code: "KeyJ", metaKey: true }))).toBe("next-attention");
    expect(matchShortcut(key({ key: "k", code: "KeyK", ctrlKey: true }))).toBe("search");
    expect(matchShortcut(key({ key: "/", code: "Slash", metaKey: true }))).toBe("help");
    expect(matchShortcut(key({ key: "p", code: "KeyP", metaKey: true, shiftKey: true }))).toBe(
      undefined,
    );
    expect(
      matchShortcut(key({ key: "p", code: "KeyP", metaKey: true, isComposing: true })),
    ).toBeUndefined();
  });

  it("only opens help with ? when focus is not in a text field", () => {
    const textarea = document.createElement("textarea");
    const button = document.createElement("button");
    const checkbox = Object.assign(document.createElement("input"), { type: "checkbox" });
    expect(isTypingTarget(textarea)).toBe(true);
    expect(isTypingTarget(checkbox)).toBe(false);
    expect(matchShortcut(key({ key: "?" }, textarea))).toBeUndefined();
    expect(matchShortcut(key({ key: "?" }, button))).toBe("help");
    expect(matchShortcut(key({ key: "?" }, document.body))).toBe("help");
  });
});
