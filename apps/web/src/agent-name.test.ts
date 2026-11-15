import { describe, expect, it } from "vitest";
import { agentNameFor } from "./agent-name";

const taken = (...names: string[]) => new Set(names.map((name) => name.toLocaleLowerCase()));

describe("agentNameFor", () => {
  it("房主名加提供方后缀，无占用时原样返回", () => {
    expect(agentNameFor("rd", "claude")).toBe("rd-claude");
    expect(agentNameFor("rd", "codex")).toBe("rd-codex");
  });

  it("房间已有同名成员时自增，与 rd 手工命名风格一致", () => {
    expect(agentNameFor("rd", "claude", taken("rd-claude"))).toBe("rd-claude2");
    expect(agentNameFor("rd", "claude", taken("rd-claude", "rd-claude2"))).toBe("rd-claude3");
    expect(agentNameFor("rd", "claude", taken("rd-claude", "rd-claude2", "rd-claude3"))).toBe(
      "rd-claude4",
    );
  });

  it("占用比较大小写不敏感，跳过被占用序号", () => {
    expect(agentNameFor("rd", "claude", taken("RD-CLAUDE"))).toBe("rd-claude2");
    expect(agentNameFor("rd", "claude", taken("rd-claude", "rd-claude3"))).toBe("rd-claude2");
  });

  it("只避开同名，其他成员不影响默认名", () => {
    expect(agentNameFor("rd", "claude", taken("rd", "glm2", "rd-codex"))).toBe("rd-claude");
  });

  it("自增后总长不超过 32", () => {
    const longOwner = "a".repeat(40);
    expect(agentNameFor(longOwner, "claude").length).toBe(32);
    const incremented = agentNameFor(longOwner, "claude", taken(agentNameFor(longOwner, "claude")));
    expect(incremented.length).toBeLessThanOrEqual(32);
    expect(incremented.endsWith("2")).toBe(true);
  });
});
