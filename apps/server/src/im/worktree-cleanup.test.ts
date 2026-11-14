import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HiveDatabase } from "../database.js";
import type { WorktreeCleanupBatch } from "../worktrees.js";
import { ImHub, type ImHubDeps } from "./im-hub.js";
import { ImStore } from "./im-store.js";
import { SecretBox } from "./secret-box.js";
import type { ImChannelDriver, ImTransportEvents } from "./types.js";

const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function setup() {
  const database = new HiveDatabase(":memory:");
  disposers.push(() => database.close());
  const store = new ImStore(database.connection(), SecretBox.open(undefined));
  database.upsertParticipant({ roomId: "general", username: "Alice", type: "human" });
  const callbacks: Partial<Record<"feishu" | "wechat", ImTransportEvents>> = {};
  const driver = (channel: "feishu" | "wechat"): ImChannelDriver => ({
    channel,
    maxTextLength: 5000,
    ...(channel === "feishu" ? { richTextLength: 5000 } : {}),
    login: async () => {
      throw new Error("not used");
    },
    createTransport: () => ({
      start: async (events) => {
        callbacks[channel] = events;
        events.onStatus("connected");
      },
      sendText: async () => "sent",
      close: async () => undefined,
    }),
  });
  for (const channel of ["feishu", "wechat"] as const)
    store.createConnection({
      roomId: "general",
      channel,
      ownerName: "Alice",
      ownerActorId: `${channel}-owner`,
      label: channel,
      config: { appId: "test", cardCallbacks: "1" },
      secret: "test",
    });
  const request = vi.fn(() => true);
  const deps: ImHubDeps = {
    store,
    drivers: { feishu: driver("feishu"), wechat: driver("wechat") },
    requestWorktreeCleanup: request,
    getRoom: (id) => database.getRoom(id),
    listRoomIds: () => ["general"],
    findParticipant: (id, name) => database.findParticipant(id, name),
    getMessage: () => undefined,
    getInvocation: () => undefined,
    invocationAncestors: () => [],
    post: () => {
      throw new Error("not used");
    },
    choose: () => {
      throw new Error("not used");
    },
    retry: () => undefined,
    cancel: () => undefined,
    dismiss: () => undefined,
    extendBudget: () => undefined,
    invocationsFor: () => [],
    readAttachment: async () => undefined,
    saveFiles: async () => ({}),
    participants: () => [],
    roomTasks: () => ({ running: 0, waiting: 0 }),
    isWaiting: () => false,
    webUrl: () => "https://example.test/#general",
    onConnectionsChanged: () => undefined,
    log: () => undefined,
  };
  const hub = new ImHub(deps);
  disposers.push(() => hub.close());
  hub.start();
  await vi.waitFor(() => expect(callbacks.feishu).toBeDefined());
  const enqueue = vi.spyOn(store, "enqueue").mockReturnValue(true);
  const batch: WorktreeCleanupBatch = {
    id: randomUUID(),
    roomId: "general",
    ownerName: "Alice",
    automatic: false,
    state: "available",
    items: [
      {
        id: randomUUID(),
        repo: "/repo",
        path: "/repo-wt/feature",
        branch: "feat/feature",
        headCommit: "a".repeat(40),
      },
    ],
  };
  return { hub, callbacks, request, enqueue, batch };
}

describe("IM worktree cleanup", () => {
  it("sends an actionable Feishu card and an honest WeChat command fallback", async () => {
    const { hub, enqueue, batch } = await setup();
    hub.notifyWorktreeCleanup(batch);
    const cards = enqueue.mock.calls.map((call) => call[0]);
    expect(cards.find((item) => item.chatId === "user:feishu-owner")?.rich?.actions).toMatchObject([
      { value: { do: "worktree_cleanup", batch: batch.id } },
    ]);
    expect(
      cards.find((item) => item.chatId === "user:wechat-owner")?.rich?.actions,
    ).toBeUndefined();
    expect(cards.find((item) => item.chatId === "user:wechat-owner")?.text).toContain(
      `/worktree clean ${batch.id}`,
    );
  });

  it("rejects another actor and acknowledges an owner request without claiming deletion", async () => {
    const { callbacks, request, batch } = await setup();
    const action = {
      externalId: "card",
      chatId: "user:feishu-owner",
      operatorId: "someone-else",
      value: { do: "worktree_cleanup", batch: batch.id },
    };
    expect(callbacks.feishu!.onAction!(action)?.toast?.type).toBe("error");
    expect(request).not.toHaveBeenCalled();
    const result = callbacks.feishu!.onAction!({ ...action, operatorId: "feishu-owner" });
    expect(request).toHaveBeenCalledWith(batch.id, "Alice");
    expect(result?.toast?.text).toContain("已提交清理请求");
  });
});
