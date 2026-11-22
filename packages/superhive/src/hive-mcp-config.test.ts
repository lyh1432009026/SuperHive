import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeHiveMcpConfig,
  codexHiveMcpEnv,
  codexHiveMcpOverrides,
  copilotHiveMcpConfig,
  hiveMcpHeaders,
  hiveMcpUrl,
  openClawHiveMcpBatch,
  openClawHiveMcpName,
  sweepStaleHiveMcpConfigs,
} from "./hive-mcp-config.js";

const connection = {
  serverUrl: "https://hive.example.com/",
  roomId: "general",
  username: "小明-codex",
  token: "secret-token",
};

describe("Hive MCP provider configuration", () => {
  it("builds the MCP URL and scoped identity headers", () => {
    expect(hiveMcpUrl(connection)).toBe("https://hive.example.com/mcp");
    expect(hiveMcpHeaders(connection)).toEqual({
      Authorization: "Bearer secret-token",
      "X-Hive-Room": "general",
      "X-Hive-Agent-Name": "小明-codex",
    });
  });

  it("generates provider-native remote MCP configuration", () => {
    expect(JSON.parse(claudeHiveMcpConfig(connection))).toMatchObject({
      mcpServers: { hive: { type: "http", url: "https://hive.example.com/mcp" } },
    });
    expect(JSON.parse(copilotHiveMcpConfig(connection))).toMatchObject({
      mcpServers: { hive: { tools: ["*"] } },
    });
    expect(JSON.parse(openClawHiveMcpBatch(connection))).toEqual([
      {
        path: `mcp.servers.${openClawHiveMcpName(connection)}`,
        value: {
          url: "https://hive.example.com/mcp",
          transport: "streamable-http",
          headers: hiveMcpHeaders(connection),
        },
      },
    ]);
    expect(openClawHiveMcpName(connection)).toMatch(/^superhive-[a-f0-9]{12}$/);
  });

  it("keeps the codex token out of -c overrides and hands it over by environment", () => {
    const overrides = codexHiveMcpOverrides(connection);
    expect(overrides.join(" ")).not.toContain("secret-token");
    expect(overrides).toEqual([
      'mcp_servers.hive.url="https://hive.example.com/mcp"',
      'mcp_servers.hive.bearer_token_env_var="HIVE_MCP_TOKEN"',
      'mcp_servers.hive.http_headers={"X-Hive-Room"="general","X-Hive-Agent-Name"="小明-codex"}',
      // 模型执行的命令里读不到这个变量
      'shell_environment_policy.set.HIVE_MCP_TOKEN=""',
    ]);
    expect(codexHiveMcpEnv(connection)).toEqual({ HIVE_MCP_TOKEN: "secret-token" });
  });

  it("sweeps only stale temporary MCP configs left behind by killed turns", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hive-sweep-test-"));
    const now = Date.now();
    const make = (name: string, ageMs: number) => {
      mkdirSync(path.join(dir, name));
      writeFileSync(path.join(dir, name, "mcp.json"), "{}");
      const at = (now - ageMs) / 1000;
      utimesSync(path.join(dir, name), at, at);
    };
    const day = 24 * 60 * 60 * 1000;
    make("hive-claude-mcp-old", 2 * day);
    make("hive-copilot-mcp-old", 2 * day);
    make("hive-openclaw-mcp-old", 2 * day);
    make("hive-claude-mcp-running", 60_000);
    make("other-old", 2 * day);
    sweepStaleHiveMcpConfigs(dir, now);
    expect(existsSync(path.join(dir, "hive-claude-mcp-old"))).toBe(false);
    expect(existsSync(path.join(dir, "hive-copilot-mcp-old"))).toBe(false);
    expect(existsSync(path.join(dir, "hive-openclaw-mcp-old"))).toBe(false);
    expect(existsSync(path.join(dir, "hive-claude-mcp-running"))).toBe(true);
    expect(existsSync(path.join(dir, "other-old"))).toBe(true);
  });
});
