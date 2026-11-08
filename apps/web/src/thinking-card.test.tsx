// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Invocation, TraceStep } from "@superhive/protocol";
import { ThinkingCard, narrativeSteps, showsLiveCard } from "./thinking-card";

const now = new Date().toISOString();
const invocation = (extra: Partial<Invocation> = {}) =>
  ({
    id: "00000000-0000-4000-8000-0000000000c1",
    roomId: "general",
    messageId: "00000000-0000-4000-8000-0000000000c2",
    agentId: "00000000-0000-4000-8000-0000000000c3",
    agentName: "helper",
    requesterName: "rd",
    requesterType: "human",
    status: "running",
    attempts: 1,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    ...extra,
  }) as Invocation;
const step = (id: string, extra: Partial<TraceStep>): TraceStep => ({
  id,
  kind: "tool",
  startedAt: now,
  ...extra,
});

afterEach(cleanup);

describe("thinking card", () => {
  it("只把中途说的话和有正文的思考当叙述", () => {
    expect(
      narrativeSteps([
        step("a", { kind: "text", text: "先看看" }),
        step("b", { kind: "thinking" }),
        step("c", { kind: "thinking", text: "Checking" }),
        step("d", { tool: "command", summary: "ls" }),
        step("e", { kind: "text", text: "  " }),
      ]).map((item) => item.id),
    ).toEqual(["a", "c"]);
  });

  it("执行中、停止中、这一轮还没结束的等人回答才有卡片", () => {
    expect(showsLiveCard(invocation())).toBe(true);
    expect(showsLiveCard(invocation({ status: "cancelling" }))).toBe(true);
    expect(showsLiveCard(invocation({ status: "waiting_human" }))).toBe(true);
    expect(showsLiveCard(invocation({ status: "waiting_human", finishedAt: now }))).toBe(false);
    expect(showsLiveCard(invocation({ status: "queued" }))).toBe(false);
    expect(showsLiveCard(invocation({ status: "completed", finishedAt: now }))).toBe(false);
  });

  it("没有执行过程可看时只显示在做、做了多久，不编造过程", () => {
    render(<ThinkingCard invocation={invocation()} steps={undefined} avatar="AI" />);
    const card = screen.getByRole("article", { name: "helper 正在处理" });
    expect(within(card).getByText("看不到具体步骤")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "收起" })).toBeNull();
  });

  it("较早的卡片默认收起，点展开再看", () => {
    render(
      <ThinkingCard
        invocation={invocation()}
        steps={[step("a", { kind: "text", text: "先看看" })]}
        avatar="AI"
        defaultCollapsed
      />,
    );
    expect(screen.queryByText("先看看")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    expect(screen.getByText("先看看")).toBeTruthy();
  });
});
