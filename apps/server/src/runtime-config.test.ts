import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import type { SpawnAgent } from "./local-agents.js";
import { contentHash, RuntimeConfigStore } from "./runtime-config.js";
import { RuntimeCredentialStore } from "./runtime-credentials.js";

const SECRET = "sk-mcp-secret-0123456789";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function setup(env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "hive-config-"));
  dirs.push(home);
  const claudeDir = path.join(home, ".claude");
  const codexHome = path.join(home, ".codex");
  mkdirSync(claudeDir);
  mkdirSync(codexHome);
  const credentials = new RuntimeCredentialStore({
    home,
    env,
    claudeDir,
    codexHome,
    claudeManagedSettings: path.join(home, "managed.json"),
  });
  return { home, claudeDir, codexHome, credentials, store: new RuntimeConfigStore(credentials) };
}

const read = (file: string) => readFileSync(file, "utf8");

describe("RuntimeConfigStore fields", () => {
  it("edits Codex model settings in config.toml, keeping comments, and removes a value on null", () => {
    const { codexHome, store } = setup();
    const file = path.join(codexHome, "config.toml");
    const content = `# 我的配置\nmodel = "gpt-5" # 主模型\nmodel_provider = "gw"\napproval_policy = "on-request"\n\n[model_providers.gw]\nbase_url = "https://gw.example.com"\nwire_api = "responses"\n`;
    writeFileSync(file, content);
    const config = store.get("codex");
    expect(config.fields.map((field) => field.id)).toEqual([
      "model",
      "model_provider",
      "wire_api",
      "model_reasoning_effort",
      "approval_policy",
      "sandbox_mode",
    ]);
    expect(config.fields.find((field) => field.id === "approval_policy")?.note).toContain("终端");

    store.updateFields("codex", {
      model: "gpt-5.5",
      model_reasoning_effort: "high",
      wire_api: "chat",
      approval_policy: null,
    });
    expect(read(file)).toBe(
      `# 我的配置\nmodel = "gpt-5.5" # 主模型\nmodel_provider = "gw"\nmodel_reasoning_effort = "high"\n\n[model_providers.gw]\nbase_url = "https://gw.example.com"\nwire_api = "chat"\n`,
    );
  });

  it("rejects values outside the allowed options without writing", () => {
    const { codexHome, store } = setup();
    const file = path.join(codexHome, "config.toml");
    writeFileSync(file, `model = "gpt-5"\n`);
    for (const values of [
      { sandbox_mode: "everything" },
      { approval_policy: "untrusted" },
      { model: "two\nlines" },
      { unknown: "x" },
    ]) {
      expect(() => store.updateFields("codex", values)).toThrow(
        expect.objectContaining({ code: "RUNTIME_CONFIG_INVALID" }),
      );
    }
    expect(read(file)).toBe(`model = "gpt-5"\n`);
  });

  it("edits Claude Code env models and permission mode, and keeps omp's config.yml read-only", () => {
    const { home, claudeDir, store } = setup();
    const settings = path.join(claudeDir, "settings.json");
    writeFileSync(
      settings,
      `{\n  "env": {\n    "ANTHROPIC_MODEL": "opus"\n  },\n  "hooks": {}\n}\n`,
    );
    store.updateFields("claude", { haikuModel: "glm-4.5-air", permissionMode: "acceptEdits" });
    expect(JSON.parse(read(settings))).toEqual({
      env: { ANTHROPIC_MODEL: "opus", ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.5-air" },
      hooks: {},
      permissions: { defaultMode: "acceptEdits" },
    });

    mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
    writeFileSync(path.join(home, ".omp", "agent", "config.yml"), "modelRoles:\n  default: a/b\n");
    const omp = store.get("omp").fields[0]!;
    expect(omp).toMatchObject({ value: "a/b", editable: false });
    expect(() => store.updateFields("omp", { model: "c/d" })).toThrow(
      expect.objectContaining({ code: "RUNTIME_CREDENTIALS_NOT_EDITABLE" }),
    );
  });

  it("requires opencode models to be provider/model", () => {
    const { home, store } = setup();
    const dir = path.join(home, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "opencode.jsonc"), `{\n  // 注释\n  "model": "a/b"\n}\n`);
    expect(() => store.updateFields("opencode", { model: "glm" })).toThrow(
      expect.objectContaining({ code: "RUNTIME_CONFIG_INVALID" }),
    );
    store.updateFields("opencode", { small_model: "a/small" });
    expect(read(path.join(dir, "opencode.jsonc"))).toBe(
      `{\n  // 注释\n  "model": "a/b",\n  "small_model": "a/small"\n}\n`,
    );
  });
});

