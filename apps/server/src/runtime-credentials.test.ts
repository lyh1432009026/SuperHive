import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import type { SpawnAgent } from "./local-agents.js";
import {
  parseJsonc,
  setJsoncString,
  setTomlString,
  setYamlString,
  yamlUnsafe,
} from "./config-edit.js";
import {
  RuntimeCredentialStore,
  maskSecret,
  maskUrl,
  type RuntimeCredentialsOptions,
} from "./runtime-credentials.js";

const CLAUDE_KEY = "sk-ant-claude-secret-0123456789";
const CODEX_KEY = "sk-codex-secret-abcdefghijkl";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** 不读真实环境变量和系统托管配置 */
function isolated(home: string): RuntimeCredentialsOptions {
  return { home, env: {}, claudeManagedSettings: path.join(home, "managed-settings.json") };
}

function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "hive-creds-"));
  dirs.push(home);
  const claudeDir = path.join(home, ".claude");
  const codexHome = path.join(home, ".codex");
  mkdirSync(claudeDir);
  mkdirSync(codexHome);
  return { home, claudeDir, codexHome };
}

const CODEX_CONFIG = `model = "gpt-5"
model_provider = "gateway" # 公司网关

[model_providers.gateway]
name = "Gateway"
base_url = "https://gw.example.com/v1" # 地址
wire_api = "responses"
experimental_bearer_token = "${CODEX_KEY}"

[projects."/Users/me/code"]
trust_level = "trusted"
`;

describe("masking", () => {
  it("shows only the ends of a key and the start of a host", () => {
    expect(maskSecret(CLAUDE_KEY)).toBe("sk-a••••6789");
    expect(maskSecret("short")).toBe("•••••");
    expect(maskUrl("https://api.example.com/v1?key=abc")).toBe("https://api.••••.com/…");
    expect(maskUrl("http://gw:8080/")).toBe("http://gw••••");
  });
});

describe("TOML editing", () => {
  it("replaces a value in place, keeping comments and other tables", () => {
    const next = setTomlString(
      CODEX_CONFIG,
      ["model_providers", "gateway"],
      "base_url",
      "https://new.example.com",
    );
    expect(next).toContain('base_url = "https://new.example.com" # 地址');
    expect(next.replace('"https://new.example.com"', '"https://gw.example.com/v1"')).toBe(
      CODEX_CONFIG,
    );
  });

  it("appends a missing key at the end of its table and escapes quotes", () => {
    const next = setTomlString(CODEX_CONFIG, ["model_providers", "gateway"], "env_note", 'a"b\\c');
    expect(next).toContain(
      `experimental_bearer_token = "${CODEX_KEY}"\nenv_note = "a\\"b\\\\c"\n\n[projects`,
    );
  });

  it("refuses multi-line values instead of corrupting them", () => {
    const content = `[model_providers.x]\nbase_url = """\nhttps://a\n"""\n`;
    expect(() =>
      setTomlString(content, ["model_providers", "x"], "base_url", "https://b"),
    ).toThrow();
  });
});

