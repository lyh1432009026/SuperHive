import { execFile, spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { commandFor } from "./windows-command.js";

const usage = `
用法：
  hive models --provider codex|claude|copilot|opencode|omp|openclaw [--command PATH] [--json]

列出这个 Agent CLI 能用的模型，供网页上选择模型、「换个模型重试」使用。
codex 用 app-server 的 model/list，opencode 用 opencode models，omp 用 omp models --json，
openclaw 用 openclaw models list --json；claude、copilot 没有列模型的命令，给出常用选项，网页上也能手填。
`;

export type ModelProvider = "codex" | "claude" | "copilot" | "opencode" | "omp" | "openclaw";

export type ModelEntry = {
  /** 传给运行时的模型名（--model、turn/start 的 model、ACP 的 configOption 值） */
  id: string;
  /** 显示名（和 id 一样时不给） */
  label?: string;
  /** 运行时自己的默认模型 */
  isDefault?: boolean;
};

export type ModelList = {
  provider: ModelProvider;
  /** runtime：从运行时拉到的；preset：运行时没有列模型的能力，给的常用选项 */
  source: "runtime" | "preset";
  models: ModelEntry[];
  /** 拉取失败的原因（这时 models 是常用选项） */
  error?: string;
};

/** 跑一个命令拿标准输出（测试注入） */
export type ModelRunner = (command: string, args: string[]) => Promise<string>;
/** 和 Codex app-server 说一次 model/list（测试注入） */
export type CodexModelLister = (command: string) => Promise<unknown>;

const TIMEOUT_MS = 20_000;
const MAX_MODELS = 300;

/** 没有列模型命令的运行时给的常用选项（别名由 CLI 自己解析到当前最新的版本） */
const PRESETS: Partial<Record<ModelProvider, ModelEntry[]>> = {
  claude: [
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
    { id: "opusplan", label: "Opus Plan（计划用 Opus、执行用 Sonnet）" },
  ],
  copilot: [{ id: "auto", label: "Auto（Copilot 自动选）" }],
};

const defaultRunner: ModelRunner = (command, args) =>
  new Promise((resolve, reject) => {
    const target = commandFor(command, args);
    execFile(
      target.command,
      target.args,
      { timeout: TIMEOUT_MS, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

/** 起一个 codex app-server，握手后调 model/list（分页取完），然后关掉 */
const defaultCodexLister: CodexModelLister = (command) =>
  new Promise((resolve, reject) => {
    const target = commandFor(command, ["app-server"]);
    const child = spawn(target.command, target.args, {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const data: unknown[] = [];
    let buffer = "";
    let nextId = 2;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve({ data });
    };
    const timer = setTimeout(
      () => finish(new Error("Codex app-server 没有在 20 秒内返回模型列表")),
      TIMEOUT_MS,
    );
    const write = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const list = (cursor?: string) =>
      write({ id: nextId++, method: "model/list", params: cursor ? { cursor } : {} });
    child.on("error", (error) => finish(error));
    child.on("exit", () => finish(new Error("Codex app-server 提前退出")));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === undefined || message.method) continue;
        if (message.error) {
          finish(new Error(String(message.error.message ?? "model/list 失败")));
          return;
        }
        if (message.id === 1) {
          write({ method: "initialized" });
          list();
          continue;
        }
        if (Array.isArray(message.result?.data)) data.push(...message.result.data);
        const cursor = message.result?.nextCursor;
        if (typeof cursor === "string" && cursor && data.length < MAX_MODELS) list(cursor);
        else finish();
      }
    });
    write({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "superhive", title: "SuperHive", version: "0" } },
    });
  });

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function entry(id: string, label?: string, isDefault?: boolean): ModelEntry {
  return {
    id,
    ...(label && label !== id ? { label } : {}),
    ...(isDefault ? { isDefault: true } : {}),
  };
}

function unique(models: ModelEntry[]): ModelEntry[] {
  const seen = new Set<string>();
  return models.filter((model) => !seen.has(model.id) && seen.add(model.id)).slice(0, MAX_MODELS);
}

function parseCodex(result: unknown): ModelEntry[] {
  const data = Array.isArray((result as { data?: unknown })?.data)
    ? ((result as { data: unknown[] }).data as Record<string, unknown>[])
    : [];
  return data.flatMap((item) => {
    const id = text(item?.model) ?? text(item?.id);
    if (!id || item.hidden === true) return [];
    return [entry(id, text(item.displayName), item.isDefault === true)];
  });
}

/** opencode models：一行一个 provider/model */
function parseLines(stdout: string): ModelEntry[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[\w.@-]+\/[\w.:@/-]+$/.test(line))
    .map((line) => entry(line));
}

/** omp models --json：{ models: [{ selector, name }] } */
function parseOmp(stdout: string): ModelEntry[] {
  const models = (JSON.parse(stdout) as { models?: Record<string, unknown>[] }).models ?? [];
  return models.flatMap((item) => {
    const id = text(item?.selector) ?? text(item?.id);
    if (!id || (item.kind !== undefined && item.kind !== "chat")) return [];
    return [entry(id, text(item.name))];
  });
}

/** openclaw models list --json：{ models: [{ key, name, available, tags }] } */
function parseOpenClaw(stdout: string): ModelEntry[] {
  const start = stdout.indexOf("{");
  const models =
    (
      JSON.parse(start >= 0 ? stdout.slice(start) : stdout) as {
        models?: Record<string, unknown>[];
      }
    ).models ?? [];
  return models.flatMap((item) => {
    const id = text(item?.key);
    if (!id || item.available === false) return [];
    const tags = Array.isArray(item.tags) ? item.tags : [];
    return [entry(id, text(item.name), tags.includes("default"))];
  });
}

export async function listModels(options: {
  provider: ModelProvider;
  command?: string;
  run?: ModelRunner;
  listCodex?: CodexModelLister;
}): Promise<ModelList> {
  const { provider } = options;
  const command = options.command ?? provider;
  const run = options.run ?? defaultRunner;
  const preset = PRESETS[provider];
  if (preset) return { provider, source: "preset", models: preset };
  try {
    let models: ModelEntry[];
    if (provider === "codex")
      models = parseCodex(await (options.listCodex ?? defaultCodexLister)(command));
    else if (provider === "opencode") models = parseLines(await run(command, ["models"]));
    else if (provider === "omp") models = parseOmp(await run(command, ["models", "--json"]));
    else models = parseOpenClaw(await run(command, ["models", "list", "--json"]));
    return { provider, source: "runtime", models: unique(models) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      provider,
      source: "preset",
      models: [],
      error: reason.replace(/\s+/g, " ").slice(0, 300),
    };
  }
}

const PROVIDERS: readonly ModelProvider[] = [
  "codex",
  "claude",
  "copilot",
  "opencode",
  "omp",
  "openclaw",
];

export async function modelsCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    options: {
      provider: { type: "string", default: "codex" },
      command: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (parsed.values.help) {
    console.log(usage);
    return;
  }
  const provider = parsed.values.provider as ModelProvider;
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`不支持的 provider “${provider}”；可用：${PROVIDERS.join("、")}。`);
  }
  const result = await listModels({
    provider,
    ...(parsed.values.command ? { command: parsed.values.command } : {}),
  });
  if (parsed.values.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.error) console.log(`拉取模型列表失败：${result.error}`);
  if (result.source === "preset")
    console.log("（运行时没有列模型的命令，以下是常用选项，也可以手填）");
  for (const model of result.models) {
    console.log(
      `${model.id}${model.label ? `  ${model.label}` : ""}${model.isDefault ? "  （默认）" : ""}`,
    );
  }
}
