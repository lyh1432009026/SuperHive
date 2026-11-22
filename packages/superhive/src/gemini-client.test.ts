import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createGeminiResponder,
  geminiApprovalMode,
  geminiHomeEnv,
  isGeminiHiveTool,
  parseDotEnv,
} from "./gemini-client.js";
import type { StdioTransport } from "./stdio-transport.js";

const hive = {
  serverUrl: "http://localhost:8787",
  roomId: "general",
  username: "gemini-agent",
  token: "test-token",
};

const idleTransport = () =>
  vi.fn((): StdioTransport => ({
    write: () => undefined,
    onLine: () => undefined,
    onExit: () => undefined,
    kill: () => undefined,
  }));

describe("Gemini CLI ACP profile", () => {
  it("keeps approvals with Hive unless access is full", () => {
    expect(geminiApprovalMode("read-only")).toBe("default");
    expect(geminiApprovalMode("workspace")).toBe("default");
    expect(geminiApprovalMode("full")).toBe("yolo");
  });

  it("recognises Hive MCP tools by the server name Gemini CLI reports", () => {
    const mcp = (server: string) => ({
      kind: "other",
      _meta: { "gemini-cli": { mcp: { server_name: server, tool_name: "hive_board_update" } } },
    });
    expect(isGeminiHiveTool(mcp("hive"))).toBe(true);
    expect(isGeminiHiveTool(mcp("hive_extra"))).toBe(false);
    expect(isGeminiHiveTool({ kind: "execute", title: "hive_board_update" })).toBe(false);
    expect(
      isGeminiHiveTool({
        kind: "other",
        toolCallId: "mcp_hive_hive_wait__mcp_hive_hive_wait_1_0",
      } as never),
    ).toBe(true);
  });

  it("parses the .env syntax Gemini CLI accepts", () => {
    expect(
      parseDotEnv(
        [
          "# comment",
          "GEMINI_API_KEY=abc",
          "export GOOGLE_GEMINI_BASE_URL='http://127.0.0.1:4000'",
          'QUOTED="a b"',
          "TRAILING=value # note",
          "not a pair",
          "",
        ].join("\n"),
      ),
    ).toEqual({
      GEMINI_API_KEY: "abc",
      GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:4000",
      QUOTED: "a b",
      TRAILING: "value",
    });
  });

  it("reads ~/.gemini/.env without overriding variables already set", () => {
    const home = mkdtempSync(path.join(tmpdir(), "gemini-home-"));
    try {
      mkdirSync(path.join(home, ".gemini"));
      writeFileSync(
        path.join(home, ".gemini", ".env"),
        "GEMINI_API_KEY=from-file\nGOOGLE_GEMINI_BASE_URL=http://proxy\n",
      );
      expect(geminiHomeEnv({ GEMINI_CLI_HOME: home })).toEqual({
        GEMINI_API_KEY: "from-file",
        GOOGLE_GEMINI_BASE_URL: "http://proxy",
      });
      expect(geminiHomeEnv({ GEMINI_CLI_HOME: home, GEMINI_API_KEY: "shell" })).toEqual({
        GOOGLE_GEMINI_BASE_URL: "http://proxy",
      });
      expect(geminiHomeEnv({ GEMINI_CLI_HOME: path.join(home, "missing") })).toEqual({});
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("starts `gemini --acp` trusting only this session's folder", async () => {
    const createTransport = idleTransport();
    const responder = createGeminiResponder(
      { command: "gemini", cwd: "/workspace", hive, access: "workspace", model: "gemini-2.5-pro" },
      { createTransport, requestTimeoutMs: 1 },
    );
    await expect(responder.reply({ instructions: "rules", prompt: "hi" })).rejects.toThrow();
    const [command, args, options] = createTransport.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string },
    ];
    expect(command).toBe("gemini");
    expect(args).toEqual([
      "--acp",
      "--skip-trust",
      "--approval-mode",
      "default",
      "--model",
      "gemini-2.5-pro",
    ]);
    expect(options.cwd).toBe("/workspace");

    const full = idleTransport();
    await expect(
      createGeminiResponder(
        { command: "gemini", cwd: "/workspace", hive, access: "full" },
        { createTransport: full, requestTimeoutMs: 1 },
      ).reply({ instructions: "rules", prompt: "hi" }),
    ).rejects.toThrow();
    expect((full.mock.calls[0] as unknown as [string, string[]])[1]).toEqual([
      "--acp",
      "--skip-trust",
      "--approval-mode",
      "yolo",
    ]);
  });
});
