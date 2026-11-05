import { describe, expect, it } from "vitest";
import { resumeCommand } from "./agent-session.js";

describe("resumeCommand", () => {
  it("builds a per-provider resume command run in the agent's working directory", () => {
    expect(resumeCommand({ provider: "claude", sessionId: "abc-1", cwd: "/repo/web" })).toBe(
      "cd /repo/web && claude --resume abc-1",
    );
    expect(resumeCommand({ provider: "codex", sessionId: "t1", cwd: "/a b" })).toBe(
      "cd '/a b' && codex resume t1",
    );
    expect(
      resumeCommand({
        provider: "opencode",
        sessionId: "s",
        cwd: "C:\\Work\\x",
        platform: "win32",
      }),
    ).toBe("cd /d C:\\Work\\x && opencode --session s");
    // 会话 ID 只收常见字符：shell 元字符、以 - 开头（会被当成别的选项）都不接
    expect(
      resumeCommand({ provider: "claude", sessionId: "x';rm -rf ~'", cwd: "/r" }),
    ).toBeUndefined();
    expect(
      resumeCommand({ provider: "claude", sessionId: "--dangerously-skip-permissions", cwd: "/r" }),
    ).toBeUndefined();
    // cmd 在引号里也会展开 % 和 !：带这些的目录不接
    expect(
      resumeCommand({ provider: "codex", sessionId: "t", cwd: "C:\\%TEMP%", platform: "win32" }),
    ).toBeUndefined();
    expect(resumeCommand({ provider: "openclaw", sessionId: "s", cwd: "/r" })).toBeUndefined();
  });
});
