import { describe, expect, it } from "vitest";
import { customPersona } from "./side-panel";

describe("member list subtitle", () => {
  it("hides the default persona that every agent shares", () => {
    expect(customPersona("通用协作 Agent")).toBeUndefined();
    expect(customPersona(undefined)).toBeUndefined();
    expect(customPersona(" 负责前端 ")).toBe("负责前端");
  });
});
