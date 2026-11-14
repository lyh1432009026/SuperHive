import { describe, expect, it } from "vitest";
import {
  createWorktreeRequestSchema,
  removeWorktreeRequestSchema,
  worktreeClaimSchema,
} from "./worktree.js";

describe("worktree requests", () => {
  it("accepts stable task-line slugs and optional base/branch", () => {
    expect(
      createWorktreeRequestSchema.parse({
        slug: "api-login",
        base: "main",
        branch: "feat/helper-api",
      }),
    ).toEqual({ slug: "api-login", base: "main", branch: "feat/helper-api" });
    for (const slug of ["../escape", "a/b", "a b", "-flag", "", "a\n", "a--b"])
      expect(createWorktreeRequestSchema.safeParse({ slug }).success).toBe(false);
  });
  it("deletes branches by default but has no force option", () => {
    expect(removeWorktreeRequestSchema.parse({ path: "/repo-wt/feature" })).toEqual({
      path: "/repo-wt/feature",
      deleteBranch: true,
    });
    expect(
      removeWorktreeRequestSchema.parse({ path: "/repo-wt/feature", force: true }),
    ).not.toHaveProperty("force");
    expect(
      removeWorktreeRequestSchema.parse({ path: "/repo-wt/feature", deleteBranch: false })
        .deleteBranch,
    ).toBe(false);
  });
  it("requires both repository identity and branch for a claim", () => {
    expect(worktreeClaimSchema.parse({ repo: "/repo", branch: "feat/helper" })).toEqual({
      repo: "/repo",
      branch: "feat/helper",
    });
    expect(worktreeClaimSchema.safeParse({ repo: "/repo" }).success).toBe(false);
  });
});
