import { describe, expect, it } from "vitest";
import { isTaskDirectoryEntry, whiteboardEntrySchema } from "./index.js";

describe("task directory whiteboard entries", () => {
  it.each([
    [{ key: "worktree:legacy" }, true],
    [{ key: "worktree:cleaned" }, true],
    [{ key: "directory", kind: "task_directory" as const }, true],
    [{ key: "worktree-deps" }, false],
    [{ key: "task", summary: "worktree:mentioned in a task" }, false],
  ])("classifies %j without inspecting its summary", (entry, expected) => {
    expect(isTaskDirectoryEntry(entry)).toBe(expected);
  });

  it("preserves directory metadata on the wire and accepts untagged legacy entries", () => {
    const legacy = {
      id: "00000000-0000-4000-8000-000000000001",
      roomId: "build",
      key: "worktree:legacy",
      slot: "milestone",
      summary: "Directory has been cleaned",
      branch: "feat/legacy",
      claim: { repo: "/repo", branch: "feat/legacy" },
      authorId: "00000000-0000-4000-8000-000000000002",
      authorName: "agent",
      unblocks: [],
      createdAt: "2026-11-19T00:00:00.000Z",
      updatedAt: "2026-11-19T01:00:00.000Z",
    };
    expect(whiteboardEntrySchema.parse(legacy)).toEqual(legacy);
    expect(whiteboardEntrySchema.parse({ ...legacy, kind: "task_directory" })).toEqual({
      ...legacy,
      kind: "task_directory",
    });
  });
});
