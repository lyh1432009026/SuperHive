import { execFile, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ACP_PROTOCOL_VERSION, sessionModelChoices } from "./acp-responder.js";
import { geminiHomeEnv, hasGeminiApiKey } from "./gemini-client.js";
import { superhiveHome } from "./home-dir.js";
import { spawnStdioTransport } from "./stdio-transport.js";
import { commandFor } from "./windows-command.js";

const usage = `
用法：
  hive models --provider codex|claude|copilot|opencode|omp|openclaw|gemini|agy [--command PATH] [--json]

列出这个 Agent CLI 能用的模型，供网页上选择模型、「换个模型重试」使用。
codex 用 app-server 的 model/list，opencode 用 opencode models，omp 用 omp models --json，
openclaw 用 openclaw models list --json，gemini、agy 经 ACP 开一个空会话读它给的模型；
claude、copilot 没有列模型的命令，给出常用选项，网页上也能手填。
同时列出能选的思考强度（claude、codex、copilot、omp 支持；codex、omp 按模型列出）。
`;

export type ModelProvider =
  "codex" | "claude" | "copilot" | "opencode" | "omp" | "openclaw" | "gemini" | "agy";

export type ModelEntry = {
  /** 传给运行时的模型名（--model、turn/start 的 model、ACP 的 configOption 值） */
  id: string;
  /** 显示名（和 id 一样时不给） */
  label?: string;
  /** 运行时自己的默认模型 */
  isDefault?: boolean;
  /** 这个模型支持的思考强度（运行时按模型列出时才有：Codex、omp） */
  efforts?: string[];
  /** 这个模型默认的思考强度 */
  defaultEffort?: string;
};

export type ModelList = {
  provider: ModelProvider;
  /** runtime：从运行时拉到的；preset：运行时没有列模型的能力，给的常用选项 */
  source: "runtime" | "preset";
  models: ModelEntry[];
  /** 运行时接受的全部思考强度；空数组表示不支持按 Agent 切换（与 @superhive/protocol 的 RUNTIME_REASONING_EFFORTS 一致） */
  efforts: string[];
  /** 拉取失败的原因（这时 models 是常用选项） */
  error?: string;
};

/** 跑一个命令拿标准输出（测试注入） */
export type ModelRunner = (command: string, args: string[]) => Promise<string>;
/** 和 Codex app-server 说一次 model/list（测试注入） */
export type CodexModelLister = (command: string) => Promise<unknown>;
/** 起 ACP Agent 开一个空会话，返回 session/new 的结果（测试注入） */
export type AcpModelLister = (provider: "gemini" | "agy", command: string) => Promise<unknown>;

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

/**
 * 各运行时 CLI 接受的思考强度（由低到高），与 @superhive/protocol 的 RUNTIME_REASONING_EFFORTS 一致：
 * claude --effort、copilot --reasoning-effort、codex turn/start 的 effort、omp ACP 的 thinking
 */
export const RUNTIME_EFFORTS: Partial<Record<ModelProvider, string[]>> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  copilot: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  omp: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"],
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

/**
 * gemini、agy 的模型只能从 ACP 会话里拿（agy models 要求登录 Google 账号）：握手、开一个不带 MCP 的空会话，
 * 读 configOptions / models 后结束进程。agy 没登录账号而环境里有 GEMINI_API_KEY 时先用它登录，与 Bridge 一致
 */
const defaultAcpLister: AcpModelLister = (provider, command) =>
  new Promise((resolve, reject) => {
    const env = geminiHomeEnv();
    const cwd = path.join(superhiveHome(), "models-probe");
    mkdirSync(cwd, { recursive: true });
    const args = provider === "gemini" ? ["--acp", "--skip-trust"] : ["acp"];
    const transport = spawnStdioTransport(command, args, {
      cwd,
      ...(Object.keys(env).length ? { env } : {}),
    });
    const pending = new Map<number, (message: any) => void>();
    let nextId = 1;
    let done = false;
    const finish = (error?: Error, result?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      transport.kill();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(
      () => finish(new Error(`${command} 没有在 20 秒内返回模型列表`)),
      TIMEOUT_MS,
    );
    const call = (method: string, params: unknown) =>
      new Promise<any>((done, fail) => {
        const id = nextId++;
        pending.set(id, (message) =>
          message.error
            ? fail(
                Object.assign(new Error(String(message.error.message ?? `${method} 失败`)), {
                  code: message.error.code,
                }),
              )
            : done(message.result),
        );
        transport.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    transport.onExit((exit) =>
      finish(exit.error ?? new Error(`${command} 提前退出：${exit.stderr.trim().slice(-300)}`)),
    );
    transport.onLine((line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message?.method !== undefined) {
        // 不支持客户端方法；通知（session/update）忽略
        if (message.id !== undefined)
          transport.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "unsupported" },
            }),
          );
        return;
      }
      const handle = pending.get(message?.id);
      if (!handle) return;
      pending.delete(message.id);
      handle(message);
    });
    void (async () => {
      const init = await call("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "superhive", title: "SuperHive", version: "0" },
      });
      const params = { cwd, mcpServers: [] };
      try {
        return await call("session/new", params);
      } catch (error) {
        const methods: Array<{ id?: unknown }> = Array.isArray(init?.authMethods)
          ? init.authMethods
          : [];
        const canUseKey =
          provider === "agy" &&
          (error as { code?: unknown }).code === -32000 &&
          hasGeminiApiKey(env) &&
          methods.some((method) => method?.id === "gemini-api-key");
        if (!canUseKey) throw error;
        await call("authenticate", { methodId: "gemini-api-key" });
        return await call("session/new", params);
      }
    })().then(
      (result) => finish(undefined, result),
      (error: Error) => finish(error),
    );
  });

