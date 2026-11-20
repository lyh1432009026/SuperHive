// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SlowOperation } from "@superhive/protocol";
import {
  SlowOpsSettingsEntry,
  formatDuration,
  groupSlowOps,
  useSlowOps,
  type SlowOpsState,
} from "./slow-ops";

const settings = {
  thresholdMs: 3000,
  requestThresholdMs: 5000,
  capacity: 200,
  alertMs: 15_000,
  lockWaitAlertMs: 10_000,
};

let sequence = 0;
function op(overrides: Partial<SlowOperation> & { at?: string } = {}): SlowOperation {
  sequence++;
  return {
    id: `op-${sequence}`,
    at: new Date().toISOString(),
    kind: "git",
    name: "git status",
    durationMs: 4_000,
    ...overrides,
  };
}

let latest: SlowOpsState | undefined;
function Harness() {
  const state = useSlowOps();
  latest = state;
  return state.enabled ? <SlowOpsSettingsEntry state={state} /> : null;
}

/** 模拟服务端在连上时发来的全集 */
function renderLoaded(operations: SlowOperation[]) {
  render(<Harness />);
  act(() => latest!.receiveSnapshot({ ...settings, operations }));
}

describe("recent slow operations", () => {
  beforeEach(() => {
    latest = undefined;
  });
  afterEach(() => {
    cleanup();
  });

  it("lists details in settings only, without a header button or pop-up notices", () => {
    renderLoaded([
      op({
        kind: "lock",
        name: "worktrees.lock runtimeWorkspaces",
        durationMs: 120,
        waitMs: 25_400,
        source: "POST /api/agent/worktree",
        repo: "/Users/me/Coding/ai-hive",
      }),
      op({ name: "git fetch", durationMs: 4_200, failed: true }),
    ]);
    // 特别慢的也不弹提示
    act(() => latest!.receive(op({ name: "git push", durationMs: 20_000, alert: true })));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    const toggle = screen.getByRole("button", { name: "查看（3 条）" });
    expect(screen.queryByRole("list", { name: "最近慢操作" })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("list", { name: "最近慢操作" });
    expect(list.textContent).toContain("worktrees.lock runtimeWorkspaces");
    expect(screen.getByText("等锁 25 秒")).toBeTruthy();
    expect(screen.getByText("120 毫秒")).toBeTruthy();
    expect(screen.getByText(/来自 POST \/api\/agent\/worktree/)).toBeTruthy();
    expect(screen.getByTitle("/Users/me/Coding/ai-hive").textContent).toBe("ai-hive");
    expect(screen.getByText("git fetch").closest("li")?.className).toContain("failed");
    expect(screen.getByText(/记录超过 3 秒（请求 5 秒）的操作/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.queryByRole("list", { name: "最近慢操作" })).toBeNull();
  });

  it("does not count the same pushed operation twice", () => {
    renderLoaded([op({ name: "git status" })]);
    act(() => latest!.receive(op({ name: "git log" })));
    act(() => latest!.receive(latest!.operations[0]!));
    expect(latest!.operations).toHaveLength(2);
    expect(screen.getByRole("button", { name: "查看（2 条）" })).toBeTruthy();
  });

  it("stays hidden until the server sends a snapshot, which only the local owner gets", () => {
    render(<Harness />);
    expect(screen.queryByRole("heading", { name: "最近慢操作" })).toBeNull();
    // 推来的单条不会让它出现：先得有全集
    act(() => latest!.receive(op({ alert: true, durationMs: 20_000 })));
    expect(latest!.enabled).toBe(false);
    act(() => latest!.receiveSnapshot({ ...settings, operations: [] }));
    expect((screen.getByRole("button", { name: "没有记录" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("replaces the list with a new snapshot after reconnecting", () => {
    renderLoaded([op({ name: "git fetch" }), op({ name: "git log" })]);
    expect(latest!.operations).toHaveLength(2);
    // Server 重启后全集变短：以新的全集为准
    act(() => latest!.receiveSnapshot({ ...settings, operations: [op({ name: "git push" })] }));
    expect(latest!.operations.map((item) => item.name)).toEqual(["git push"]);
  });

  it("groups the same operation within a minute, keeping the slowest duration", () => {
    const base = Date.parse("2026-11-19T10:00:00Z");
    const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
    const groups = groupSlowOps([
      op({ id: "a", at: at(100), durationMs: 3_000 }),
      op({ id: "b", at: at(90), name: "git log", durationMs: 3_000 }),
      op({ id: "c", at: at(60), durationMs: 9_000 }),
      op({ id: "d", at: at(10), durationMs: 4_000 }),
      // 和上一次隔了 70 秒：另起一组
      op({ id: "e", at: at(-60), durationMs: 4_000 }),
    ]);
    expect(groups.map((group) => [group.latest.id, group.slowest.id, group.count])).toEqual([
      ["a", "c", 3],
      ["b", "b", 1],
      ["e", "e", 1],
    ]);
  });

  it("formats durations", () => {
    expect(formatDuration(850.4)).toBe("850 毫秒");
    expect(formatDuration(3_000)).toBe("3 秒");
    expect(formatDuration(112_345)).toBe("112 秒");
  });
});
