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
    expect(resumeCommand({ provider: "claude", sessionId: "x';rm -rf ~'", cwd: "/r" })).toBe(
      "cd /r && claude --resume 'x'\\'';rm -rf ~'\\'''",
    );
    expect(resumeCommand({ provider: "openclaw", sessionId: "s", cwd: "/r" })).toBeUndefined();
  });
});
