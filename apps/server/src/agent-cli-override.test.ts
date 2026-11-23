import { describe, expect, it } from "vitest";
import { agentCliOverride } from "./agent-cli-override.js";

describe("agentCliOverride", () => {
  it("is unset when the variable is missing or blank", () => {
    expect(agentCliOverride(undefined)).toBeUndefined();
    expect(agentCliOverride("  ")).toBeUndefined();
  });

  it("splits the JSON array into command and fixed args", () => {
    expect(
      agentCliOverride(
        '["/Applications/SuperHive.app/Contents/MacOS/SuperHive","--superhive-cli"]',
      ),
    ).toEqual({
      command: "/Applications/SuperHive.app/Contents/MacOS/SuperHive",
      args: ["--superhive-cli"],
    });
    expect(agentCliOverride('["node"]')).toEqual({ command: "node", args: [] });
  });

  it("rejects malformed values instead of silently falling back", () => {
    expect(() => agentCliOverride("node cli.js")).toThrow(/JSON array/);
    expect(() => agentCliOverride("[]")).toThrow(/non-empty/);
    expect(() => agentCliOverride('["node", 1]')).toThrow(/non-empty/);
    expect(() => agentCliOverride('{"command":"node"}')).toThrow(/non-empty/);
  });
});