describe("RuntimeCredentialStore", () => {
  it("reads Claude Code's settings.json env and writes back with a private backup", () => {
    const { home, claudeDir, codexHome } = fixture();
    const file = path.join(claudeDir, "settings.json");
    const original = JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: "https://claude.example.com",
          ANTHROPIC_AUTH_TOKEN: CLAUDE_KEY,
          OTHER: "1",
        },
        model: "opus",
      },
      null,
      2,
    );
    writeFileSync(file, original);
    chmodSync(file, 0o644);
    const store = new RuntimeCredentialStore({
      ...isolated(home),
      claudeDir,
      codexHome,
      now: () => 0,
    });

    const claude = store.get("claude");
    expect(claude.files).toEqual(["~/.claude/settings.json"]);
    expect(claude.apiKey).toMatchObject({ set: true, masked: "sk-a••••6789", editable: true });
    expect(claude.apiKey.location).toContain("env.ANTHROPIC_AUTH_TOKEN");
    expect(JSON.stringify(claude)).not.toContain(CLAUDE_KEY);
    expect(store.reveal("claude", "apiKey")).toBe(CLAUDE_KEY);

    store.update("claude", { baseUrl: "https://new.example.com", apiKey: "sk-new-0123456789abc" });
    const written = JSON.parse(readFileSync(file, "utf8")) as {
      env: Record<string, string>;
      model: string;
    };
    expect(written.env).toEqual({
      ANTHROPIC_BASE_URL: "https://new.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-new-0123456789abc",
      OTHER: "1",
    });
    expect(written.model).toBe("opus");
    // 原文件权限保持；备份是改之前的原文，只有自己能读
    expect(statSync(file).mode & 0o777).toBe(0o644);
    const backups = readdirSync(claudeDir).filter((name) => name.includes(".superhive-bak-"));
    expect(backups).toHaveLength(1);
    const backup = path.join(claudeDir, backups[0]!);
    expect(readFileSync(backup, "utf8")).toBe(original);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    // 没有留下临时文件
    expect(readdirSync(claudeDir).some((name) => name.includes(".superhive-tmp-"))).toBe(false);
  });

  it("keeps ANTHROPIC_API_KEY when that is what Claude Code already uses, and creates a missing file privately", () => {
    const { home, claudeDir, codexHome } = fixture();
    const store = new RuntimeCredentialStore({ ...isolated(home), claudeDir, codexHome });
    expect(store.get("claude").apiKey).toMatchObject({ set: false, masked: null, editable: true });
    store.update("claude", { apiKey: "sk-created-0123456789" });
    const file = path.join(claudeDir, "settings.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      env: { ANTHROPIC_AUTH_TOKEN: "sk-created-0123456789" },
    });

    writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_API_KEY: CLAUDE_KEY } }));
    store.update("claude", { apiKey: "sk-replaced-0123456789" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      env: { ANTHROPIC_API_KEY: "sk-replaced-0123456789" },
    });
  });

  it("writes through a symlinked config instead of replacing the link", () => {
    const { home, claudeDir, codexHome } = fixture();
    const real = path.join(home, "dotfiles-settings.json");
    writeFileSync(real, "{}\n");
    symlinkSync(real, path.join(claudeDir, "settings.json"));
    new RuntimeCredentialStore({ ...isolated(home), claudeDir, codexHome }).update("claude", {
      baseUrl: "https://linked.example.com",
    });
    expect(JSON.parse(readFileSync(real, "utf8")).env.ANTHROPIC_BASE_URL).toBe(
      "https://linked.example.com",
    );
  });

  it("edits the active Codex model provider in config.toml", () => {
    const { home, claudeDir, codexHome } = fixture();
    const file = path.join(codexHome, "config.toml");
    writeFileSync(file, CODEX_CONFIG, { mode: 0o600 });
    const store = new RuntimeCredentialStore({ ...isolated(home), claudeDir, codexHome });
    const codex = store.get("codex");
    expect(codex.baseUrl).toMatchObject({
      set: true,
      masked: "https://gw.e••••.com/…",
      editable: true,
    });
    expect(codex.apiKey.location).toContain("experimental_bearer_token");
    expect(store.reveal("codex", "apiKey")).toBe(CODEX_KEY);

    store.update("codex", {
      baseUrl: "https://gw2.example.com/v1",
      apiKey: "sk-codex-new-0123456789",
    });
    expect(readFileSync(file, "utf8")).toBe(
      CODEX_CONFIG.replace("https://gw.example.com/v1", "https://gw2.example.com/v1").replace(
        CODEX_KEY,
        "sk-codex-new-0123456789",
      ),
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("does not offer to edit keys that come from an env var or a ChatGPT login", () => {
    const { home, claudeDir, codexHome } = fixture();
    writeFileSync(
      path.join(codexHome, "config.toml"),
      `model_provider = "gw"\n[model_providers.gw]\nbase_url = "https://gw.example.com"\nenv_key = "GW_KEY"\n`,
    );
    const store = new RuntimeCredentialStore({ ...isolated(home), claudeDir, codexHome });
    expect(store.get("codex").apiKey).toMatchObject({ editable: false });
    expect(store.get("codex").apiKey.note).toContain("GW_KEY");
    expect(() => store.update("codex", { apiKey: "sk-x-0123456789" })).toThrow(
      expect.objectContaining({ code: "RUNTIME_CREDENTIALS_NOT_EDITABLE" }),
    );

    // 内置 OpenAI：地址不能改，密钥在 auth.json；ChatGPT 登录时也不能改
    writeFileSync(path.join(codexHome, "config.toml"), `model = "gpt-5"\n`);
    writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { id_token: "x" } }));
    expect(store.get("codex").baseUrl.editable).toBe(false);
    expect(store.get("codex").apiKey.editable).toBe(false);
    writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: CODEX_KEY }));
    store.update("codex", { apiKey: "sk-openai-new-0123456789" });
    expect(JSON.parse(readFileSync(path.join(codexHome, "auth.json"), "utf8"))).toEqual({
      OPENAI_API_KEY: "sk-openai-new-0123456789",
    });
  });

  it("leaves the original files intact when a write fails halfway", () => {
    const { home, claudeDir, codexHome } = fixture();
    const config = `model_provider = "gw"\n[model_providers.gw]\nbase_url = "https://gw.example.com"\nrequires_openai_auth = true\n`;
    writeFileSync(path.join(codexHome, "config.toml"), config);
    const auth = JSON.stringify({ OPENAI_API_KEY: CODEX_KEY });
    writeFileSync(path.join(codexHome, "auth.json"), auth);
    let writes = 0;
    const store = new RuntimeCredentialStore({
      ...isolated(home),
      claudeDir,
      codexHome,
      // 备份 config、写 config、备份 auth 成功，写 auth 时磁盘满
      writeFile: (fd, content) => {
        writes += 1;
        if (writes === 4) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        writeFileSync(fd, content);
      },
    });
    expect(() =>
      store.update("codex", {
        baseUrl: "https://changed.example.com",
        apiKey: "sk-changed-0123456789",
      }),
    ).toThrow(expect.objectContaining({ code: "RUNTIME_CREDENTIALS_WRITE_FAILED" }));
    // config.toml 已经换掉的那份被还原，auth.json 没动过
    expect(readFileSync(path.join(codexHome, "config.toml"), "utf8")).toBe(config);
    expect(readFileSync(path.join(codexHome, "auth.json"), "utf8")).toBe(auth);
    expect(readdirSync(codexHome).some((name) => name.includes(".superhive-tmp-"))).toBe(false);
  });

  it("does not echo file contents when the config can't be parsed", () => {
    const { home, claudeDir, codexHome } = fixture();
    writeFileSync(
      path.join(claudeDir, "settings.json"),
      `{ "env": { "ANTHROPIC_AUTH_TOKEN": "${CLAUDE_KEY}" `,
    );
    const store = new RuntimeCredentialStore({ ...isolated(home), claudeDir, codexHome });
    // 不报错：整项标成只读并说明读不懂，也不带出文件内容
    const claude = store.get("claude");
    expect(claude.configured).toBe(false);
    expect(claude.note).toContain("读不懂");
    expect(JSON.stringify(claude)).not.toContain(CLAUDE_KEY);
    expect(() => store.update("claude", { apiKey: "sk-x-0123456789" })).toThrow(
      expect.objectContaining({ code: "RUNTIME_CREDENTIALS_NOT_EDITABLE" }),
    );
  });

  it("keeps only the latest few backups", () => {
    const { home, claudeDir, codexHome } = fixture();
    writeFileSync(path.join(claudeDir, "settings.json"), "{}");
    let clock = 0;
    const store = new RuntimeCredentialStore({
      ...isolated(home),
      claudeDir,
      codexHome,
      now: () => (clock += 1000),
    });
    for (let index = 0; index < 8; index += 1) {
      store.update("claude", { baseUrl: `https://n${index}.example.com` });
    }
    expect(readdirSync(claudeDir).filter((name) => name.includes(".superhive-bak-"))).toHaveLength(
      5,
    );
  });
});

