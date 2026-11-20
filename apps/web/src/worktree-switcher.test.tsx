// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceOverview, WorktreeStatus } from "@superhive/protocol";
import { switcherRows, WorktreeSwitcher } from "./worktree-switcher";

afterEach(cleanup);

const status = (
  id: string,
  overrides: Partial<WorktreeStatus> = {},
  createdAt = "2026-11-20T08:00:00.000Z",
): WorktreeStatus => ({
  worktree: {
    id,
    repo: "/repo",
    commonDir: "/repo/.git",
    path: `/repo-wt/${id}`,
    branch: `feat/${id}`,
    base: "main",
    baseCommit: "a".repeat(40),
    target: "main",
    slug: id,
    roomId: "general",
    agentName: `agent-${id}`,
    ownerName: "Alice",
    invocationIds: [],
    createdAt,
    phase: "ready",
  },
  dirty: false,
  untracked: false,
  ignored: false,
  merged: false,
  removable: false,
  activeInvocationIds: [],
  headCommit: "b".repeat(40),
  ...overrides,
});

const overview = (activity: Record<string, string>, changeCount = 0): WorkspaceOverview => ({
  configured: true,
  name: "repo",
  git: true,
  changeCount,
  guestsAllowed: false,
  canReveal: true,
  sources: [
    { id: "workspace", kind: "workspace", label: "repo", branch: "main", changeCount },
    ...Object.entries(activity).map(([id, activeAt]) => ({
      id,
      kind: "worktree" as const,
      label: `feat/${id}`,
      activeAt,
    })),
  ],
});

describe("switcherRows", () => {
  it("puts the room workspace first, then unmerged by latest change, merged, missing", () => {
    const rows = switcherRows(
      [
        status("merged", { merged: true, removable: true }),
        status("old"),
        status("gone", { missing: true }),
        status("fresh"),
        status("untouched", {}, "2026-11-20T09:00:00.000Z"),
      ],
      overview({
        merged: "2026-11-20T11:00:00.000Z",
        old: "2026-11-20T10:00:00.000Z",
        fresh: "2026-11-20T12:00:00.000Z",
      }),
      { branch: "main" },
    );
    expect(rows.map((row) => row.id)).toEqual([
      "workspace",
      "fresh",
      "old",
      "untouched",
      "merged",
      "gone",
    ]);
    expect(rows[0]).toMatchObject({ current: true, branch: "main" });
    expect(rows.find((row) => row.id === "untouched")?.time).toEqual({
      iso: "2026-11-20T09:00:00.000Z",
      created: true,
    });
  });

  it("labels merge state, uncommitted changes, blocking files and cleanup", () => {
    const [, dirty, mergedDirty, switched, merged] = switcherRows(
      [
        status("dirty", { dirty: true, ignored: true, activeInvocationIds: ["x"] }),
        // 还没提交过（或提交都已合入）但目录里有改动：活还没交，不写「已合入」，排在未合入一档
        status("merged-dirty", { merged: true, untracked: true }),
        status("switched", { branchSwitched: { registered: "feat/switched", current: "hack" } }),
        status("merged", { merged: true, removable: true }),
      ],
      undefined,
      { branch: "main" },
    );
    expect(dirty!.chips.map((chip) => chip.label)).toEqual([
      "未合入",
      "有未提交改动",
      "有挡住清理的文件",
      "有任务在用",
    ]);
    expect(mergedDirty!.chips.map((chip) => chip.label)).toEqual(["有未提交改动"]);
    // 换了分支就没法判断登记的分支合没合入，不写合入状态
    expect(switched!.chips.map((chip) => chip.label)).toEqual(["分支被切换为 hack"]);
    expect(merged!.chips.map((chip) => chip.label)).toEqual(["已合入", "可清理"]);
    expect(merged!.removable).toBe(true);
  });

  it("falls back to the room's branch when the workspace overview is unavailable", () => {
    const [workspace] = switcherRows([], undefined, { branch: "develop" });
    expect(workspace).toMatchObject({ branch: "develop", chips: [] });
  });

  it("shows how many files are uncommitted in the workspace", () => {
    const [workspace] = switcherRows([], overview({}, 3), { branch: "main" });
    expect(workspace!.chips).toEqual([{ label: "3 个文件未提交", tone: "warning" }]);
  });
});

function setup(options: { fail?: boolean } = {}) {
  const props = {
    branch: "main",
    loadWorktrees: vi.fn(async () => {
      if (options.fail) throw new Error("boom");
      return { worktrees: [status("a"), status("b", { merged: true, removable: true })] };
    }),
    loadOverview: vi.fn(async () => overview({ a: new Date().toISOString() })),
    onOpenSource: vi.fn(),
    onManage: vi.fn(),
  };
  render(<WorktreeSwitcher {...props} />);
  const toggle = screen.getByRole("button", { name: /main/ });
  return { props, toggle };
}

describe("WorktreeSwitcher", () => {
  it("opens a list of task directories with the workspace marked current", async () => {
    const { props, toggle } = setup();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const dialog = await screen.findByRole("dialog", { name: "任务目录" });
    await within(dialog).findByText("feat/a");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(dialog).getByText("2 条任务线 · 1 个可清理")).toBeTruthy();
    const rows = within(dialog).getAllByRole("button", { name: /^(main|feat)/ });
    expect(rows.map((row) => row.querySelector("code")?.textContent)).toEqual([
      "main",
      "feat/a",
      "feat/b",
    ]);
    expect(rows[0]!.getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(rows[0]);
    expect(props.loadWorktrees).toHaveBeenCalledTimes(1);
  });

  it("opens the task line in the code panel when a row is clicked", async () => {
    const { props, toggle } = setup();
    fireEvent.click(toggle);
    fireEvent.click(await screen.findByRole("button", { name: /feat\/a/ }));
    expect(props.onOpenSource).toHaveBeenCalledWith("a");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves between rows with arrow keys and closes on Escape", async () => {
    const { toggle } = setup();
    fireEvent.click(toggle);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("feat/a");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("feat/a");
    fireEvent.keyDown(dialog, { key: "End" });
    expect(document.activeElement?.textContent).toBe("在 Worktree 列表里管理");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("main");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it("closes when clicking outside", async () => {
    const { toggle } = setup();
    fireEvent.click(toggle);
    await screen.findByRole("dialog");
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("hands off to the full Worktree list for management", async () => {
    const { props, toggle } = setup();
    fireEvent.click(toggle);
    fireEvent.click(await screen.findByRole("button", { name: "在 Worktree 列表里管理" }));
    expect(props.onManage).toHaveBeenCalledWith(toggle);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says so when the task directories can't be loaded", async () => {
    const { toggle } = setup({ fail: true });
    fireEvent.click(toggle);
    expect((await screen.findByRole("alert")).textContent).toBe("没能读取任务目录：boom");
    // 读不到也能去完整列表
    expect(screen.getByRole("button", { name: "在 Worktree 列表里管理" })).toBeTruthy();
  });
});
