// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlowOperationsResponse } from "@superhive/protocol";
import type { LocalAgentsState } from "./local-agents";
import { SlowOpsGroup, formatDuration } from "./slow-ops";

function localWith(slowOps: () => Promise<SlowOperationsResponse>): LocalAgentsState {
  return { slowOps } as unknown as LocalAgentsState;
}

const settings = { thresholdMs: 3000, requestThresholdMs: 5000, capacity: 200 };

describe("SlowOpsGroup", () => {
  afterEach(cleanup);

  it("lists recent slow operations with how long they waited for the lock", async () => {
    const slowOps = vi.fn(async () => ({
      ...settings,
      operations: [
        {
          id: "1",
          at: new Date().toISOString(),
          kind: "lock" as const,
          name: "worktrees.lock runtimeWorkspaces",
          durationMs: 120,
          waitMs: 25_400,
          source: "POST /api/agent/worktree",
          repo: "/Users/me/Coding/ai-hive",
        },
        {
          id: "2",
          at: new Date().toISOString(),
          kind: "git" as const,
          name: "git status",
          durationMs: 4_200,
          failed: true,
        },
      ],
    }));
    render(<SlowOpsGroup local={localWith(slowOps)} />);
    expect(await screen.findByText("worktrees.lock runtimeWorkspaces")).toBeTruthy();
    expect(screen.getByText("等锁 25 秒")).toBeTruthy();
    expect(screen.getByText("120 毫秒")).toBeTruthy();
    expect(screen.getByText("4.2 秒")).toBeTruthy();
    expect(screen.getByText(/来自 POST \/api\/agent\/worktree/)).toBeTruthy();
    // 仓库只显示目录名，悬停看全路径
    expect(screen.getByTitle("/Users/me/Coding/ai-hive").textContent).toBe("ai-hive");
    expect(screen.getByText("git status").closest("li")?.className).toBe("failed");
    expect(screen.getByText(/记录阈值：操作 3 秒，请求 5 秒/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByRole("button", { name: "刷新" });
    expect(slowOps).toHaveBeenCalledTimes(2);
  });

  it("says so when nothing has been slow, and shows errors", async () => {
    const { unmount } = render(
      <SlowOpsGroup local={localWith(async () => ({ ...settings, operations: [] }))} />,
    );
    expect(await screen.findByText("最近没有慢操作。")).toBeTruthy();
    unmount();
    render(
      <SlowOpsGroup
        local={localWith(async () => {
          throw new Error("只限本机");
        })}
      />,
    );
    expect(await screen.findByText("只限本机")).toBeTruthy();
  });

  it("formats durations", () => {
    expect(formatDuration(850.4)).toBe("850 毫秒");
    expect(formatDuration(3_000)).toBe("3 秒");
    expect(formatDuration(112_345)).toBe("112 秒");
  });
});
