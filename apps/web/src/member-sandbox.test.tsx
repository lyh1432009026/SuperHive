// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Participant } from "@superhive/protocol";
import { MemberSandboxBadge, noSandboxNote, workspaceLacksSandbox } from "./member-sandbox";

const agent: Participant = {
  id: "11111111-1111-4111-8111-111111111111",
  roomId: "general",
  username: "win-claude",
  type: "agent",
  status: "online",
  joinedAt: "2026-11-24T00:00:00.000Z",
  lastSeenAt: "2026-11-24T00:00:00.000Z",
};

afterEach(cleanup);

describe("工作区档没有系统沙箱的标记", () => {
  it("Agent 上报 noSandbox 时在名字旁显示「无沙箱」，悬停看到和设置弹窗一样的说明", () => {
    render(
      <MemberSandboxBadge
        participant={{ ...agent, workspace: { cwd: "C:\\code\\proj", noSandbox: true } }}
      />,
    );
    const badge = screen.getByText("无沙箱");
    // 低调：不用 warning / danger 语义色
    expect(badge.className).toBe("member-workspace-badge");
    expect(badge.getAttribute("aria-label")).toBe(noSandboxNote());
    expect(noSandboxNote()).toContain("Windows 上没有系统沙箱");
    expect(noSandboxNote()).toContain("有风险的操作靠 Claude 的自动审核拦下，或先请你确认");
  });

  it("有沙箱、旧版 Bridge 不报、人类成员都不显示", () => {
    for (const participant of [
      { ...agent, workspace: { cwd: "/code/proj" } },
      agent,
      { ...agent, type: "human" as const, workspace: { cwd: "/x", noSandbox: true } },
    ]) {
      const { container } = render(<MemberSandboxBadge participant={participant} />);
      expect(container.textContent).toBe("");
      cleanup();
    }
  });

  it("设置弹窗只在 Server（本机 Agent 所在电脑）是 Windows、Claude Code、工作区档时说明", () => {
    expect(workspaceLacksSandbox("claude", "workspace", "win32")).toBe(true);
    expect(workspaceLacksSandbox("claude", "workspace", "darwin")).toBe(false);
    expect(workspaceLacksSandbox("claude", "workspace", "linux")).toBe(false);
    // 旧版 Server 不报平台：不猜
    expect(workspaceLacksSandbox("claude", "workspace", undefined)).toBe(false);
    expect(workspaceLacksSandbox("claude", "read-only", "win32")).toBe(false);
    expect(workspaceLacksSandbox("claude", "full", "win32")).toBe(false);
    expect(workspaceLacksSandbox("codex", "workspace", "win32")).toBe(false);
  });
});