describe("JSONC and YAML editing", () => {
  it("changes one JSONC value and keeps comments and layout", () => {
    const content = `{\n  // 注释\n  "a": { "b": "old" }, // 行尾\n  "c": [1, 2]\n}\n`;
    expect(setJsoncString(content, ["a", "b"], "new")).toBe(content.replace('"old"', '"new"'));
    expect(parseJsonc(setJsoncString(content, ["a", "d"], "x"))).toEqual({
      a: { b: "old", d: "x" },
      c: [1, 2],
    });
    expect(() => setJsoncString(`{ a: 1 }`, ["a"], "x")).toThrow();
  });

  it("replaces a YAML scalar in place and appends a missing key at the entry's indent", () => {
    const content = `# models\nproviders: # catalog\n    gw:\n        baseUrl: https://old.example # url\n        api: openai-completions\n\n    other:\n        baseUrl: https://other.example\nextra: 1\n`;
    expect(setYamlString(content, ["providers", "gw", "baseUrl"], "https://new.example")).toBe(
      content.replace("https://old.example", '"https://new.example"'),
    );
    expect(setYamlString(content, ["providers", "gw", "apiKey"], "sk-1")).toBe(
      content.replace(
        "        api: openai-completions\n",
        '        api: openai-completions\n        apiKey: "sk-1"\n',
      ),
    );
  });

  it("refuses YAML with anchors, aliases, tags or flow style", () => {
    expect(yamlUnsafe(`a: &x 1\nb: *x\n`)).toBe(true);
    expect(yamlUnsafe(`a: !!str 1\n`)).toBe(true);
    expect(yamlUnsafe(`providers: {gw: {baseUrl: x}}\n`)).toBe(true);
    expect(yamlUnsafe(`base: &b\n  x: 1\nother:\n  <<: *b\n`)).toBe(true);
    expect(yamlUnsafe(`providers:\n  gw:\n    name: Search & Fetch\n`)).toBe(false);
    expect(() =>
      setYamlString(`providers:\n  gw: &g\n    baseUrl: x\n`, ["providers", "gw", "baseUrl"], "y"),
    ).toThrow();
  });
});

