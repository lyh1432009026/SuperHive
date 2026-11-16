// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhiteboardEntry } from "@superhive/protocol";
import { WhiteboardPanel, upsertWhiteboardEntry } from "./whiteboard";

const entry = (key: string, extra: Partial<WhiteboardEntry> = {}): WhiteboardEntry => ({
  id: key,
  key,
  roomId: "general",
  slot: "ready",
  summary: `Summary ${key}`,
  unblocks: [],
  authorId: "author",
  authorName: "helper",
  createdAt: "2026-11-16T00:00:00Z",
  updatedAt: "2026-11-16T00:00:00Z",
  ...extra,
});
const asMap = (entries: WhiteboardEntry[]) => new Map(entries.map((entry) => [entry.id, entry]));
const props = () => ({
  canManage: true,
  onRemove: vi.fn(),
  onArchive: vi.fn(async () => {}),
  loadHistory: vi.fn(async () => {}),
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WhiteboardPanel lifecycle", () => {
  it("defaults to current items, filters slots and disables protected selections", async () => {
    const user = userEvent.setup();
    render(
      <WhiteboardPanel
        {...props()}
        entries={asMap([
          entry("ready"),
          entry("blocked", { slot: "blocked" }),
          entry("active", { slot: "in_progress" }),
          entry("claimed", { archiveProtected: true }),
          entry("history", { archivedAt: "2026-11-16T00:01:00Z" }),
        ])}
      />,
    );
    expect(screen.queryByText("Summary history")).toBeNull();
    // 只有仍占用工作区的不能选；进行中、阻塞的旧条目房主可以手动勾选归档
    expect(
      (screen.getByRole("checkbox", { name: "选择事项：claimed" }) as HTMLInputElement).disabled,
    ).toBe(true);
    for (const key of ["blocked", "active"])
      expect(
        (screen.getByRole("checkbox", { name: `选择事项：${key}` }) as HTMLInputElement).disabled,
      ).toBe(false);
    await user.selectOptions(screen.getByRole("combobox", { name: "状态筛选" }), "blocked");
    expect(screen.getByText("Summary blocked")).toBeTruthy();
    expect(screen.queryByText("Summary ready")).toBeNull();
  });

  it("archives only eligible selected items after confirmation", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    const ready = entry("ready");
    const milestone = entry("milestone", { slot: "milestone" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <WhiteboardPanel
        {...callbacks}
        entries={asMap([
          ready,
          milestone,
          entry("active", { slot: "in_progress" }),
          entry("claimed", { archiveProtected: true }),
        ])}
      />,
    );
    await user.click(screen.getByRole("button", { name: "选择可归档事项" }));
    await user.click(screen.getByRole("button", { name: "归档所选 (2)" }));
    expect(callbacks.onArchive).toHaveBeenCalledWith([ready, milestone], true);
    expect(window.confirm).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "归档所选 (0)" }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
  });

  it("loads history and restores a selected batch without deleting it", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    const archived = entry("history", { archivedAt: "2026-11-16T00:01:00Z" });
    render(<WhiteboardPanel {...callbacks} entries={asMap([archived])} />);
    expect(screen.getByText("白板还是空的")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "历史归档" }));
    await waitFor(() => expect(callbacks.loadHistory).toHaveBeenCalledOnce());
    expect(screen.getByText("Summary history")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "选择历史事项" }));
    await user.click(screen.getByRole("button", { name: "恢复所选 (1)" }));
    expect(callbacks.onArchive).toHaveBeenCalledWith([archived], false);
    expect(callbacks.onRemove).not.toHaveBeenCalled();
  });

  it("hides management controls from guests", async () => {
    const user = userEvent.setup();
    render(
      <WhiteboardPanel
        {...props()}
        canManage={false}
        entries={asMap([entry("ready"), entry("history", { archivedAt: "2026-11-16T00:01:00Z" })])}
      />,
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "选择可归档事项" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "历史归档" }));
    expect(screen.queryByRole("button", { name: "恢复事项：history" })).toBeNull();
    expect(screen.queryByRole("button", { name: "从白板移除：Summary history" })).toBeNull();
  });

  it("clears stale selections and ignores older snapshots", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    const previous = entry("ready");
    const entries = asMap([previous]);
    const { rerender } = render(<WhiteboardPanel {...callbacks} entries={entries} />);
    await user.click(screen.getByRole("checkbox", { name: "选择事项：ready" }));
    const changed = { ...previous, updatedAt: "2026-11-16T00:02:00Z", slot: "blocked" as const };
    const current = upsertWhiteboardEntry(entries, changed);
    rerender(<WhiteboardPanel {...callbacks} entries={current} />);
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "归档所选 (0)" }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    expect(upsertWhiteboardEntry(current, previous)).toBe(current);
  });

  it("cancels archives and displays failed operations without hiding their entries", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    callbacks.onArchive.mockRejectedValue(new Error("conflict"));
    render(<WhiteboardPanel {...callbacks} entries={asMap([entry("ready")])} />);
    await user.click(screen.getByRole("button", { name: "归档事项：ready" }));
    expect(callbacks.onArchive).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "归档事项：ready" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("conflict"));
    expect(screen.getByText("Summary ready")).toBeTruthy();
  });

  it("reports history loading failures and allows an explicit retry", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    callbacks.loadHistory.mockRejectedValueOnce(new Error("unavailable"));
    render(<WhiteboardPanel {...callbacks} entries={asMap([])} />);
    await user.click(screen.getByRole("button", { name: "历史归档" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("unavailable"));
    await user.click(screen.getByRole("button", { name: "刷新历史" }));
    await waitFor(() => expect(callbacks.loadHistory).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
