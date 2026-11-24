// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Participant } from "@superhive/protocol";
import { MemberContextBadge, memberContextHint } from "./member-context";

const agent: Participant = {
  id: "11111111-1111-4111-8111-111111111111",
  roomId: "general",
  username: "rd-claude",
  type: "agent",
  status: "online",
  joinedAt: "2026-11-24T00:00:00.000Z",
  lastSeenAt: "2026-11-24T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("成员的上下文和缓存", () => {
  it("显示上下文、离压缩阈值多远和缓存还剩几分钟", () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-24T11:13:20.000Z") });
    render(
      <MemberContextBadge
        participant={{
          ...agent,
          context: {
            contextTokens: 121_010,
            compactWindow: 400_000,
            contextWindow: 1_000_000,
            cacheExpiresAt: "2026-11-24T12:00:00.000Z",
            at: "2026-11-24T11:00:00.000Z",
          },
        }}
      />,
    );
    const badge = screen.getByText("121k/400k · 缓存 46 分");
    expect(badge.getAttribute("aria-label")).toBe(
      [
        "上一轮结束时上下文 121k token。",
        "离自动压缩阈值 400k 还有 279k。",
        "缓存约剩 46 分钟（从最后一次模型请求算起），过期后下一轮要整段重写缓存。",
      ].join("\n"),
    );
    // 时间到了，跟着变成已过期
    vi.setSystemTime(Date.parse("2026-11-24T12:00:30.000Z"));
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText("121k/400k · 缓存已过期")).toBeTruthy();
  });

  it("模型上下文比阈值小：按模型上限算，并说明；不知道缓存有效期就不显示缓存", () => {
    const context = {
      contextTokens: 180_000,
      compactWindow: 400_000,
      contextWindow: 200_000,
      at: "2026-11-24T11:00:00.000Z",
    };
    render(<MemberContextBadge participant={{ ...agent, context }} />);
    const badge = screen.getByText("180k/200k");
    // 接近阈值：用 warning 色提醒
    expect(badge.className).toContain("warning");
    expect(memberContextHint(context, Date.now())).toContain(
      "设的阈值是 400k，但模型上下文只有 200k，按模型上限压缩。",
    );
  });

  it("没有上下文信息（人、旧版 Bridge、没跑过）就不显示", () => {
    const { container } = render(<MemberContextBadge participant={agent} />);
    expect(container.textContent).toBe("");
  });
});