describe("other runtimes", () => {
  function store(home: string, env: NodeJS.ProcessEnv = {}) {
    return new RuntimeCredentialStore({
      ...isolated(home),
      env,
      claudeDir: path.join(home, ".claude"),
      codexHome: path.join(home, ".codex"),
    });
  }

  it("reports runtimes that aren't installed or configured instead of failing", () => {
    const { home } = fixture();
    const runtimes = store(home).list();
    for (const provider of ["opencode", "omp", "openclaw", "copilot"]) {
      const runtime = runtimes.find((item) => item.provider === provider)!;
      expect(runtime.configured).toBe(false);
      expect(runtime.note).toBeTruthy();
      expect(runtime.baseUrl.editable).toBe(false);
    }
    expect(runtimes.find((item) => item.provider === "codex")!.configured).toBe(false);
  });

  it("edits the current opencode provider in opencode.jsonc and keeps comments", () => {
    const { home } = fixture();
    const dir = path.join(home, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "opencode.jsonc");
    const content = `{\n  // 智谱\n  "provider": {\n    "zhipu": {\n      "npm": "@ai-sdk/openai-compatible",\n      "options": { "baseURL": "https://open.example.com/v4", "apiKey": "${CODEX_KEY}" }\n    },\n    "env-one": { "options": { "apiKey": "{env:ONE_KEY}" } }\n  },\n  "model": "zhipu/glm-5"\n}\n`;
    writeFileSync(file, content);
    const opencode = store(home);
    const runtime = opencode.get("opencode");
    expect(runtime).toMatchObject({ configured: true, providerId: "zhipu", effect: "restart" });
    expect(runtime.apiKey).toMatchObject({ editable: true, masked: "sk-c••••ijkl" });
    opencode.update("opencode", { apiKey: "sk-opencode-new-0123" });
    expect(readFileSync(file, "utf8")).toBe(content.replace(CODEX_KEY, "sk-opencode-new-0123"));

    // 当前模型的 provider 引用环境变量：只读
    writeFileSync(file, content.replace('"zhipu/glm-5"', '"env-one/x"'));
    expect(opencode.get("opencode").apiKey).toMatchObject({ editable: false });
    expect(opencode.get("opencode").apiKey.note).toContain("ONE_KEY");
    // 内置 provider（没写在配置里）
    writeFileSync(file, content.replace('"zhipu/glm-5"', '"anthropic/claude"'));
    expect(opencode.get("opencode")).toMatchObject({ configured: false, providerId: "anthropic" });
  });

  it("edits omp models.yml for the default model role and leaves env-name keys alone", () => {
    const { home } = fixture();
    const dir = path.join(home, ".omp", "agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.yml"), `modelRoles:\n  default: gw/glm-5\n`);
    const models = `providers:\n  gw:\n    baseUrl: https://gw.example.com/v1 # gateway\n    apiKey: ${CODEX_KEY}\n    api: openai-completions\n  env:\n    apiKey: GW_API_KEY\n`;
    const file = path.join(dir, "models.yml");
    writeFileSync(file, models);
    const omp = store(home);
    expect(omp.get("omp")).toMatchObject({ configured: true, providerId: "gw", effect: "restart" });
    omp.update("omp", { baseUrl: "https://gw2.example.com/v1", apiKey: "sk-omp-new-0123456" });
    expect(readFileSync(file, "utf8")).toBe(
      models
        .replace("https://gw.example.com/v1", '"https://gw2.example.com/v1"')
        .replace(CODEX_KEY, '"sk-omp-new-0123456"'),
    );

    writeFileSync(path.join(dir, "config.yml"), `modelRoles:\n  default: env/glm-5\n`);
    expect(omp.get("omp").apiKey).toMatchObject({ editable: false });
    expect(omp.get("omp").apiKey.note).toContain("GW_API_KEY");

    // 有锚点就整份只读
    writeFileSync(path.join(dir, "config.yml"), `modelRoles:\n  default: gw/glm-5\n`);
    writeFileSync(
      file,
      `defaults: &d\n  api: openai-completions\nproviders:\n  gw:\n    <<: *d\n    baseUrl: https://x.example\n`,
    );
    expect(omp.get("omp").baseUrl).toMatchObject({ editable: false });
    expect(() => omp.update("omp", { baseUrl: "https://y.example" })).toThrow(
      expect.objectContaining({ code: "RUNTIME_CREDENTIALS_NOT_EDITABLE" }),
    );
  });

  it("edits OpenClaw's models.providers entry for the primary model, refusing JSON5-only syntax", () => {
    const { home } = fixture();
    mkdirSync(path.join(home, ".openclaw"));
    const file = path.join(home, ".openclaw", "openclaw.json");
    const content = JSON.stringify(
      {
        agents: { defaults: { model: { primary: "gw/glm-5" } } },
        models: { providers: { gw: { baseUrl: "https://gw.example.com", apiKey: "${GW_KEY}" } } },
      },
      null,
      2,
    );
    writeFileSync(file, content);
    const openclaw = store(home);
    const runtime = openclaw.get("openclaw");
    expect(runtime).toMatchObject({ configured: true, providerId: "gw", effect: "gateway" });
    expect(runtime.apiKey).toMatchObject({ editable: false });
    openclaw.update("openclaw", { baseUrl: "https://gw2.example.com" });
    expect(readFileSync(file, "utf8")).toBe(
      content.replace("https://gw.example.com", "https://gw2.example.com"),
    );

    writeFileSync(file, `{ agents: { defaults: { model: "gw/x" } } }`);
    expect(openclaw.get("openclaw")).toMatchObject({ configured: false });
    expect(openclaw.get("openclaw").note).toContain("JSON5");
  });

  it("edits Copilot BYOK providers.json and flags COPILOT_PROVIDER_* overrides", () => {
    const { home } = fixture();
    const dir = path.join(home, ".copilot");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ model: "gw/glm-5" }));
    const file = path.join(dir, "providers.json");
    const content = JSON.stringify(
      {
        providers: [
          { name: "other", type: "openai", baseUrl: "https://other.example" },
          { name: "gw", type: "openai", baseUrl: "https://gw.example.com", bearerToken: CODEX_KEY },
        ],
        models: [{ id: "glm-5", provider: "gw" }],
      },
      null,
      2,
    );
    writeFileSync(file, content);
    const copilot = store(home);
    const runtime = copilot.get("copilot");
    expect(runtime).toMatchObject({ configured: true, providerId: "gw", effect: "nextTurn" });
    expect(runtime.apiKey.location).toContain("bearerToken");
    copilot.update("copilot", { apiKey: "sk-copilot-new-0123" });
    expect(readFileSync(file, "utf8")).toBe(content.replace(CODEX_KEY, "sk-copilot-new-0123"));

    const shadowed = store(home, { COPILOT_PROVIDER_BASE_URL: "https://env.example" });
    expect(shadowed.get("copilot").baseUrl.shadowedBy).toBe("COPILOT_PROVIDER_BASE_URL");

    // 官方模型（GitHub 登录）
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ model: "gpt-5" }));
    expect(copilot.get("copilot")).toMatchObject({ configured: false });
    expect(copilot.get("copilot").note).toContain("GitHub");
  });

  it("flags Claude Code values overridden by managed or project settings", () => {
    const { home, claudeDir } = fixture();
    writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: "https://a.example", ANTHROPIC_AUTH_TOKEN: CLAUDE_KEY },
      }),
    );
    const project = path.join(home, "repo");
    mkdirSync(path.join(project, ".claude"), { recursive: true });
    writeFileSync(
      path.join(project, ".claude", "settings.local.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://project.example" } }),
    );
    const claude = store(home).get("claude", { cwds: [project] });
    expect(claude.baseUrl.shadowedBy).toBe(
      "~/repo/.claude/settings.local.json → env.ANTHROPIC_BASE_URL",
    );
    expect(claude.apiKey.shadowedBy).toBeUndefined();
    expect(claude.effect).toBe("nextTurn");
  });
});