describe("RuntimeConfigStore MCP", () => {
  it("adds, edits, disables and deletes Codex MCP tables without touching other tables", () => {
    const { codexHome, store } = setup();
    const file = path.join(codexHome, "config.toml");
    const head = `model = "gpt-5"\n\n[mcp_servers.keep]\ncommand = "keep"\n`;
    writeFileSync(
      file,
      `${head}\n[mcp_servers.docs]\ncommand = "npx"\nargs = ["docs"]\n\n[mcp_servers.docs.env]\nTOKEN = "${SECRET}"\n`,
    );
    const servers = store.get("codex").mcp.servers;
    expect(servers.find((server) => server.name === "docs")).toEqual({
      name: "docs",
      transport: "stdio",
      command: "npx",
      args: ["docs"],
      envKeys: ["TOKEN"],
      enabled: true,
    });
    expect(JSON.stringify(store.get("codex"))).not.toContain(SECRET);

    // 改命令，env 只给变量名（null）：沿用原值
    store.putMcp("codex", "docs", {
      transport: "stdio",
      command: "bunx",
      args: ["docs", "--fast"],
      env: { TOKEN: null },
    });
    expect(read(file)).toContain(head);
    expect(read(file)).toContain(`command = "bunx"`);
    expect(read(file)).toContain(`TOKEN = "${SECRET}"`);

    store.toggleMcp("codex", "docs", false);
    expect(store.get("codex").mcp.servers.find((server) => server.name === "docs")?.enabled).toBe(
      false,
    );
    store.toggleMcp("codex", "docs", true);
    expect(read(file)).not.toContain("enabled");

    // 换成远程：去掉 command/args/env 之外 stdio 专属的 cwd
    store.putMcp("codex", "remote", { transport: "http", url: "https://mcp.example.com" });
    expect(store.get("codex").mcp.servers.map((server) => server.name)).toEqual([
      "keep",
      "docs",
      "remote",
    ]);
    store.deleteMcp("codex", "docs");
    expect(read(file)).not.toContain("docs");
    expect(read(file)).not.toContain(SECRET);
    expect(read(file).startsWith(head)).toBe(true);
  });

  it("writes Claude MCP into ~/.claude.json mcpServers and cannot disable a single server", () => {
    const { home, store } = setup();
    const file = path.join(home, ".claude.json");
    writeFileSync(file, JSON.stringify({ numStartups: 3, mcpServers: {} }, null, 2));
    store.putMcp("claude", "chrome", { transport: "stdio", command: "npx", args: ["chrome"] });
    expect(JSON.parse(read(file))).toEqual({
      numStartups: 3,
      mcpServers: { chrome: { command: "npx", args: ["chrome"] } },
    });
    expect(store.get("claude").mcp.canToggle).toBe(false);
    expect(() => store.toggleMcp("claude", "chrome", false)).toThrow(
      expect.objectContaining({ code: "RUNTIME_CREDENTIALS_NOT_EDITABLE" }),
    );
    // 改名
    store.putMcp(
      "claude",
      "browser",
      { transport: "stdio", command: "npx", args: ["chrome"] },
      "chrome",
    );
    expect(Object.keys(JSON.parse(read(file)).mcpServers)).toEqual(["browser"]);
  });

  it("uses opencode's local/remote shape and enabled flag", () => {
    const { home, store } = setup();
    const dir = path.join(home, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "opencode.json");
    writeFileSync(file, "{}\n");
    store.putMcp("opencode", "fs", { transport: "stdio", command: "npx", args: ["fs"] });
    store.toggleMcp("opencode", "fs", false);
    expect(JSON.parse(read(file))).toEqual({
      mcp: { fs: { type: "local", command: ["npx", "fs"], enabled: false } },
    });
  });

  it("disables Copilot MCP through settings.json disabledMcpServers and omp through enabled:false", () => {
    const { home, store } = setup();
    const copilot = path.join(home, ".copilot");
    mkdirSync(copilot);
    writeFileSync(path.join(copilot, "settings.json"), `{ "effortLevel": "high" }`);
    store.putMcp("copilot", "fs", { transport: "stdio", command: "npx", args: ["fs"] });
    expect(JSON.parse(read(path.join(copilot, "mcp-config.json")))).toEqual({
      mcpServers: { fs: { tools: ["*"], command: "npx", args: ["fs"], type: "local" } },
    });
    store.toggleMcp("copilot", "fs", false);
    expect(JSON.parse(read(path.join(copilot, "settings.json")))).toEqual({
      effortLevel: "high",
      disabledMcpServers: ["fs"],
    });
    expect(store.get("copilot").mcp.servers[0]?.enabled).toBe(false);

    const omp = path.join(home, ".omp", "agent");
    mkdirSync(omp, { recursive: true });
    writeFileSync(
      path.join(omp, "mcp.json"),
      JSON.stringify({ mcpServers: { a: { command: "a" } } }),
    );
    store.toggleMcp("omp", "a", false);
    expect(JSON.parse(read(path.join(omp, "mcp.json")))).toEqual({
      mcpServers: { a: { command: "a", enabled: false } },
      disabledServers: ["a"],
    });
  });

  it("refuses to touch an MCP file it can't parse", () => {
    const { codexHome, store } = setup();
    const file = path.join(codexHome, "config.toml");
    writeFileSync(file, `model = "a"\n[broken\n`);
    expect(store.get("codex").mcp.supported).toBe(false);
    expect(() => store.putMcp("codex", "x", { transport: "stdio", command: "x" })).toThrow(
      expect.objectContaining({ code: "RUNTIME_CREDENTIALS_UNREADABLE" }),
    );
    expect(read(file)).toBe(`model = "a"\n[broken\n`);
  });
});

