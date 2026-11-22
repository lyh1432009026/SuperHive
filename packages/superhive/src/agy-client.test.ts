import { describe, expect, it, vi } from "vitest";
import { agyAccessArgs, createAgyResponder, isAgyHiveTool } from "./agy-client.js";
import type { StdioTransport } from "./stdio-transport.js";

const hive = {
  serverUrl: "http://localhost:8787",
  roomId: "general",
  username: "agy-agent",
  token: "test-token",
};

describe("agy ACP profile", () => {
  it("only skips permission prompts in full access", () => {
    expect(agyAccessArgs("read-only")).toEqual([]);
    expect(agyAccessArgs("workspace")).toEqual([]);
    expect(agyAccessArgs("full")).toEqual(["--dangerously-skip-permissions"]);
  });

  it("recognises Hive MCP tools by agy's mcp_<server>_<tool> name", () => {
    expect(isAgyHiveTool({ kind: "other", name: "mcp_hive_hive_board_update" })).toBe(true);
    expect(isAgyHiveTool({ kind: "other", name: "mcp_hivex_tool" })).toBe(false);
    expect(isAgyHiveTool({ kind: "other", title: "Run mcp_hive_hive_board_update" })).toBe(false);
  });

  it("starts `agy acp` and picks the configured model per session", async () => {
    const createTransport = vi.fn((): StdioTransport => ({
      write: () => undefined,
      onLine: () => undefined,
      onExit: () => undefined,
      kill: () => undefined,
    }));
    const responder = createAgyResponder(
      { command: "agy", cwd: "/workspace", hive, access: "full", model: "gemini-3.1-pro" },
      { createTransport, requestTimeoutMs: 1 },
    );
    await expect(responder.reply({ instructions: "rules", prompt: "hi" })).rejects.toThrow();
    const [command, args, options] = createTransport.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string },
    ];
    expect(command).toBe("agy");
    expect(args).toEqual(["acp", "--dangerously-skip-permissions"]);
    expect(options.cwd).toBe("/workspace");
  });
});
