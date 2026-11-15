import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveTaskWorkspace,
  resolveTaskWorkspaces,
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

describe("task workspace resolution", () => {
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
