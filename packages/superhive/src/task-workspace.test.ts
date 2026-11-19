import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveTaskWorkspace,
  resolveTaskWorkspaces,
  sanitizeServerReason,
  TaskWorkspaceBusyError,
  TaskWorkspaceRemovedError,
} from "./task-workspace.js";
import { AgentNonRetryableError } from "./responder.js";

const hive = { serverUrl: "http://hive", roomId: "general", username: "writer", token: "test" };
let directory: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "hive-workspace-resolution-")));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

const quickRetry = { attempts: 3, timeoutMs: 50, delaysMs: [1, 2], sleep: vi.fn(async () => {}) };

describe("task workspace resolution", () => {
  it("retries a busy or timed-out lookup with backoff and then selects the workspace", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      )
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          worktree: { path: directory, agentName: hive.username, roomId: hive.roomId },
        }),
      );
    vi.stubGlobal("fetch", fetch);
    quickRetry.sleep.mockClear();
    expect(await resolveTaskWorkspace(hive, "message", quickRetry)).toBe(directory);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(quickRetry.sleep.mock.calls).toEqual([[1], [2]]);
  });

  it.each([
    () =>
      Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    () => Promise.reject(new TypeError("fetch failed")),
    () => Promise.resolve(new Response("busy", { status: 503 })),
  ])("gives a retryable busy result once retries run out", async (attempt) => {
    const fetch = vi.fn(attempt);
    vi.stubGlobal("fetch", fetch);
    const failure = resolveTaskWorkspaces(hive, ["first"], quickRetry);
    await expect(failure).rejects.toBeInstanceOf(TaskWorkspaceBusyError);
    await expect(failure).rejects.not.toBeInstanceOf(AgentNonRetryableError);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("fails at once, without retrying, when the server refuses the identity", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "unsafe" }, { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    await expect(resolveTaskWorkspace(hive, "message", quickRetry)).rejects.toBeInstanceOf(
      AgentNonRetryableError,
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("names the server's reason instead of only the status code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "Task workspace /wt/a is now on feat/other", code: "WORKTREE_IDENTITY" },
          { status: 403 },
        ),
      ),
    );
    await expect(resolveTaskWorkspace(hive, "message", quickRetry)).rejects.toThrow(
      "Cannot verify managed task workspace (403): WORKTREE_IDENTITY: Task workspace /wt/a is now on feat/other",
    );
  });

  it("hands the server's notice to the sink when the last task workspace was not reused", async () => {
    const reason = "任务目录 /wt/a 登记的分支是 feat/a，现在却在 feat/b";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("?messageId=")
          ? Response.json({
              worktree: null,
              notice: { kind: "focus_dropped", path: "/wt/a", reason },
            })
          : Response.json({
              worktrees: { first: null, second: null },
              notices: { first: { kind: "focus_dropped", path: "/wt/a", reason }, second: "junk" },
            }),
      ),
    );
    const single = vi.fn();
    expect(await resolveTaskWorkspace(hive, "message", quickRetry, single)).toBeUndefined();
    expect(single).toHaveBeenCalledWith("message", {
      kind: "focus_dropped",
      path: "/wt/a",
      reason,
    });
    const many = vi.fn();
    const selected = await resolveTaskWorkspaces(hive, ["first", "second"], quickRetry, many);
    expect([...selected.values()]).toEqual([undefined, undefined]);
    expect(many).toHaveBeenCalledOnce();
    expect(many).toHaveBeenCalledWith("first", { kind: "focus_dropped", path: "/wt/a", reason });
  });

  it("strips credentials and control characters from server reasons and caps their length", () => {
    const reason = sanitizeServerReason(
      "bad\u0000 Bearer abc.def token=s3cr3t HIVE_TOKEN=xyz sk-abcdefghijklmnop " +
        "aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgc2VjcmV0IHN0cmluZw " +
        "at /Users/me/repo-wt/a on feat/x commit 0123456789abcdef0123456789abcdef01234567",
    );
    expect(reason).not.toMatch(/abc\.def|s3cr3t|xyz|sk-abc|aGVsbG8/);
    expect(reason).not.toContain("\u0000");
    expect(reason).toContain("Bearer [redacted]");
    expect(reason).toContain("HIVE_TOKEN=[redacted]");
    expect(reason).toContain("/Users/me/repo-wt/a on feat/x");
    expect(reason).toContain("0123456789abcdef0123456789abcdef01234567");
    expect(sanitizeServerReason("x".repeat(30) + " ".repeat(5) + "y ".repeat(400))).toHaveLength(
      400,
    );
  });

  it("fails at once when the returned checkout is foreign or has been replaced", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        worktree: {
          path: path.join(directory, "gone"),
          agentName: hive.username,
          roomId: hive.roomId,
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(resolveTaskWorkspace(hive, "message", quickRetry)).rejects.toBeInstanceOf(
      AgentNonRetryableError,
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("looks up a batch in one request and retains unbound entries", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        worktrees: {
          first: { path: directory, agentName: hive.username, roomId: hive.roomId },
          second: { path: directory, agentName: hive.username, roomId: hive.roomId },
          unbound: null,
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const selected = await resolveTaskWorkspaces(hive, ["first", "second", "unbound"]);
    expect([...selected]).toEqual([
      ["first", directory],
      ["second", directory],
      ["unbound", undefined],
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "http://hive/api/agent/worktree",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ messageIds: ["first", "second", "unbound"] }),
      }),
    );
  });

  it.each([
    { worktrees: { first: null } },
    {
      worktrees: {
        first: null,
        second: { path: "/missing", agentName: "other", roomId: "general" },
      },
    },
  ])("refuses incomplete or foreign batch identities", async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body)),
    );
    await expect(resolveTaskWorkspaces(hive, ["first", "second"])).rejects.toBeInstanceOf(
      AgentNonRetryableError,
    );
  });

  it("does not cache a selection across directory removal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          worktree: {
            path: directory,
            agentName: hive.username,
            roomId: hive.roomId,
          },
        }),
      ),
    );
    expect(await resolveTaskWorkspace(hive, "first")).toBe(directory);
    await rm(directory, { recursive: true });
    await expect(resolveTaskWorkspace(hive, "first")).rejects.toBeInstanceOf(
      AgentNonRetryableError,
    );
  });

  it("accepts only an authenticated removal receipt, including alongside live workspaces", async () => {
    const removed = {
      id: "00000000-0000-4000-8000-000000000000",
      path: "/missing",
      agentName: hive.username,
      roomId: hive.roomId,
      removed: true,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          worktree: removed,
          worktrees: {
            gone: removed,
            live: { path: directory, agentName: hive.username, roomId: hive.roomId },
          },
        }),
      ),
    );
    expect(await resolveTaskWorkspace(hive, "gone")).toBeInstanceOf(TaskWorkspaceRemovedError);
    const selected = await resolveTaskWorkspaces(hive, ["gone", "live"]);
    expect(selected.get("gone")).toBeInstanceOf(TaskWorkspaceRemovedError);
    expect(selected.get("live")).toBe(directory);
  });

  it.each([403, 404, 500])(
    "still refuses unverifiable HTTP %s without a cleanup receipt",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status })),
      );
      await expect(resolveTaskWorkspace(hive, "gone")).rejects.toBeInstanceOf(
        AgentNonRetryableError,
      );
      await expect(resolveTaskWorkspaces(hive, ["gone"])).rejects.toBeInstanceOf(
        AgentNonRetryableError,
      );
    },
  );

  it("rejects a foreign or malformed removal receipt", async () => {
    for (const record of [
      {
        id: "invalid",
        path: "/missing",
        agentName: hive.username,
        roomId: hive.roomId,
        removed: true,
      },
      {
        id: "00000000-0000-4000-8000-000000000000",
        path: "/missing",
        agentName: "other",
        roomId: hive.roomId,
        removed: true,
      },
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ worktree: record })),
      );
      await expect(resolveTaskWorkspace(hive, "gone")).rejects.toBeInstanceOf(
        AgentNonRetryableError,
      );
    }
  });
});
