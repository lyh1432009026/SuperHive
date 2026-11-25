import { describe, expect, it } from "vitest";
import type { Participant } from "@superhive/protocol";
import { customPersona, memberModel } from "./side-panel";

const agent = {
  id: "00000000-0000-4000-8000-000000000001",
  roomId: "build",
  username: "Helper",
  type: "agent",
  status: "online",
  joinedAt: "2026-11-26T00:00:00.000Z",
  lastSeenAt: "2026-11-26T00:00:00.000Z",
} as Participant;

describe("member list subtitle", () => {
  it("shows the model the last turn actually used, then the configured one", () => {
    const context = { contextTokens: 1, at: "2026-11-26T00:00:00.000Z" };
    expect(
      memberModel({ ...agent, context: { ...context, model: "claude-opus-5-5" } }, [
        { name: "helper", model: "claude-sonnet-5-5" },
      ]),
    ).toBe("claude-opus-5-5");
    expect(memberModel({ ...agent, context }, [{ name: "helper", model: "gpt-5" }])).toBe("gpt-5");
    expect(memberModel(agent, [{ name: "helper" }])).toBeUndefined();
    expect(memberModel(agent, [])).toBeUndefined();
  });

  it("hides the default persona that every agent shares", () => {
    expect(customPersona("通用协作 Agent")).toBeUndefined();
    expect(customPersona(undefined)).toBeUndefined();
    expect(customPersona(" 负责前端 ")).toBe("负责前端");
  });
});
