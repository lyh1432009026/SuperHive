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
  })),
  cleanupWorktrees: vi.fn(async () => ({
    results: [{ id: "clean", removed: true, branchDeleted: true }],
  })),
  configureWorktreeCleanup: vi.fn(async () => undefined),
  cleanWorktreeBatch: vi.fn(async () => undefined),
});

describe("WorktreePanel", () => {
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
    fireEvent.click(screen.getByText("自动清理已合入的 worktree"));
    expect(client.configureWorktreeCleanup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("确认开启"));
    await waitFor(() =>
      expect(client.configureWorktreeCleanup).toHaveBeenCalledWith("general", true),
    );
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
});
