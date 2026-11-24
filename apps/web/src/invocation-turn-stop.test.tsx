// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Invocation } from "@superhive/protocol";
import { InvocationChips, guestCanStopTurn, turnSiblings } from "./invocations";

const at = "2026-11-24T07:00:00.000Z";
const make = (id: number, overrides: Partial<Invocation> = {}): Invocation => ({
  id: `00000000-0000-4000-8000-00000000000${id}`,
  roomId: "general",
  messageId: `m${id}`,
  agentId: "a",
  agentName: "worker",
  requesterName: "rd",
  requesterType: "human",
  status: "running",
  attempts: 1,
  createdAt: at,
  startedAt: at,
  updatedAt: at,
  ...overrides,
});
const props = {
  participants: [],
  canJumpTo: () => true,
  onJump: vi.fn(),
  onRetry: vi.fn(),
  onExtend: vi.fn(),
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("合在一轮里处理的几条消息", () => {
  it("同一轮：同一个 Agent 在这个房间里正跑着的，排队的、别的 Agent、已结束的不算", () => {
    const self = make(1);
    const all = [
      self,
      make(2, { status: "cancelling" }),
      make(3, { status: "waiting_human" }),
      make(4, { status: "queued" }),
      make(5, { agentId: "b" }),
      make(6, { status: "completed" }),
      make(7, { status: "waiting_human", finishedAt: at }),
    ];
    expect(turnSiblings(self, all).map((item) => item.messageId)).toEqual(["m2", "m3"]);
    // 排队中的不在跑的这一轮里
    expect(turnSiblings(all[3]!, all)).toEqual([]);
  });

  it("房主点任意一条下面的「停止这一轮」，说明会一起停下", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const first = make(1);
    const all = new Map([first, make(2)].map((item) => [item.id, item]));
    render(
      <InvocationChips {...props} onCancel={onCancel} invocations={[first]} allInvocations={all} />,
    );
    const button = screen.getByRole("button", { name: "停止 @worker 这一轮的 2 条消息" });
    expect(button.textContent).toBe("停止这一轮");
    await user.hover(button);
    expect(await screen.findByText("这一轮一起处理了 2 条消息，停止会把它们一起停下")).toBeTruthy();
    await user.click(button);
    expect(onCancel).toHaveBeenCalledWith(first);
  });

  it("只有一条时照旧显示「停止」", () => {
    const only = make(1);
    render(
      <InvocationChips
        {...props}
        onCancel={vi.fn()}
        invocations={[only]}
        allInvocations={new Map([[only.id, only]])}
      />,
    );
    expect(screen.getByRole("button", { name: "停止 @worker" }).textContent).toBe("停止");
  });

  it("访客：同一轮里有别人发起的消息时停不了，按钮点不了并说清楚", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const mine = make(1, { requesterName: "Visitor" });
    const all = new Map([mine, make(2, { requesterName: "rd" })].map((item) => [item.id, item]));
    expect(guestCanStopTurn(mine, all.values(), "visitor")).toBe(false);
    render(
      <InvocationChips
        {...props}
        isOwner={false}
        selfName="visitor"
        onCancel={onCancel}
        invocations={[mine]}
        allInvocations={all}
      />,
    );
    const button = screen.getByRole("button", { name: "停止 @worker 这一轮的 2 条消息" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await user.hover(button);
    expect(
      await screen.findByText("@worker 这一轮还在一起处理别人发起的消息，访客没法停下这一轮"),
    ).toBeTruthy();
    await user.click(button);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("访客：同一轮全是自己发起的可以停", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const mine = make(1, { requesterName: "visitor" });
    const all = new Map(
      [mine, make(2, { requesterName: "visitor" })].map((item) => [item.id, item]),
    );
    render(
      <InvocationChips
        {...props}
        isOwner={false}
        selfName="visitor"
        onCancel={onCancel}
        invocations={[mine]}
        allInvocations={all}
      />,
    );
    await user.click(screen.getByRole("button", { name: "停止 @worker 这一轮的 2 条消息" }));
    expect(onCancel).toHaveBeenCalledWith(mine);
  });
});
