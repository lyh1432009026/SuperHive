import { describe, expect, it, vi } from "vitest";
import { CodexAppServerUnsupportedError } from "./codex-app-server-client.js";
import {
  CODEX_MIN_VERSION,
  CODEX_TESTED_VERSION,
  CodexResponder,
  parseCodexVersion,
} from "./codex-responder.js";
import { AgentNonRetryableError, type AgentResponder } from "./responder.js";

const hive = { serverUrl: "http://hive", roomId: "general", username: "agent", token: "t" };
const options = { command: "codex", cwd: "/w", hive, log: () => {} };

describe("CodexResponder", () => {
  it("passes app-server errors through unchanged on a verified version", async () => {
    const error = new CodexAppServerUnsupportedError("initialize unsupported");
    const appServer: AgentResponder = {
      reply: vi.fn(async () => {
        throw error;
      }),
    };
    const responder = new CodexResponder(options, {
      appServer,
      version: async () => CODEX_TESTED_VERSION,
    });
    for (let i = 0; i < 2; i++)
      await expect(responder.reply({ instructions: "i", prompt: "p" })).rejects.toBe(error);
    expect(error.message).toBe("initialize unsupported");
  });

  it("refuses a CLI older than the minimum before starting app-server, and re-checks next turn", async () => {
    const appServer: AgentResponder = { reply: vi.fn(async () => ({ text: "ok" })) };
    const version = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce("0.98.0")
      .mockResolvedValueOnce(CODEX_MIN_VERSION);
    const responder = new CodexResponder(options, { appServer, version });

    const error = await responder.reply({ instructions: "i", prompt: "p" }).catch((e) => e);
    expect(error).toBeInstanceOf(AgentNonRetryableError);
    expect(error.message).toContain("0.98.0");
    expect(error.message).toContain(CODEX_MIN_VERSION);
    expect(error.message).toContain("codex update");
    expect(appServer.reply).not.toHaveBeenCalled();

    // 用户升级之后下一轮就能用，不用重启 Agent
    await expect(responder.reply({ instructions: "i", prompt: "p" })).resolves.toEqual({
      text: "ok",
    });
    expect(version).toHaveBeenCalledTimes(2);
  });

  it("warns once about an unverified newer CLI and adds the hint to protocol failures only", async () => {
    const log = vi.fn();
    const startup = new AgentNonRetryableError("Codex app-server initialize：协议请求失败");
    const quota = new AgentNonRetryableError("额度已用完");
    const appServer: AgentResponder = {
      reply: vi.fn().mockRejectedValueOnce(startup).mockRejectedValueOnce(quota),
    };
    const version = vi.fn(async () => "9.0.0");
    const responder = new CodexResponder({ ...options, log }, { appServer, version });

    await expect(responder.reply({ instructions: "i", prompt: "p" })).rejects.toBe(startup);
    expect(startup.message).toContain("hive update");
    expect(startup.message).toContain(CODEX_TESTED_VERSION);
    await expect(responder.reply({ instructions: "i", prompt: "p" })).rejects.toBe(quota);
    expect(quota.message).toBe("额度已用完");
    expect(log).toHaveBeenCalledTimes(1);
    expect(version).toHaveBeenCalledTimes(1);
  });

  it("still starts when the version cannot be read", async () => {
    const appServer: AgentResponder = { reply: vi.fn(async () => ({ text: "ok" })) };
    const responder = new CodexResponder(options, { appServer, version: async () => undefined });
    await expect(responder.reply({ instructions: "i", prompt: "p" })).resolves.toEqual({
      text: "ok",
    });
  });

  it("parses codex --version output", () => {
    expect(parseCodexVersion("codex-cli 0.162.1\n")).toBe("0.162.1");
    expect(parseCodexVersion("codex-cli 0.172.0-alpha.3")).toBe("0.172.0-alpha.3");
    expect(parseCodexVersion("command not found")).toBeUndefined();
  });
});