describe("RuntimeConfigStore files", () => {
  it("creates the global prompt file and refuses stale or invalid raw writes", () => {
    const { claudeDir, codexHome, store } = setup();
    expect(store.get("claude").prompt).toMatchObject({
      path: "~/.claude/CLAUDE.md",
      exists: false,
    });
    store.writeFile("claude", "prompt", "# 我的习惯\n", null);
    expect(read(path.join(claudeDir, "CLAUDE.md"))).toBe("# 我的习惯\n");

    const file = path.join(codexHome, "config.toml");
    writeFileSync(file, `model = "a"\n`);
    const { hash } = store.readFile("codex", "config");
    expect(hash).toBe(contentHash(`model = "a"\n`));
    // TOML 语法错误不写
    expect(() => store.writeFile("codex", "config", "model = \n", hash)).toThrow(
      expect.objectContaining({ code: "RUNTIME_CONFIG_INVALID" }),
    );
    // 打开之后被别人改过：不覆盖
    writeFileSync(file, `model = "b"\n`);
    expect(() => store.writeFile("codex", "config", `model = "c"\n`, hash)).toThrow(
      expect.objectContaining({ code: "RUNTIME_CONFIG_CHANGED" }),
    );
    expect(read(file)).toBe(`model = "b"\n`);
    store.writeFile("codex", "config", `model = "c"\n`, contentHash(`model = "b"\n`));
    expect(read(file)).toBe(`model = "c"\n`);
    // 不在名单里的文件不让碰
    expect(() => store.readFile("codex", "../../etc/passwd")).toThrow(
      expect.objectContaining({ code: "RUNTIME_CONFIG_INVALID" }),
    );
  });
});

describe("runtime config routes", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("is local-owner only, does not log values, and returns raw files only via POST", async () => {
    const { codexHome, credentials } = setup();
    writeFileSync(
      path.join(codexHome, "config.toml"),
      `model = "a"\n[mcp_servers.x]\ncommand = "x"\n[mcp_servers.x.env]\nKEY = "${SECRET}"\n`,
    );
    const logs: string[] = [];
    const app = await buildApp({
      databasePath: ":memory:",
      token: "join-token",
      staticDir: "/definitely-not-present",
      logger: { level: "info", stream: { write: (line: string) => void logs.push(line) } },
      runtimeCredentials: credentials,
      localAgents: {
        cli: { command: "/usr/bin/node", args: ["cli.js"] },
        serverUrl: "http://127.0.0.1:8787",
        spawn: vi.fn<SpawnAgent>(),
        probe: async () => ({ installed: true, version: "1.0.0" }),
      },
    });
    close = () => app.close();
    const session = (await app.inject({ method: "GET", url: "/api/local/session" })).json() as {
      ownerToken: string;
    };
    const owner = { "x-hive-owner": session.ownerToken };

    const config = await app.inject({
      method: "GET",
      url: "/api/local/runtime-config/codex",
      headers: owner,
    });
    expect(config.statusCode).toBe(200);
    expect(config.body).not.toContain(SECRET);
    expect(config.json().config.mcp.servers[0].envKeys).toEqual(["KEY"]);

    const raw = await app.inject({
      method: "POST",
      url: "/api/local/runtime-config/codex/files/config/read",
      headers: owner,
    });
    expect(raw.json().content).toContain(SECRET);
    expect(raw.headers["cache-control"]).toBe("no-store");

    const update = await app.inject({
      method: "PUT",
      url: "/api/local/runtime-config/codex/fields",
      headers: owner,
      payload: { values: { model: "gpt-secret-model" } },
    });
    expect(update.statusCode).toBe(200);
    const all = logs.join("\n");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("gpt-secret-model");
    expect(all).toContain('"target":["model"]');

    for (const call of [
      { method: "GET" as const, url: "/api/local/runtime-config/codex" },
      { method: "POST" as const, url: "/api/local/runtime-config/codex/files/config/read" },
      {
        method: "PUT" as const,
        url: "/api/local/runtime-config/codex/fields",
        payload: { values: { model: "x" } },
      },
    ]) {
      const agent = await app.inject({ ...call, headers: { authorization: "Bearer join-token" } });
      expect(agent.statusCode).toBe(401);
      const other = await app.inject({ ...call, remoteAddress: "10.0.0.20" });
      expect(other.statusCode).toBe(403);
      expect(other.body).not.toContain(SECRET);
    }
  });
});
