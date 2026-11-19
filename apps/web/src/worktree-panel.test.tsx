// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorktreeStatus } from "@superhive/protocol";
import { WorktreePanel } from "./worktree-panel";

afterEach(cleanup);
const row = (id: string, removable: boolean): WorktreeStatus => ({
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
    agentName: "agent",
    ownerName: "Alice",
    invocationIds: [],
    createdAt: new Date().toISOString(),
    phase: "ready",
  },
  dirty: !removable,
  untracked: false,
  ignored: false,
  merged: true,
  removable,
  activeInvocationIds: [],
  headCommit: "b".repeat(40),
});
const api = (canManage = true) => ({
  canManage,
  worktrees: vi.fn(async () => ({
    worktrees: [row("clean", true), row("dirty", false)],
    autoCleanup: false,
    cleanupBatch: null as { id: string; count: number } | null,
  })),
  cleanupWorktrees: vi.fn(async () => ({
    results: [{ id: "clean", removed: true, branchDeleted: true }],
  })),
  configureWorktreeCleanup: vi.fn(async () => undefined),
  cleanWorktreeBatch: vi.fn(async () => undefined),
  repairWorktree: vi.fn(async () => undefined),
});

describe("WorktreePanel", () => {
  it("flags a checkout whose branch was switched and offers the two safe fixes", async () => {
    const client = api();
    const switched = (dirty: boolean): WorktreeStatus => ({
      ...row("slow-ops", false),
      dirty,
      merged: false,
      error: "任务目录 /repo-wt/slow-ops 登记的分支是 feat/slow-ops，现在却在 feat/card-tiers",
      branchSwitched: { registered: "feat/slow-ops", current: "feat/card-tiers" },
    });
    client.worktrees
      .mockResolvedValueOnce({
        worktrees: [switched(true)],
        autoCleanup: false,
        cleanupBatch: null,
      })
      .mockResolvedValue({ worktrees: [switched(false)], autoCleanup: false, cleanupBatch: null });
    render(<WorktreePanel roomId="general" api={client} />);
    await screen.findByText("分支已被切换：登记 feat/slow-ops，当前 feat/card-tiers");
    // 有未提交文件：不能切回，但能按当前分支重新登记；原始报错不再重复显示
    expect(screen.getByRole("button", { name: "切回登记分支" })).toHaveProperty("disabled", true);
    screen.getByText("目录里有未提交或未跟踪的文件，不能切回；可以按当前分支重新登记。");
    expect(screen.queryByText(/现在却在 feat\/card-tiers$/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "切回登记分支" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "切回登记分支" }));
    await waitFor(() =>
      expect(client.repairWorktree).toHaveBeenCalledWith("general", "slow-ops", "restore"),
    );
    await screen.findByText("已切回登记的分支 feat/slow-ops。");
    fireEvent.click(screen.getByRole("button", { name: "按当前分支重新登记" }));
    await waitFor(() =>
      expect(client.repairWorktree).toHaveBeenCalledWith("general", "slow-ops", "adopt"),
    );
  });

  it("explains a refused fix and disables both while a task uses the checkout", async () => {
    const client = api();
    client.worktrees.mockResolvedValue({
      worktrees: [
        {
          ...row("busy", false),
          dirty: false,
          activeInvocationIds: ["task"],
          branchSwitched: { registered: "feat/busy", current: "feat/other" },
        },
      ],
      autoCleanup: false,
      cleanupBatch: null,
    });
    render(<WorktreePanel roomId="general" api={client} />);
    await screen.findByText("还有任务在用这个目录，结束后才能处理。");
    expect(screen.getByRole("button", { name: "切回登记分支" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "按当前分支重新登记" })).toHaveProperty(
      "disabled",
      true,
    );
    client.worktrees.mockResolvedValue({
      worktrees: [
        { ...row("busy", false), branchSwitched: { registered: "feat/busy", current: "feat/x" } },
      ],
      autoCleanup: false,
      cleanupBatch: null,
    });
    client.repairWorktree.mockRejectedValueOnce(
      new Error("分支 feat/x 已被另一条任务线登记或占用"),
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    const adopt = await screen.findByRole("button", { name: "按当前分支重新登记" });
    await waitFor(() => expect(adopt).toHaveProperty("disabled", false));
    fireEvent.click(adopt);
    await screen.findByText("分支 feat/x 已被另一条任务线登记或占用");
  });

  it("only selects eligible checkouts and requires confirmation with an exact commit snapshot", async () => {
    const client = api();
    render(<WorktreePanel roomId="general" api={client} />);
    await screen.findByText("feat/clean");
    expect((screen.getByLabelText("选择目录 feat/dirty") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("选择可清理项（1）"));
    fireEvent.click(screen.getByText("清理选中（1）"));
    expect(client.cleanupWorktrees).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("确认清理"));
    await waitFor(() =>
      expect(client.cleanupWorktrees).toHaveBeenCalledWith("general", {
        items: [{ id: "clean", headCommit: "b".repeat(40) }],
        deleteBranch: true,
      }),
    );
    await screen.findByText("已清理 1 个目录，保留 0 个。");
  });

  it("keeps automatic cleanup off until explicitly confirmed", async () => {
    const client = api();
    render(<WorktreePanel roomId="general" api={client} />);
    await screen.findByText("feat/clean");
    const checkbox = screen.getByRole("checkbox", { name: /自动清理已合入的 worktree/ });
    // 点勾选框：就地弹出确认气泡，确认前不勾上、不调接口
    fireEvent.click(checkbox);
    const popover = screen.getByRole("dialog", { name: "确认开启自动清理" });
    expect(checkbox).toHaveProperty("checked", false);
    expect(client.configureWorktreeCleanup).not.toHaveBeenCalled();
    // Esc 收起，焦点回到勾选框
    fireEvent.keyDown(popover, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "确认开启自动清理" })).toBeNull();
    expect(document.activeElement).toBe(checkbox);
    // 再点一次，确认后才勾上
    fireEvent.click(checkbox);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "开启" }));
    fireEvent.click(screen.getByRole("button", { name: "开启" }));
    await waitFor(() =>
      expect(client.configureWorktreeCleanup).toHaveBeenCalledWith("general", true),
    );
    await waitFor(() => expect(checkbox).toHaveProperty("checked", true));
    expect(screen.queryByRole("dialog", { name: "确认开启自动清理" })).toBeNull();
  });

  it("invalidates a selection when a branch tip changes during review", async () => {
    const client = api();
    render(<WorktreePanel roomId="general" api={client} />);
    await screen.findByText("feat/clean");
    fireEvent.click(screen.getByText("选择可清理项（1）"));
    fireEvent.click(screen.getByText("清理选中（1）"));
    client.worktrees.mockResolvedValue({
      worktrees: [{ ...row("clean", true), headCommit: "c".repeat(40) }],
      autoCleanup: false,
      cleanupBatch: null,
    });
    fireEvent.click(screen.getByText("刷新"));
    await waitFor(() =>
      expect((screen.getByText("确认清理") as HTMLButtonElement).disabled).toBe(true),
    );
    expect(client.cleanupWorktrees).not.toHaveBeenCalled();
  });

  it("does not allow a device without management approval to mutate", async () => {
    const client = api(false);
    render(<WorktreePanel roomId="general" api={client} />);
    await screen.findByText("feat/clean");
    expect((screen.getByLabelText("选择目录 feat/clean") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByText("选择可清理项（1）") as HTMLButtonElement).disabled).toBe(true);
    expect(client.cleanupWorktrees).not.toHaveBeenCalled();
  });

  it("removes a stale batch action after the last eligible checkout is cleaned", async () => {
    const client = api();
    let cleaned = false;
    client.worktrees.mockImplementation(async () => ({
      worktrees: cleaned ? [row("dirty", false)] : [row("clean", true), row("dirty", false)],
      autoCleanup: false,
      cleanupBatch: { id: "batch", count: 1 },
    }));
    client.cleanupWorktrees.mockImplementation(async () => {
      cleaned = true;
      return { results: [{ id: "clean", removed: true, branchDeleted: true }] };
    });
    render(<WorktreePanel roomId="general" api={client} />);
    await screen.findByText("清理这批目录");
    fireEvent.click(screen.getByText("选择可清理项（1）"));
    fireEvent.click(screen.getByText("清理选中（1）"));
    fireEvent.click(screen.getByText("确认清理"));
    await waitFor(() => expect(screen.queryByText("清理这批目录")).toBeNull());
    expect(client.cleanWorktreeBatch).not.toHaveBeenCalled();
  });
});
