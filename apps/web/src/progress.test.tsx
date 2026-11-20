// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Invocation, WhiteboardEntry } from "@superhive/protocol";
import { ProgressPanel, buildProgress, progressHeadline } from "./progress";

const agentId = "00000000-0000-4000-8000-000000000002";

function entry(overrides: Partial<WhiteboardEntry>): WhiteboardEntry {
  return {
    id: crypto.randomUUID(),
    roomId: "build",
    key: "task",
    slot: "in_progress",
    summary: "做登录页",
    unblocks: [],
    authorId: agentId,
    authorName: "helper",
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
    ...overrides,
  };
}

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: crypto.randomUUID(),
    roomId: "build",
    seq: 1,
    senderId: agentId,
    senderName: "helper",
    senderType: "agent",
    content: "hello",
    mentions: [],
    traceId: crypto.randomUUID(),
    hopCount: 0,
    createdAt: "2026-11-20T00:00:00.000Z",
    ...overrides,
  };
}

function invocation(overrides: Partial<Invocation>): Invocation {
  return {
    id: crypto.randomUUID(),
    roomId: "build",
    messageId: crypto.randomUUID(),
    agentId,
    agentName: "helper",
    requesterName: "rd",
    requesterType: "human",
    status: "running",
    attempts: 1,
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("progressHeadline", () => {
  it("keeps only the first plain sentence", () => {
    expect(progressHeadline("右侧栏改成进展视图。基于 main 2436b96，web431 通过")).toBe(
      "右侧栏改成进展视图",
    );
    expect(progressHeadline("#4003 已实现精简公开回执；19 文件已暂存")).toBe("已实现精简公开回执");
    expect(progressHeadline("#3484房主授权将文档改造优化提交")).toBe("房主授权将文档改造优化提交");
    expect(progressHeadline("6a72f0a 已提交，待 review：任务目录列状态不再抢写锁")).toBe(
      "已提交，待 review：任务目录列状态不再抢写锁",
    );
  });

  it("truncates long legacy summaries", () => {
    const headline = progressHeadline("很".repeat(100));
    expect([...headline]).toHaveLength(60);
    expect(headline.endsWith("…")).toBe(true);
  });
});

describe("buildProgress", () => {
  it("sorts entries and human-waiting invocations into three groups", () => {
    const trigger = message({ seq: 10, senderType: "human", senderName: "rd" });
    const question = message({
      seq: 11,
      kind: "question",
      parentMessageId: trigger.id,
      content: "要不要顺手清掉旧条目？两条都已合入",
    });
    const groups = buildProgress({
      roomId: "build",
      entries: [
        entry({ key: "a", slot: "in_progress", summary: "在做 A" }),
        entry({ key: "b", slot: "ready", summary: "B 做完了" }),
        entry({ key: "c", slot: "blocked", summary: "C 卡住了" }),
        entry({
          key: "d",
          slot: "milestone",
          summary: "D 合入了",
          mergedAt: "2026-11-20T01:00:00.000Z",
        }),
        entry({
          key: "e",
          slot: "milestone",
          summary: "归档的",
          archivedAt: "2026-11-20T01:00:00.000Z",
        }),
        entry({ key: "worktree:x", slot: "in_progress", summary: "目录登记" }),
      ],
      invocations: [
        invocation({ status: "waiting_human", messageId: trigger.id }),
        invocation({ status: "blocked" }),
        invocation({ status: "running" }),
        invocation({ status: "waiting_human", roomId: "other" }),
      ],
      messages: [trigger, question],
    });
    expect(groups.attention.map((item) => item.title)).toEqual([
      "helper 在问：要不要顺手清掉旧条目？",
      "helper 的任务被拦下，等你放行",
      "C 卡住了",
    ]);
    expect(groups.attention[0]!.target).toEqual({ messageId: question.id, messageSeq: 11 });
    expect(groups.doing.map((item) => [item.title, item.badge?.label])).toEqual([
      ["在做 A", undefined],
      ["B 做完了", "做完待验收"],
    ]);
    expect(groups.done.map((item) => [item.title, item.badge?.label])).toEqual([
      ["D 合入了", "已合入"],
    ]);
  });

  it("links entries to their source message, a #seq in the summary, or the author's last message", () => {
    const sourceId = crypto.randomUUID();
    const said = message({ seq: 7, createdAt: "2026-11-19T23:59:00.000Z" });
    const later = message({ seq: 8, createdAt: "2026-11-20T03:00:00.000Z" });
    const groups = buildProgress({
      roomId: "build",
      entries: [
        entry({
          key: "a",
          messageId: sourceId,
          messageSeq: 5,
          updatedAt: "2026-11-20T00:03:00.000Z",
        }),
        entry({ key: "b", summary: "#4003 回执精简", updatedAt: "2026-11-20T00:02:00.000Z" }),
        entry({ key: "c", summary: "旧条目", updatedAt: "2026-11-20T00:01:00.000Z" }),
        entry({ key: "d", summary: "别人的", authorId: crypto.randomUUID() }),
      ],
      invocations: [],
      messages: [said, later],
    });
    expect(groups.doing.map((item) => item.target)).toEqual([
      { messageId: sourceId, messageSeq: 5 },
      { messageSeq: 4003 },
      { messageId: said.id, messageSeq: 7 },
      undefined,
    ]);
  });
});

describe("ProgressPanel", () => {
  afterEach(cleanup);

  it("jumps to the chat on click and keeps the raw board folded", async () => {
    const user = userEvent.setup();
    const onLocate = vi.fn();
    const groups = buildProgress({
      roomId: "build",
      entries: [
        entry({ summary: "做登录页。细节 web431", messageId: crypto.randomUUID(), messageSeq: 3 }),
      ],
      invocations: [],
      messages: [],
    });
    render(<ProgressPanel groups={groups} onLocate={onLocate} board={<p>raw board</p>} />);
    expect(screen.getByText("没有要你处理的事")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /做登录页/ }));
    expect(onLocate).toHaveBeenCalledWith(groups.doing[0]!.target);
    const details = screen.getByText("Agent 白板（原文）").closest("details")!;
    expect(details.open).toBe(false);
    expect(within(details).getByText("raw board")).toBeTruthy();
  });

  it("shows only the latest completed items until expanded", async () => {
    const user = userEvent.setup();
    const groups = buildProgress({
      roomId: "build",
      entries: Array.from({ length: 10 }, (_, index) =>
        entry({
          key: `done-${index}`,
          slot: "milestone",
          summary: `完成 ${index}`,
          updatedAt: `2026-11-20T00:0${index}:00.000Z`,
        }),
      ),
      invocations: [],
      messages: [],
    });
    render(<ProgressPanel groups={groups} onLocate={() => undefined} board={null} />);
    const done = screen.getByRole("region", { name: /最近完成/ });
    expect(within(done).getAllByRole("listitem")).toHaveLength(8);
    expect(within(done).queryByText("完成 0")).toBeNull();
    await user.click(within(done).getByRole("button", { name: "显示全部 10 条" }));
    expect(within(done).getAllByRole("listitem")).toHaveLength(10);
  });
});
