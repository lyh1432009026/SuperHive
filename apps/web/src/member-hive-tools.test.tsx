// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Participant } from "@superhive/protocol";
import { MemberHiveToolsBadge, memberHiveToolsHint } from "./member-hive-tools";

const agent: Participant = {
  id: "11111111-1111-4111-8111-111111111111",
  roomId: "general",
  username: "菜包-claude",
  type: "agent",
  status: "online",
  joinedAt: "2026-11-24T00:00:00.000Z",
  lastSeenAt: "2026-11-24T00:00:00.000Z",
};

afterEach(cleanup);

describe("成员的 Hive 工具连不上标记", () => {
  it("连不上时醒目显示，悬停说明少了什么、怎么处理和原因", () => {
    const down: Participant = {
      ...agent,
      hiveTools: {
        status: "unavailable",
        detail: "Claude Code 报告 hive MCP 状态为 failed",
        at: "2026-11-24T00:00:00.000Z",
      },
    };
    render(<MemberHiveToolsBadge participant={down} />);
    const badge = screen.getByText("工具未连上");
    expect(badge.className).toBe("member-badge danger");
    const hint = badge.getAttribute("aria-label") ?? "";
    expect(hint).toContain("菜包-claude 连不上 Hive 工具");
    expect(hint).toContain("读不到附件和图片");
    expect(hint).toContain("原因：Claude Code 报告 hive MCP 状态为 failed");
  });

  it("没有原因时只给说明；连得上、旧版 Bridge 不报、人类成员都不显示", () => {
    expect(
      memberHiveToolsHint({
        ...agent,
        hiveTools: { status: "unavailable", at: "2026-11-24T00:00:00.000Z" },
      }),
    ).not.toContain("原因");
    const { container } = render(<MemberHiveToolsBadge participant={agent} />);
    expect(container.textContent).toBe("");
    expect(
      memberHiveToolsHint({
        ...agent,
        type: "human",
        hiveTools: { status: "unavailable", at: "2026-11-24T00:00:00.000Z" },
      }),
    ).toBeUndefined();
  });
});