describe("runtime credential routes", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function setup() {
    const { home, claudeDir, codexHome } = fixture();
    writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: "https://claude.example.com", ANTHROPIC_AUTH_TOKEN: CLAUDE_KEY },
      }),
    );
    const logs: string[] = [];
    const app = await buildApp({
      databasePath: ":memory:",
      token: "join-token",
      staticDir: "/definitely-not-present",
      logger: { level: "info", stream: { write: (line: string) => void logs.push(line) } },
      runtimeCredentials: new RuntimeCredentialStore({ ...isolated(home), claudeDir, codexHome }),
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
    return { app, owner: { "x-hive-owner": session.ownerToken }, logs, claudeDir };
  }

  it("lists masked values and reveals the full value only to the local owner", async () => {
    const { app, owner, logs } = await setup();
    const list = await app.inject({
      method: "GET",
      url: "/api/local/runtime-credentials",
      headers: owner,
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(CLAUDE_KEY);
    const runtimes = list.json().runtimes as Array<{
      provider: string;
      apiKey: { masked: string };
    }>;
    expect(runtimes.map((runtime) => runtime.provider)).toEqual([
      "claude",
      "codex",
      "opencode",
      "omp",
      "openclaw",
      "copilot",
    ]);
    expect(runtimes[0]!.apiKey.masked).toBe("sk-a••••6789");

    const reveal = await app.inject({
      method: "POST",
      url: "/api/local/runtime-credentials/claude/reveal",
      headers: owner,
      payload: { field: "apiKey" },
    });
    expect(reveal.json()).toEqual({ value: CLAUDE_KEY });
    expect(reveal.headers["cache-control"]).toBe("no-store");
    // 审计记了谁看了哪一项，没有记值
    const audit = logs.filter((line) => line.includes("runtimeCredential"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toContain('"action":"view"');
    expect(audit[0]).toContain('"fields":["apiKey"]');
    expect(logs.join("\n")).not.toContain(CLAUDE_KEY);
  });

  it("rejects other computers, owner devices, the join token and missing owner credentials", async () => {
    const { app } = await setup();
    const remote = { remoteAddress: "10.0.0.20" };
    const calls = [
      { method: "GET" as const, url: "/api/local/runtime-credentials" },
      {
        method: "POST" as const,
        url: "/api/local/runtime-credentials/claude/reveal",
        payload: { field: "apiKey" },
      },
      {
        method: "PUT" as const,
        url: "/api/local/runtime-credentials/claude",
        payload: { apiKey: "sk-x-0123456789" },
      },
    ];
    for (const call of calls) {
      // 本机但没有房主凭证（例如 Agent 拿着总令牌）
      const agent = await app.inject({ ...call, headers: { authorization: "Bearer join-token" } });
      expect(agent.statusCode).toBe(401);
      // 别的电脑
      const other = await app.inject({ ...call, ...remote });
      expect(other.statusCode).toBe(403);
      expect(other.body).not.toContain(CLAUDE_KEY);
    }
  });

  it("writes back, reports the agents to restart and audits without values", async () => {
    const { app, owner, logs, claudeDir } = await setup();
    await app.inject({
      method: "POST",
      url: "/api/local/agents",
      headers: owner,
      payload: { provider: "claude", name: "rd-claude", access: "read-only" },
    });
    const response = await app.inject({
      method: "PUT",
      url: "/api/local/runtime-credentials/claude",
      headers: owner,
      payload: { baseUrl: "https://changed.example.com", apiKey: "sk-changed-0123456789" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("sk-changed-0123456789");
    const runtime = response.json().runtime as {
      agents: Array<{ name: string }>;
      apiKey: { masked: string };
    };
    expect(runtime.agents.map((agent) => agent.name)).toEqual(["rd-claude"]);
    expect(runtime.apiKey.masked).toBe("sk-c••••6789");
    expect(JSON.parse(readFileSync(path.join(claudeDir, "settings.json"), "utf8")).env).toEqual({
      ANTHROPIC_BASE_URL: "https://changed.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-changed-0123456789",
    });
    const audit = logs.filter((line) => line.includes("runtimeCredential"));
    expect(audit.at(-1)).toContain('"fields":["baseUrl","apiKey"]');
    expect(logs.join("\n")).not.toContain("sk-changed-0123456789");
    expect(logs.join("\n")).not.toContain("changed.example.com");

    // 地址必须是 http(s)，密钥不能带空白
    for (const payload of [{ baseUrl: "ftp://x" }, { apiKey: "has space" }, {}]) {
      const bad = await app.inject({
        method: "PUT",
        url: "/api/local/runtime-credentials/claude",
        headers: owner,
        payload,
      });
      expect(bad.statusCode).toBe(400);
    }
  });
});
