import { describe, expect, it } from "vitest";
import { loginShellPath, mergePath } from "./shell-env.js";

describe("mergePath", () => {
  it("puts the shell PATH first and de-duplicates", () => {
    expect(mergePath("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin", ":")).toBe(
      "/opt/homebrew/bin:/usr/bin:/bin",
    );
    expect(mergePath(undefined, "/usr/bin", ":")).toBe("/usr/bin");
  });
});

describe("loginShellPath", () => {
  it("is skipped on Windows", async () => {
    expect(await loginShellPath({}, "win32")).toBeUndefined();
  });

  it("reads PATH from the login shell even when it prints noise", async () => {
    if (process.platform === "win32") return;
    const value = await loginShellPath(
      { ...process.env, SHELL: "/bin/sh", PATH: "/usr/bin:/bin" },
      process.platform,
    );
    expect(value).toContain("/usr/bin");
  });
});
