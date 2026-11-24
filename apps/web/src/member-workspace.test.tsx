// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Participant } from "@superhive/protocol";
import {
  MemberWorkspaceBadge,
  memberWorkspaceCwdHint,
  memberWorkspaceHint,
  memberWorkspaceState,
} from "./member-workspace";

const agent: Participant = {
  id: "11111111-1111-4111-8111-111111111111",
  roomId: "general",
  username: "reader",
  type: "agent",
  status: "online",
  joinedAt: "2026-11-24T00:00:00.000Z",
  lastSeenAt: "2026-11-24T00:00:00.000Z",
};

afterEach(cleanup);

describe("成员的工作目录标记", () => {
  it("和房间当前工作区对比：一致时照实显示，改了还没换过去是待生效，没用上是未用", () => {
    const following = { ...agent, workspace: { cwd: "/code/proj", roomWorkspace: "~/proj" } };
    expect(memberWorkspaceState(following, "~/proj")).toEqual({
      kind: "following",
      cwd: "/code/proj",
    });
    expect(memberWorkspaceState(following, "~/next")).toEqual({
      kind: "pending",
      cwd: "/code/proj",
      next: "~/next",
    });
    // 房间刚设了工作区，Agent 还是按没设的时候建的
    expect(
      memberWorkspaceState({ ...agent, workspace: { cwd: "/home/a" } }, "~/proj"),
    ).toMatchObject({
      kind: "pending",
    });
    expect(
      memberWorkspaceState(
        { ...agent, workspace: { cwd: "/home/a", roomWorkspace: "/gone", note: "不存在" } },
        "/gone",
      ),
    ).toEqual({ kind: "fallback", cwd: "/home/a", note: "不存在" });
    // 旧版 Bridge 不上报、人类成员：不显示
    expect(memberWorkspaceState(agent, "~/proj")).toBeUndefined();
    expect(
      memberWorkspaceState({ ...agent, type: "human", workspace: { cwd: "/x" } }, undefined),
    ).toBeUndefined();
  });

  it("待生效时提示 Agent 空闲后生效，悬停文字写明现在所在的目录", () => {
    const pending = { ...agent, workspace: { cwd: "/code/old", roomWorkspace: "/code/old" } };
    render(<MemberWorkspaceBadge participant={pending} roomWorkspace="/code/new" />);
    const badge = screen.getByText("工作区待生效");
    expect(badge.className).toBe("member-badge warning");
    expect(badge.getAttribute("aria-label")).toBe(
      "房间工作区已改为 /code/new，reader 空闲后生效；现在仍在 /code/old",
    );
    expect(
      memberWorkspaceHint({ kind: "pending", cwd: "/code/old", next: undefined }, "reader"),
    ).toContain("不再设工作区");
  });

  it("正常跟随房间工作区时不挂标签，实际目录放在名字的悬停提示里；没上报时都没有", () => {
    const following = {
      ...agent,
      workspace: { cwd: "D:\\Code\\Proj", roomWorkspace: "D:/Code/Proj" },
    };
    const { container, rerender } = render(
      <MemberWorkspaceBadge participant={following} roomWorkspace="D:/Code/Proj" />,
    );
    expect(container.textContent).toBe("");
    // 设了工作区却没用上：提醒级标签
    rerender(
      <MemberWorkspaceBadge
        participant={{
          ...agent,
          workspace: { cwd: "/home/a", roomWorkspace: "D:/Code/Proj", note: "不存在" },
        }}
        roomWorkspace="D:/Code/Proj"
      />,
    );
    expect(screen.getByText("未用工作区").className).toBe("member-badge warning");
    rerender(<MemberWorkspaceBadge participant={following} roomWorkspace="D:/Code/Proj" />);
    expect(memberWorkspaceCwdHint(following, "D:/Code/Proj")).toBe(
      "在本房间的工作目录：D:\\Code\\Proj",
    );
    rerender(<MemberWorkspaceBadge participant={agent} roomWorkspace="D:/Code/Proj" />);
    expect(container.textContent).toBe("");
    expect(memberWorkspaceCwdHint(agent, "D:/Code/Proj")).toBeUndefined();
  });
});
