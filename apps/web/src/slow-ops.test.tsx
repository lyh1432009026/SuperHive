// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlowOperation } from "@superhive/protocol";
import {
  SlowOpsIndicator,
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
  return (
    <>
      <SlowOpsIndicator state={state} />
      {state.enabled && <SlowOpsSettingsEntry state={state} onOpen={() => state.setOpen(true)} />}
    </>
  );
}

/** 模拟服务端在连上时发来的全集 */
function renderLoaded(operations: SlowOperation[]) {
  render(<Harness />);
  act(() => latest!.receiveSnapshot({ ...settings, operations }));
}

describe("slow operation alerts", () => {
  beforeEach(() => {
    localStorage.clear();
    latest = undefined;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("lights the header button with the unread count and lists details in the popover", async () => {
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
    const button = screen.getByRole("button", { name: "性能：2 条未读慢操作" });
    expect(button.className).toContain("has-unread");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    // 没点开之前不出现列表
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: /最近慢操作/ });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(dialog.textContent).toContain("worktrees.lock runtimeWorkspaces");
    expect(screen.getByText("等锁 25 秒")).toBeTruthy();
    expect(screen.getByText("120 毫秒")).toBeTruthy();
    expect(screen.getByText("4.2 秒")).toBeTruthy();
    expect(screen.getByText(/来自 POST \/api\/agent\/worktree/)).toBeTruthy();
    expect(screen.getByTitle("/Users/me/Coding/ai-hive").textContent).toBe("ai-hive");
    expect(screen.getByText("git fetch").closest("li")?.className).toContain("failed");
    expect(
      screen.getByText(/记录超过 3 秒（请求 5 秒）的操作；合计超过 15 秒\s?或等锁超过 10 秒/),
    ).toBeTruthy();
    // 焦点进到弹层标题，读屏知道打开了什么
    expect(document.activeElement?.id).toBe("slow-ops-popover-title");

    fireEvent.click(screen.getByRole("button", { name: "标为已读" }));
    expect(screen.getByRole("button", { name: "性能：最近慢操作" }).className).not.toContain(
      "has-unread",
    );
    expect(screen.getByRole("button", { name: "标为已读" })).toHaveProperty("disabled", true);
    expect(localStorage.getItem("superhive.slow-ops-read-at")).toBeTruthy();
    expect(document.querySelectorAll(".slow-ops li.unread")).toHaveLength(0);

    // Esc 关掉，焦点回到按钮
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "性能：最近慢操作" }));
  });

  it("counts pushed operations as unread, and only those newer than the last read mark", async () => {
    const old = op({ at: new Date(Date.now() - 60_000).toISOString() });
    localStorage.setItem("superhive.slow-ops-read-at", old.at);
    renderLoaded([old]);
    expect(screen.getByRole("button", { name: "性能：最近慢操作" })).toBeTruthy();
    act(() => latest!.receive(op({ name: "git log" })));
    expect(screen.getByRole("button", { name: "性能：1 条未读慢操作" })).toBeTruthy();
    // 同一条推两次（重连后拉全集）不重复计
    act(() => latest!.receive(latest!.operations[0]!));
    expect(latest!.operations).toHaveLength(2);
    expect(screen.getByRole("button", { name: "查看（1 条未读）" })).toBeTruthy();
  });

  it("pops one toast for a very slow operation and merges repeats of the same name", async () => {
    renderLoaded([]);
    // 没到提醒阈值的不弹
    act(() => latest!.receive(op({ name: "git status" })));
    expect(screen.queryByRole("status")).toBeNull();

    act(() =>
      latest!.receive(
        op({
          kind: "lock",
          name: "worktrees.lock create",
          durationMs: 5,
          waitMs: 12_000,
          alert: true,
        }),
      ),
    );
    const toast = screen.getByRole("status");
    expect(toast.textContent).toContain("Server 有操作特别慢");
    expect(toast.textContent).toContain("worktrees.lock create 等锁 12 秒");

    act(() =>
      latest!.receive(
        op({
          kind: "lock",
          name: "worktrees.lock create",
          durationMs: 5,
          waitMs: 14_000,
          alert: true,
        }),
      ),
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toContain("等锁 14 秒 ×2");

    // 关掉后，同名的在合并窗口内再来也不重新弹
    fireEvent.click(screen.getByRole("button", { name: "关闭提醒" }));
    act(() =>
      latest!.receive(
        op({
          kind: "lock",
          name: "worktrees.lock create",
          durationMs: 5,
          waitMs: 11_000,
          alert: true,
        }),
      ),
    );
    expect(screen.queryByRole("status")).toBeNull();

    // 别的操作照常弹；点提示打开弹层，提示收起
    act(() => latest!.receive(op({ name: "git push", durationMs: 20_000, alert: true })));
    expect(screen.getByRole("status").textContent).toContain("git push 用了 20 秒");
    fireEvent.click(screen.getByTitle("查看最近慢操作"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    // 同名的三次锁合成一行
    expect(screen.getByText("×3")).toBeTruthy();
    expect(screen.getByText("最长 5 毫秒")).toBeTruthy();
    expect(screen.getByText("等锁 14 秒")).toBeTruthy();
    // 弹层开着时不再弹提示
    act(() => latest!.receive(op({ name: "git gc", durationMs: 30_000, alert: true })));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("hides the toast by itself after a while", async () => {
    renderLoaded([]);
    vi.useFakeTimers();
    act(() => latest!.receive(op({ name: "git push", durationMs: 20_000, alert: true })));
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stays hidden until the server sends a snapshot, which only the local owner gets", () => {
    render(<Harness />);
    expect(screen.queryByRole("button", { name: /性能/ })).toBeNull();
    // 推来的单条不会让它出现：先得有全集
    act(() => latest!.receive(op({ alert: true, durationMs: 20_000 })));
    expect(latest!.enabled).toBe(false);
    act(() => latest!.receiveSnapshot({ ...settings, operations: [] }));
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    expect(screen.getByText("最近没有慢操作。")).toBeTruthy();
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