/** ACP session/new 的结果：configOptions 的 model 或 models.availableModels */
function parseAcpSession(result: unknown): ModelEntry[] {
  const found = sessionModelChoices(result);
  if (!found) return [];
  const names = new Map<string, string>();
  const record = result as {
    configOptions?: Array<{ id?: unknown; category?: unknown; options?: unknown }>;
    models?: { availableModels?: Array<{ modelId?: unknown; name?: unknown }> };
  };
  if (found.via === "config") {
    const option = record.configOptions?.find(
      (item) => item?.id === "model" || item?.category === "model",
    );
    for (const item of Array.isArray(option?.options)
      ? (option.options as Array<{ value?: unknown; name?: unknown }>)
      : []) {
      const value = text(item?.value);
      const name = text(item?.name);
      if (value && name) names.set(value, name);
    }
  } else {
    for (const item of record.models?.availableModels ?? []) {
      const value = text(item?.modelId);
      const name = text(item?.name);
      if (value && name) names.set(value, name);
    }
  }
  return found.options.map((id) => entry(id, names.get(id), id === found.current));
}

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

function withEfforts(model: ModelEntry, efforts: string[], defaultEffort?: string): ModelEntry {
  const list = [...new Set(efforts)];
  return {
    ...model,
    ...(list.length ? { efforts: list } : {}),
    ...(defaultEffort ? { defaultEffort } : {}),
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
    const efforts = (
      Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts : []
    ).flatMap((option: { reasoningEffort?: unknown } | null) => {
      const effort = text(option?.reasoningEffort);
      return effort ? [effort] : [];
    });
    return [
      withEfforts(
        entry(id, text(item.displayName), item.isDefault === true),
        efforts,
        text(item.defaultReasoningEffort),
      ),
    ];
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
    // omp 的会话里这一项是 off、auto 加上模型自己的档位；不能推理的模型只能 off
    const thinking = Array.isArray(item.thinking)
      ? item.thinking.filter((level): level is string => typeof level === "string")
      : [];
    const efforts = item.reasoning === false ? [] : ["off", ...thinking, "auto"];
    return [withEfforts(entry(id, text(item.name)), efforts)];
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
  listAcp?: AcpModelLister;
}): Promise<ModelList> {
  const { provider } = options;
  const command = options.command ?? provider;
  const run = options.run ?? defaultRunner;
  const efforts = RUNTIME_EFFORTS[provider] ?? [];
  const preset = PRESETS[provider];
  if (preset) return { provider, source: "preset", models: preset, efforts };
  try {
    let models: ModelEntry[];
    if (provider === "codex")
      models = parseCodex(await (options.listCodex ?? defaultCodexLister)(command));
    else if (provider === "opencode") models = parseLines(await run(command, ["models"]));
    else if (provider === "omp") models = parseOmp(await run(command, ["models", "--json"]));
    else if (provider === "gemini" || provider === "agy")
      models = parseAcpSession(await (options.listAcp ?? defaultAcpLister)(provider, command));
    else models = parseOpenClaw(await run(command, ["models", "list", "--json"]));
    return { provider, source: "runtime", models: unique(models), efforts };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      provider,
      source: "preset",
      models: [],
      efforts,
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
  "gemini",
  "agy",
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
      `${model.id}${model.label ? `  ${model.label}` : ""}${model.isDefault ? "  （默认）" : ""}${
        model.efforts ? `  思考强度：${model.efforts.join("/")}` : ""
      }`,
    );
  }
  if (result.efforts.length) console.log(`思考强度：${result.efforts.join("、")}`);
}
