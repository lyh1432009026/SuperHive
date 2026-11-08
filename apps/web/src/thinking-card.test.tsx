// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Invocation, TraceStep } from "@superhive/protocol";
import {
  ThinkingCard,
  TraceRecap,
  narrativeSteps,
  showsLiveCard,
  withoutFinalReply,
} from "./thinking-card";

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

  it("没有执行过程可看时只显示在做、做了多久；能看但第一步还没到时是「启动中」", () => {
    const { rerender } = render(
      <ThinkingCard invocation={invocation()} steps={undefined} avatar="AI" />,
    );
    const card = screen.getByRole("article", { name: "helper 正在处理" });
    expect(within(card).getByText("启动中")).toBeTruthy();
    rerender(
      <ThinkingCard invocation={invocation()} steps={undefined} avatar="AI" traceAllowed={false} />,
    );
    expect(within(card).getByText("看不到具体步骤")).toBeTruthy();
    rerender(
      <ThinkingCard
        invocation={invocation({
          runtime: {
            observability: "heartbeat",
            lastHeartbeatAt: now,
            history: [],
          },
        })}
        steps={undefined}
        avatar="AI"
      />,
    );
    expect(within(card).getByText("看不到具体步骤")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "收起" })).toBeNull();
  });

  it("多出来的卡片跟着收起，用户点过以后以用户为准；等你回答时默认收起、不计时", () => {
    const steps = [step("a", { kind: "text", text: "先看看" })];
    const { rerender } = render(
      <ThinkingCard invocation={invocation()} steps={steps} avatar="AI" />,
    );
    expect(screen.getByText("先看看")).toBeTruthy();
    rerender(<ThinkingCard invocation={invocation()} steps={steps} avatar="AI" defaultCollapsed />);
    expect(screen.queryByText("先看看")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    rerender(<ThinkingCard invocation={invocation()} steps={steps} avatar="AI" defaultCollapsed />);
    expect(screen.getByText("先看看")).toBeTruthy();
    cleanup();
    render(
      <ThinkingCard
        invocation={invocation({ status: "waiting_human" })}
        steps={steps}
        avatar="AI"
      />,
    );
    const card = screen.getByRole("article", { name: "helper 正在处理" });
    expect(within(card).getByText("等你回答")).toBeTruthy();
    expect(within(card).queryByText("先看看")).toBeNull();
    expect(card.querySelector(".thinking-card-elapsed")).toBeNull();
  });

  it("回顾去掉和回复重复的最后一段，并标出没正常完成的结果", () => {
    const steps = [
      step("a", { kind: "text", text: "先看看" }),
      step("b", { tool: "command", summary: "ls", status: "ok", endedAt: now }),
      step("c", { kind: "text", text: "提交好了" }),
    ];
    expect(withoutFinalReply(steps, "提交好了\n\n细节如下").map((item) => item.id)).toEqual([
      "a",
      "b",
    ]);
    expect(withoutFinalReply(steps, "别的内容").map((item) => item.id)).toEqual(["a", "b", "c"]);
    render(
      <TraceRecap
        invocation={invocation({ status: "cancelled", finishedAt: now })}
        steps={steps}
      />,
    );
    expect(screen.getByRole("button", { name: /helper 的过程/ }).textContent).toContain("已停止");
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
