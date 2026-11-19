import { describe, expect, it } from "vitest";
import {
  compareVersions,
  formatAgentVersion,
  isAgentOutdated,
  participantJoinEventSchema,
} from "./index.js";

describe("compareVersions", () => {
  it("compares numerically, and a prerelease is older than its release", () => {
    expect(compareVersions("0.3.1", "0.3.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.2.0", "1.2")).toBe(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.1")).toBeGreaterThan(0);
  });
});

describe("isAgentOutdated", () => {
  const current = { package: "0.3.1", commit: "b".repeat(40), fingerprint: "new.tree" };

  it("uses the code fingerprint for an agent running from the same checkout", () => {
    expect(isAgentOutdated({ ...current, fingerprint: "old.tree" }, current, true)).toBe(true);
    // 只改了网页的提交：HEAD 不同，但 Agent 代码的指纹一样，不算旧
    expect(isAgentOutdated({ ...current, commit: "c".repeat(40) }, current, true)).toBe(false);
    // 对方没能算出指纹：按旧处理（重启一次就会带上）
    expect(isAgentOutdated({ package: "0.3.1" }, current, true)).toBe(true);
  });

  it("only compares package versions for agents elsewhere, so a newer one is never flagged", () => {
    expect(isAgentOutdated({ ...current, fingerprint: "other.tree" }, current, false)).toBe(false);
    expect(isAgentOutdated({ package: "0.3.0" }, current, false)).toBe(true);
    expect(isAgentOutdated({ package: "0.4.0" }, current, false)).toBe(false);
  });

  it("does not flag anything when either version is unknown", () => {
    expect(isAgentOutdated(undefined, current, true)).toBe(false);
    expect(isAgentOutdated({ package: "0.1.0" }, undefined, true)).toBe(false);
  });

  it("npm installs compare by package version", () => {
    expect(isAgentOutdated({ package: "0.3.0" }, { package: "0.3.1" }, true)).toBe(true);
    expect(isAgentOutdated({ package: "0.3.1" }, { package: "0.3.1" }, true)).toBe(false);
  });
});

describe("participant.join version", () => {
  const join = {
    type: "participant.join",
    username: "rd-claude",
    participantType: "agent",
    roomId: "general",
    token: "t",
  };

  it("keeps a valid version and ignores a malformed one instead of rejecting the join", () => {
    expect(
      participantJoinEventSchema.parse({ ...join, version: { package: "0.3.1" } }).version,
    ).toEqual({ package: "0.3.1" });
    const parsed = participantJoinEventSchema.safeParse({
      ...join,
      version: { package: "", commit: "not-a-commit" },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.version).toBeUndefined();
  });
});

describe("formatAgentVersion", () => {
  it("shows the short commit when running from source", () => {
    expect(formatAgentVersion({ package: "0.3.1", commit: "277e2c5abcdef" })).toBe(
      "0.3.1 · 277e2c5",
    );
    expect(formatAgentVersion({ package: "0.3.1" })).toBe("0.3.1");
  });
});
