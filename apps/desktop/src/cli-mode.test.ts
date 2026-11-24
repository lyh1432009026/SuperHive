import { describe, expect, it } from "vitest";
import { cliUserDataName } from "./cli-mode.js";

describe("cliUserDataName", () => {
  it("gives each joined agent its own directory and shares one for one-shot commands", () => {
    expect(cliUserDataName(["join", "--server=http://x", "--name=ddd-claude"])).toBe(
      "agent-ddd-claude",
    );
    expect(cliUserDataName(["join", "--name", "rd codex/2"])).toBe("agent-rd_codex_2");
    expect(cliUserDataName(["join"])).toBe("oneshot");
    expect(cliUserDataName(["mcp", "list", "--name=x"])).toBe("oneshot");
    expect(cliUserDataName(["--version"])).toBe("oneshot");
  });
});
