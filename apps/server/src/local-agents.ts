import { serverText } from "@superhive/protocol";
import { execFile, execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isAgentOutdated } from "@superhive/protocol";
import type {
  AgentCodeVersion,
  CreateLocalAgentRequest,
  LocalAgent,
  LocalAgentMcpResponse,
  LocalAgentModelsResponse,
  LocalAgentProvider,
  LocalAgentStatus,
  LocalProviderInfo,
} from "@superhive/protocol";
import { codeVersionAt, packageRootOfCli } from "./code-version.js";
import { HiveError, type HiveDatabase, type LocalAgentConfig } from "./database.js";
import { expandHome } from "./local-directories.js";
import { slowOps } from "./slow-ops.js";
import { commandFor } from "./windows-command.js";

/**
 * 本机 Agent 管家：在 Hive Server 所在电脑上，按房主在网页上的选择拉起 `hive join` 子进程。
 * 只负责进程生命周期（启动、崩溃重启、停止、退出清理），Agent 的行为仍完全由 CLI 决定。
 * 鉴权与"是否本机请求"的判断在路由层（local-access.ts），这里假定调用方已通过校验。
 */

/** superhive CLI 的启动方式：打包后是 node + dist/cli.js，开发时是 node + tsx + src/cli.ts */
export type AgentCli = { command: string; args: string[] };

export type ChildHandle = {
  pid: number | undefined;
  onOutput(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null, error?: Error) => void): void;
  kill(signal: NodeJS.Signals): void;
  /** 交接给下一个 Server：停止跟踪输出和退出，但不结束进程 */
  release?(): void;
};

export type SpawnAgent = (
  command: string,
  args: string[],
  /** logFile：输出写到这个文件而不是管道，Server 退出后 Agent 仍能继续运行 */
  options: { env: Record<string, string>; cwd: string; logFile?: string },
) => ChildHandle;

/** 接管上一个 Server 留下的 Agent 进程；进程已不在或不是这个 Agent 时返回 undefined */
export type AdoptAgent = (
  pid: number,
  options: { name: string; logFile?: string },
) => ChildHandle | undefined;

export type ProviderProbe = (
  command: string,
) => Promise<{ installed: boolean; version: string | null }>;

export type LocalAgentSupervisorOptions = {
  database: HiveDatabase;
  cli: AgentCli;
  /** Agent 连接 Hive 用的地址（本机回环） */
  serverUrl: string;
  joinToken: string;
  /** 该名字的 Agent 是否已在任一房间在线，用来区分"启动中"与"运行中" */
  isAgentOnline: (name: string) => boolean;
  /** 该名字是否已被其他在线成员占用（不含本机 Agent 自己） */
  isNameInUse: (name: string) => boolean;
  /** 经 WebSocket 请这个名字的 Agent 自行退出；发出了就返回 true（Windows 上用来代替结束信号） */
  requestShutdown?: (name: string) => boolean;
  /** 在线的这个名字的 Agent 上报的代码版本；不在线或旧版 Bridge 没报时为 undefined */
  runningVersion?: (name: string) => AgentCodeVersion | undefined;
  /** 手上有没结束调用的 Agent 名字（小写，跨所有房间）：忙的不重启 */
  busyAgentNames?: () => ReadonlySet<string>;
  /** 本机 Agent 那份代码现在的版本（测试注入）；默认按 cli 入口所在的包现算 */
  currentVersion?: () => Promise<AgentCodeVersion | undefined>;
  /** 隔多久检查一次要不要自动更新（默认 60 秒）；调用结束时另会尽快检查一次 */
  updateCheckMs?: number;
  /** 当前代码版本变了（合入、升级）：成员列表里谁是旧版本跟着变 */
  onCurrentVersionChange?: () => void;
  log?: (message: string) => void;
  spawn?: SpawnAgent;
  adopt?: AdoptAgent;
  /** Agent 输出日志的目录；设置后 Agent 以独立进程组运行，Server 交接重启时不随之退出 */
  logDir?: string;
  /** Agent 设置文件目录（网页上勾选的 MCP 等）；Agent 每一轮读取，改动不必重启 */
  settingsDir?: string;
  /** 列出 Agent 会加载的本机 MCP（测试注入）；默认运行 `hive mcp list` */
  listMcp?: McpLister;
  /** 列出运行时能用的模型（测试注入）；默认运行 `hive models --provider X --json` */
  listModels?: ModelLister;
  probe?: ProviderProbe;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => { cancel(): void };
};

const LOG_LINES = 500;
const BACKOFF_MAX_MS = 60_000;
/** 10 分钟内意外退出 5 次即熔断，避免未登录等配置错误导致无限重启 */
const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_LIMIT = 5;
/** 连续运行超过 1 分钟视为稳定，之后再退出时退避从头计算 */
const STABLE_RUN_MS = 60_000;
const STOP_GRACE_MS = 5_000;
/** 服务启动时要重新拉起多个 Agent：逐个错开，免得一下子起一堆 CLI 抢 CPU、同时去刷登录态 */
const RESTORE_STAGGER_MS = 2_000;
const PROBE_CACHE_MS = 60_000;
/** 单个 Agent 日志超过这个大小时，下次启动先轮转为 .1 */
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;
const TAIL_INTERVAL_MS = 1_000;
/** 当前代码版本的缓存：合入后最多这么久就能看出 Agent 落后了 */
const VERSION_CACHE_MS = 10_000;
const UPDATE_CHECK_MS = 60_000;
/** 调用结束后稍等再查忙闲：同一轮里紧接着可能还有排队的调用被派出 */
const IDLE_CHECK_DELAY_MS = 3_000;
/** 同一个 Agent 两次自动重启至少隔这么久，免得版本判断出了岔子时反复重启 */
export const AUTO_RESTART_COOLDOWN_MS = 10 * 60_000;
/** 自动更新开关（设置项，默认开） */
export const AUTO_UPDATE_SETTING = "local-agents:auto-update";

export type McpLister = (args: string[]) => Promise<string>;
export type ModelLister = (provider: LocalAgentProvider) => Promise<LocalAgentModelsResponse>;
/** 模型列表缓存：起 Codex app-server、跑 opencode models 都要几秒 */
const MODELS_CACHE_MS = 10 * 60_000;

/** 支持按勾选加载 MCP 的 provider */
const MCP_SELECTABLE: ReadonlySet<LocalAgentProvider> = new Set(["claude", "codex"]);
/** 实测：Claude Code 不带任何 MCP 时开局约 4 万 token（系统提示与内置工具） */
const CLAUDE_BASELINE_TOKENS = 40_000;
const MCP_MEASURE_CACHE_MS = 10 * 60_000;

export const PROVIDER_COMMANDS: Record<LocalAgentProvider, string> = {
  codex: "codex",
  claude: "claude",
  copilot: "copilot",
  opencode: "opencode",
  omp: "omp",
  openclaw: "openclaw",
  gemini: "gemini",
  agy: "agy",
};

type Runtime = {
  config: LocalAgentConfig;
  child?: ChildHandle | undefined;
  pid: number | null;
  startedAt: number | null;
  lastExitCode: number | null;
  lastError: string | null;
  restarts: number;
  /** 近期意外退出的时间戳 */
  failures: number[];
  consecutiveFailures: number;
  phase: "running" | "restarting" | "stopped" | "crashed";
  /** 主动停止中：退出不算失败 */
  stopping: boolean;
  timer?: { cancel(): void } | undefined;
  logs: string[];
  pendingLine: string;
  exited?: Promise<void> | undefined;
  /** 当前进程启动时带了设置文件：之后的勾选改动下一轮就生效；否则要重启一次 */
  settingsApplied: boolean;
  /** 正在重启（等旧进程退出）：这期间不接受设置改动，免得新进程用上没批准过的配置 */
  transitioning?: boolean;
  /** 人点了「重启」但它正忙：等手上的调用都结束再重启；guard 是批准单绑定的配置核对 */
  pendingRestart?: { guard?: ((agent: LocalAgent) => boolean) | undefined } | undefined;
  /** 上次自动更新重启时的目标版本：同一个目标只自动重启一次，重启后仍判为旧就不再重试 */
  autoRestartedFor?: string | undefined;
  lastAutoRestartAt?: number | undefined;
};

/** 用来判断「同一个目标版本」的键 */
function versionKey(version: AgentCodeVersion): string {
  return version.fingerprint ?? version.package;
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** 持续读取日志文件新增的内容（从 offset 开始），返回停止函数 */
function tailFile(file: string, offset: number, listener: (chunk: string) => void): () => void {
  let position = offset;
  const buffer = Buffer.alloc(64 * 1024);
  const read = () => {
    let fd: number | undefined;
    try {
      if (statSync(file).size < position) position = 0;
      fd = openSync(file, "r");
      for (;;) {
        const bytes = readSync(fd, buffer, 0, buffer.length, position);
        if (bytes <= 0) break;
        position += bytes;
        listener(buffer.subarray(0, bytes).toString("utf8"));
      }
    } catch {
      /* 文件还没建好或已被轮转，下次再读 */
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  const timer = setInterval(read, TAIL_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    read();
  };
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

export const defaultSpawnAgent: SpawnAgent = (command, args, options) => {
  const logFile = options.logFile;
  let fd: number | undefined;
  if (logFile) {
    if (fileSize(logFile) > LOG_FILE_MAX_BYTES) {
      try {
        renameSync(logFile, `${logFile}.1`);
      } catch {
        // Windows 上旧进程还开着这个文件时不能改名：本次接着追加，下次再轮转
      }
    }
    fd = openSync(logFile, "a");
  }
  const offset = logFile ? fileSize(logFile) : 0;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    // 写日志文件的 Agent 自成进程组：Server（及 dev 结束 Server 进程组）退出时不会把它一起带走
    stdio: fd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", fd, fd],
    // Windows 上不 detached 的子进程会被放进「父进程退出即全部结束」的作业对象，交接重启时会被一起结束
    detached: fd !== undefined,
    windowsHide: true,
  });
  if (fd !== undefined) closeSync(fd);
  const exitListeners: Array<(code: number | null, error?: Error) => void> = [];
  const outputListeners: Array<(chunk: string) => void> = [];
  let exited = false;
  let released = false;
  let stopTail: (() => void) | undefined;
  const emitExit = (code: number | null, error?: Error) => {
    if (exited || released) return;
    exited = true;
    stopTail?.();
    for (const listener of exitListeners) listener(code, error);
  };
  child.on("error", (error) => emitExit(null, error));
  child.on("close", (code) => emitExit(code));
  if (logFile) {
    child.unref();
    stopTail = tailFile(logFile, offset, (chunk) => {
      for (const listener of outputListeners) listener(chunk);
    });
  }
  return {
    pid: child.pid,
    onOutput(listener) {
      if (logFile) outputListeners.push(listener);
      else {
        child.stdout?.setEncoding("utf8").on("data", listener);
        child.stderr?.setEncoding("utf8").on("data", listener);
      }
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    kill(signal) {
      if (exited) return;
      if (child.pid && process.platform === "win32") killTree(child.pid);
      else child.kill(signal);
    },
    release() {
      released = true;
      stopTail?.();
      child.removeAllListeners();
    },
  };
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 按 pid 接管：进程还在，并且命令行确实是这个名字的 `hive join`（防止 pid 被别的进程复用），
 * 之后靠轮询发现它退出、靠信号结束它，输出从日志文件末尾接着读。
 */
export const defaultAdoptAgent: AdoptAgent = (pid, options) => {
  if (!isAlive(pid)) return undefined;
  const commandLine = processCommandLine(pid);
  if (!commandLine) return undefined;
  const args = commandLine.trim().split(/\s+/);
  const nameAt = args.indexOf("--name");
  if (!args.includes("join") || nameAt < 0 || args[nameAt + 1] !== options.name) return undefined;
  const exitListeners: Array<(code: number | null, error?: Error) => void> = [];
  const outputListeners: Array<(chunk: string) => void> = [];
  let exited = false;
  const stopTail = options.logFile
    ? tailFile(options.logFile, fileSize(options.logFile), (chunk) => {
        for (const listener of outputListeners) listener(chunk);
      })
    : undefined;
  const poll = setInterval(() => {
    if (isAlive(pid)) return;
    clearInterval(poll);
    if (exited) return;
    exited = true;
    stopTail?.();
    for (const listener of exitListeners) listener(null);
  }, 1_000);
  poll.unref();
  return {
    pid,
    onOutput(listener) {
      outputListeners.push(listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    kill(signal) {
      if (exited) return;
      if (process.platform === "win32") {
        killTree(pid);
        return;
      }
      try {
        process.kill(pid, signal);
      } catch {
        /* 已经退出 */
      }
    },
    release() {
      exited = true;
      clearInterval(poll);
      stopTail?.();
    },
  };
};

export const defaultProbe: ProviderProbe = (command) =>
  new Promise((resolve) => {
    let probe;
    try {
      probe = commandFor(command, ["--version"]);
    } catch {
      resolve({ installed: true, version: null });
      return;
    }
    execFile(
      probe.command,
      probe.args,
      { timeout: 5_000, encoding: "utf8", windowsHide: true },
      (error, stdout) => {
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
          resolve({ installed: false, version: null });
          return;
        }
        const version = stdout.trim().split("\n")[0]?.trim() || null;
        resolve({ installed: true, version: error ? null : version });
      },
    );
  });

/** 「人发的消息在它忙时自动引导」开关：按 Agent 名字存（各房间通用） */
export function autoSteerKey(name: string): string {
  return `auto-steer:${name.toLocaleLowerCase()}`;
}

export class LocalAgentSupervisor {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly spawnAgent: SpawnAgent;
  private readonly adoptAgent: AdoptAgent;
  private readonly probe: ProviderProbe;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<LocalAgentSupervisorOptions["setTimer"]>;
  private readonly log: (message: string) => void;
  private probeCache?: { at: number; result: Promise<LocalProviderInfo[]> };
  private readonly measureCache = new Map<string, { at: number; result: LocalAgentMcpResponse }>();
  private readonly listMcp: McpLister;
  private readonly listModels: ModelLister;
  private readonly modelsCache = new Map<
    LocalAgentProvider,
    { at: number; result: Promise<LocalAgentModelsResponse> }
  >();
  private shuttingDown = false;
  private current?: { at: number; version: AgentCodeVersion | undefined };
  private refreshing?: Promise<AgentCodeVersion | undefined> | undefined;
  private readonly currentVersion: () => Promise<AgentCodeVersion | undefined>;
  private updateTimer?: { cancel(): void } | undefined;
  private idleTimer?: { cancel(): void } | undefined;
  private checking = false;

  constructor(private readonly options: LocalAgentSupervisorOptions) {
    this.spawnAgent = options.spawn ?? defaultSpawnAgent;
    this.adoptAgent = options.adopt ?? defaultAdoptAgent;
    this.probe = options.probe ?? defaultProbe;
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimer ??
      ((callback, ms) => {
        const timer = setTimeout(callback, ms);
        timer.unref();
        return { cancel: () => clearTimeout(timer) };
      });
    this.log = options.log ?? (() => undefined);
    const packageRoot = packageRootOfCli(options.cli.args);
    this.currentVersion =
      options.currentVersion ??
      (() => (packageRoot ? codeVersionAt(packageRoot) : Promise.resolve(undefined)));
    this.listMcp =
      options.listMcp ??
      ((args) =>
        new Promise((resolve, reject) =>
          execFile(
            options.cli.command,
            [...options.cli.args, ...args],
            { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 },
            (error, stdout) => (error ? reject(error) : resolve(stdout)),
          ),
        ));
    this.listModels =
      options.listModels ??
      (async (provider) => {
        const stdout = await this.listMcp(["models", "--provider", provider, "--json"]);
        const line = stdout.trim().split("\n").at(-1) ?? "";
        const parsed = JSON.parse(line) as LocalAgentModelsResponse;
        return {
          source: parsed.source === "runtime" ? "runtime" : "preset",
          models: Array.isArray(parsed.models) ? parsed.models : [],
          ...(parsed.error ? { error: parsed.error } : {}),
        };
      });
  }

  /**
   * 服务启动时恢复上次保存的本机 Agent；手动停止过的保持停止。
   * 上一个 Server 交接时留下的进程还在跑的，直接接管（它手上的任务不中断），不再另起一个；
   * 需要重新拉起的按顺序错开 RESTORE_STAGGER_MS 逐个启动，排队期间显示「启动中」。
   */
  start(): void {
    let queued = 0;
    for (const config of this.options.database.listLocalAgents()) {
      const runtime = this.track(config);
      const previous = config.pid
        ? this.adoptAgent(config.pid, {
            name: config.name,
            ...(this.logFile(config) ? { logFile: this.logFile(config)! } : {}),
          })
        : undefined;
      if (previous && config.autostart) {
        this.appendLog(runtime, `[hive] 接管仍在运行的 ${config.name}（pid ${previous.pid}）\n`);
        this.attach(
          runtime,
          previous,
          config.pidStartedAt ? Date.parse(config.pidStartedAt) : this.now(),
        );
        runtime.settingsApplied = processHasArgument(previous.pid, "--agent-settings");
        continue;
      }
      // 不该再运行的（已手动停止）结束掉；已经不在的清掉记录
      previous?.kill("SIGTERM");
      if (config.pid) this.options.database.setLocalAgentProcess(config.id, null, null);
      if (!config.autostart) continue;
      const delay = queued * RESTORE_STAGGER_MS;
      queued += 1;
      if (delay === 0) {
        this.launch(runtime);
        continue;
      }
      this.appendLog(runtime, `[hive] 恢复上次在运行的 Agent，${delay / 1000} 秒后启动\n`);
      // 停止、启动、重启、删除都会先取消这个定时器
      runtime.timer = this.setTimer(() => {
        runtime.timer = undefined;
        if (runtime.phase === "running") this.launch(runtime);
      }, delay);
    }
    // 能拿到 Agent 上报的版本才做自动更新
    if (this.options.runningVersion) {
      void this.refreshVersion();
      this.scheduleUpdateCheck();
    }
  }

  /**
   * 交接给下一个 Server（开发时代码更新、Server 换代）：不结束 Agent 进程，只停止跟踪。
   * 进程号已经落库，新 Server 启动时接管；Agent 断线期间会自行重连，正在跑的任务继续做完。
   */
  detach(): void {
    this.shuttingDown = true;
    this.cancelUpdateTimers();
    for (const runtime of this.runtimes.values()) {
      runtime.timer?.cancel();
      runtime.timer = undefined;
      runtime.child?.release?.();
    }
  }

  /** 所有 provider 都有设置文件：模型每一轮从这里读；MCP 勾选只有 claude、codex 用得上 */
  private settingsFile(config: LocalAgentConfig): string | undefined {
    return this.options.settingsDir
      ? path.join(this.options.settingsDir, `${config.id}.json`)
      : undefined;
  }

  private writeSettings(config: LocalAgentConfig): string | undefined {
    const file = this.settingsFile(config);
    if (!file) return undefined;
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({
        mcpDisabled: config.mcpDisabled ?? [],
        ...(config.model ? { model: config.model } : {}),
      }),
      { mode: 0o600 },
    );
    // 先写临时文件再改名：Agent 随时可能在读，不能读到写了一半的内容
    renameSync(tmp, file);
    return file;
  }

  /** 保存网页上的勾选；已带设置文件启动的 Agent 下一轮就按新的勾选加载 */
  updateSettings(
    id: string,
    settings: {
      mcpDisabled?: string[] | undefined;
      autoSteer?: boolean | undefined;
      model?: string | null | undefined;
    },
  ): LocalAgent {
    const runtime = this.require(id);
    // 模型写进设置文件，Agent 下一轮就按新模型跑，不用重启
    if (settings.model !== undefined) {
      runtime.config.model = this.options.database.setLocalAgentModel(
        id,
        settings.model?.trim() || null,
      );
      this.writeSettings(runtime.config);
    }
    // 自动引导由服务端在派发时判断，不影响进程，随时可改
    if (settings.autoSteer !== undefined) {
      this.options.database.setSetting(
        autoSteerKey(runtime.config.name),
        settings.autoSteer ? "1" : "0",
      );
    }
    if (settings.mcpDisabled === undefined) return this.view(runtime);
    if (runtime.transitioning) {
      throw new HiveError("LOCAL_AGENT_BUSY", serverText("error.localAgent.restartingSettings"));
    }
    if (!MCP_SELECTABLE.has(runtime.config.provider)) {
      throw new HiveError(
        "LOCAL_AGENT_MCP_UNSUPPORTED",
        serverText("error.localAgent.mcpUnsupported"),
      );
    }
    runtime.config.mcpDisabled = this.options.database.setLocalAgentMcpDisabled(
      id,
      settings.mcpDisabled,
    );
    this.writeSettings(runtime.config);
    return this.view(runtime);
  }

  /**
   * 这个 Agent 的运行时能用的模型（按 provider 缓存 10 分钟，refresh 时重新拉）。
   * 拉不到不报错：返回空列表和原因，网页上照样可以手填。
   */
  async models(id: string, refresh = false): Promise<LocalAgentModelsResponse> {
    const { provider } = this.require(id).config;
    const cached = this.modelsCache.get(provider);
    if (cached && !refresh && this.now() - cached.at < MODELS_CACHE_MS) return cached.result;
    const result = this.listModels(provider).catch((error: unknown): LocalAgentModelsResponse => ({
      source: "preset",
      models: [],
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    }));
    this.modelsCache.set(provider, { at: this.now(), result });
    // 拉取失败的不缓存：下次打开再试
    void result.then((value) => {
      if (value.error && this.modelsCache.get(provider)?.result === result) {
        this.modelsCache.delete(provider);
      }
    });
    return result;
  }

  /** 这个 Agent 会加载的本机 MCP 及启用状态；measure 时逐个连上估算开局 token（结果缓存 10 分钟） */
  async mcpServers(id: string, measure: boolean): Promise<LocalAgentMcpResponse> {
    const { config } = this.require(id);
    return this.listMcpFor(id, config.provider, config.cwd, this.writeSettings(config), measure);
  }

  /** 接入新 Agent 前预览：这个 provider 在该目录下会加载哪些本机 MCP（默认全部启用） */
  mcpCandidates(
    provider: LocalAgentProvider,
    cwd: string | undefined,
    measure: boolean,
  ): Promise<LocalAgentMcpResponse> {
    const resolved = cwd ? resolveWorkspace(cwd) : null;
    return this.listMcpFor(
      `new:${provider}:${resolved ?? ""}`,
      provider,
      resolved,
      undefined,
      measure,
    );
  }

  private async listMcpFor(
    cacheKey: string,
    provider: LocalAgentProvider,
    cwd: string | null,
    settingsFile: string | undefined,
    measure: boolean,
  ): Promise<LocalAgentMcpResponse> {
    if (!MCP_SELECTABLE.has(provider)) {
      return { supported: false, servers: [], baselineTokens: null };
    }
    const cachedEntry = this.measureCache.get(cacheKey);
    const cached =
      cachedEntry && this.now() - cachedEntry.at < MCP_MEASURE_CACHE_MS
        ? cachedEntry.result
        : undefined;
    const stdout = await this.listMcp([
      "mcp",
      "list",
      "--provider",
      provider,
      "--cwd",
      cwd ?? homedir(),
      ...(settingsFile ? ["--agent-settings", settingsFile] : []),
      "--json",
      ...(measure && provider === "claude" ? ["--measure"] : []),
    ]);
    const line = stdout.trim().split("\n").at(-1) ?? "";
    let servers: LocalAgentMcpResponse["servers"];
    try {
      servers = (JSON.parse(line) as { servers: LocalAgentMcpResponse["servers"] }).servers;
    } catch {
      throw new HiveError(
        "LOCAL_AGENT_MCP_LIST_FAILED",
        serverText("error.localAgent.mcpListFailed"),
      );
    }
    // 没要求重新估算时沿用 10 分钟内的估算结果，启用状态以刚读到的为准
    if (!measure && cached) {
      const measured = new Map(cached.servers.map((server) => [server.name, server.measurement]));
      servers = servers.map((server) => {
        const measurement = measured.get(server.name);
        return measurement ? { ...server, measurement } : server;
      });
    }
    const result: LocalAgentMcpResponse = {
      supported: true,
      servers,
      baselineTokens: provider === "claude" ? CLAUDE_BASELINE_TOKENS : null,
    };
    if (measure) this.measureCache.set(cacheKey, { at: this.now(), result });
    return result;
  }

  private logFile(config: LocalAgentConfig): string | undefined {
    return this.options.logDir ? path.join(this.options.logDir, `${config.id}.log`) : undefined;
  }

  list(): LocalAgent[] {
    this.currentCodeVersion();
    const busy = this.busyNames();
    return [...this.runtimes.values()].map((runtime) => this.view(runtime, busy));
  }

  get(id: string): LocalAgent {
    return this.view(this.require(id));
  }

  logs(id: string): string[] {
    const runtime = this.require(id);
    return runtime.pendingLine ? [...runtime.logs, runtime.pendingLine] : [...runtime.logs];
  }

  providers(): Promise<LocalProviderInfo[]> {
    const cached = this.probeCache;
    if (cached && this.now() - cached.at < PROBE_CACHE_MS) return cached.result;
    const result = Promise.all(
      (Object.keys(PROVIDER_COMMANDS) as LocalAgentProvider[]).map(async (provider) => {
        const command = PROVIDER_COMMANDS[provider];
        const { installed, version } = await slowOps.track(
          `localAgents.probe ${provider}`,
          {},
          () => this.probe(command),
        );
        return { provider, command, installed, version };
      }),
    );
    this.probeCache = { at: this.now(), result };
    return result;
  }

  create(request: CreateLocalAgentRequest): LocalAgent {
    const name = request.name.trim();
    if (this.options.isNameInUse(name)) {
      throw new HiveError(
        "LOCAL_AGENT_NAME_TAKEN",
        serverText("error.localAgent.nameInUse", { name }),
      );
    }
    // 与 `hive join` 一致：可写的档位必须明确工作目录，避免授权到错误目录
    const cwd = request.access === "read-only" ? null : resolveWorkspace(request.cwd);
    const config = this.options.database.createLocalAgent({
      provider: request.provider,
      name,
      access: request.access,
      cwd,
      model: request.model ?? null,
      ...(request.mcpDisabled && MCP_SELECTABLE.has(request.provider)
        ? { mcpDisabled: [...new Set(request.mcpDisabled)].sort() }
        : {}),
    });
    const runtime = this.track(config);
    this.launch(runtime);
    return this.view(runtime);
  }

  startAgent(id: string): LocalAgent {
    const runtime = this.require(id);
    if (!runtime.child) {
      runtime.timer?.cancel();
      runtime.failures = [];
      runtime.consecutiveFailures = 0;
      this.options.database.setLocalAgentAutostart(id, true);
      this.launch(runtime);
    }
    return this.view(runtime);
  }

  async stop(id: string): Promise<LocalAgent> {
    const runtime = this.require(id);
    runtime.pendingRestart = undefined;
    this.options.database.setLocalAgentAutostart(id, false);
    await this.terminate(runtime);
    runtime.phase = "stopped";
    return this.view(runtime);
  }

  /**
   * 重启。guard 在真正启动前对最终配置再核对一次（例如批准单绑定的配置），不通过就不启动；
   * 等旧进程退出期间拒绝设置改动，保证核对过的就是要启动的。
   */
  async restart(id: string, guard?: (agent: LocalAgent) => boolean): Promise<LocalAgent> {
    const runtime = this.require(id);
    if (runtime.transitioning) {
      throw new HiveError("LOCAL_AGENT_BUSY", serverText("error.localAgent.restarting"));
    }
    runtime.pendingRestart = undefined;
    runtime.transitioning = true;
    try {
      await this.terminate(runtime);
      if (guard && !guard(this.view(runtime))) {
        runtime.phase = "stopped";
        throw new HiveError(
          "LOCAL_AGENT_CONFIG_CHANGED",
          serverText("error.localAgent.configChanged"),
        );
      }
      runtime.failures = [];
      runtime.consecutiveFailures = 0;
      this.options.database.setLocalAgentAutostart(id, true);
      this.launch(runtime);
    } finally {
      runtime.transitioning = false;
    }
    return this.view(runtime);
  }

  /**
   * 空闲后重启（「重启」按钮的默认做法）：手上没有排队或执行中的调用就马上重启；
   * 正忙就先记下，等调用都结束后由 checkUpdates 重启，正在做的任务不会被打断。
   */
  async restartWhenIdle(id: string, guard?: (agent: LocalAgent) => boolean): Promise<LocalAgent> {
    const runtime = this.require(id);
    if (runtime.child && this.isBusy(runtime)) {
      if (runtime.transitioning) {
        throw new HiveError("LOCAL_AGENT_BUSY", serverText("error.localAgent.restarting"));
      }
      runtime.pendingRestart = { guard };
      this.appendLog(runtime, "[hive] 手上还有任务，做完后重启\n");
      return this.view(runtime);
    }
    return this.restart(id, guard);
  }

  /** 自动更新开关：本机 Agent 落后于当前代码时，在空闲后自动重启（默认开） */
  autoUpdateEnabled(): boolean {
    return this.options.database.getSetting(AUTO_UPDATE_SETTING) !== "0";
  }

  setAutoUpdate(enabled: boolean): void {
    this.options.database.setSetting(AUTO_UPDATE_SETTING, enabled ? "1" : "0");
    if (enabled) this.checkSoon();
  }

  /** 最近算出的当前代码版本（过期了在后台重算，这次先用旧值）；判断不出时为 undefined */
  currentCodeVersion(): AgentCodeVersion | undefined {
    if (!this.current || this.now() - this.current.at >= VERSION_CACHE_MS) {
      void this.refreshVersion();
    }
    return this.current?.version;
  }

  private refreshVersion(): Promise<AgentCodeVersion | undefined> {
    if (this.current && this.now() - this.current.at < VERSION_CACHE_MS) {
      return Promise.resolve(this.current.version);
    }
    this.refreshing ??= this.currentVersion()
      .catch(() => undefined)
      .then((version) => {
        const changed =
          this.current !== undefined &&
          (this.current.version ? versionKey(this.current.version) : undefined) !==
            (version ? versionKey(version) : undefined);
        this.current = { at: this.now(), version };
        this.refreshing = undefined;
        if (changed) this.options.onCurrentVersionChange?.();
        return version;
      });
    return this.refreshing;
  }

  /** 有 Agent 可能刚变空闲（调用结束、忙碌状态解除）：稍等片刻再检查要不要重启 */
  checkSoon(): void {
    if (this.shuttingDown || this.idleTimer) return;
    if (
      !this.options.runningVersion &&
      ![...this.runtimes.values()].some((r) => r.pendingRestart)
    ) {
      return;
    }
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = undefined;
      void this.checkUpdates();
    }, IDLE_CHECK_DELAY_MS);
  }

  private scheduleUpdateCheck(): void {
    this.updateTimer?.cancel();
    this.updateTimer = this.setTimer(() => {
      this.updateTimer = undefined;
      void this.checkUpdates().finally(() => {
        if (!this.shuttingDown) this.scheduleUpdateCheck();
      });
    }, this.options.updateCheckMs ?? UPDATE_CHECK_MS);
  }

  private cancelUpdateTimers(): void {
    this.updateTimer?.cancel();
    this.updateTimer = undefined;
    this.idleTimer?.cancel();
    this.idleTimer = undefined;
  }

  /**
   * 该重启的空闲 Agent 现在重启：人点过「重启」而当时正忙的；以及（自动更新开着时）落后于当前代码的。
   * 忙的跳过，下次检查再看。自动更新每次只重启一个（重启完再接着查下一个，免得一下子起一堆进程），
   * 同一个目标版本只自动重启一次，同一个 Agent 两次自动重启至少隔 AUTO_RESTART_COOLDOWN_MS。
   */
  async checkUpdates(): Promise<void> {
    if (this.shuttingDown || this.checking) return;
    this.checking = true;
    try {
      const current = this.options.runningVersion ? await this.refreshVersion() : undefined;
      if (this.shuttingDown) return;
      const autoUpdate = current !== undefined && this.autoUpdateEnabled();
      // 忙闲在决定重启的同一刻读：从这里到发出结束信号之间不让出事件循环，不会有新调用插进来
      const busy = this.busyNames();
      let updating = false;
      for (const runtime of this.runtimes.values()) {
        if (!runtime.child || runtime.transitioning) continue;
        const manual = runtime.pendingRestart;
        const update = !manual && autoUpdate && !updating && this.updateDue(runtime, current!);
        if (!manual && !update) continue;
        if (busy.has(runtime.config.name.toLocaleLowerCase())) continue;
        if (update) {
          updating = true;
          runtime.autoRestartedFor = versionKey(current!);
          runtime.lastAutoRestartAt = this.now();
          this.appendLog(runtime, "[hive] 代码已更新，Agent 空闲，自动重启以用上新代码\n");
          this.log(`[local-agents] ${runtime.config.name} 运行的是旧代码，空闲后自动重启`);
        } else {
          this.appendLog(runtime, "[hive] 手上的任务做完了，按之前的要求重启\n");
        }
        void this.restart(runtime.config.id, manual?.guard)
          .catch((error: unknown) => {
            this.appendLog(
              runtime,
              `[hive] 重启没有完成：${error instanceof Error ? error.message : String(error)}\n`,
            );
          })
          .finally(() => {
            if (update) this.checkSoon();
          });
      }
    } finally {
      this.checking = false;
    }
  }

  private busyNames(): ReadonlySet<string> {
    return this.options.busyAgentNames?.() ?? new Set<string>();
  }

  private isBusy(runtime: Runtime, busy = this.busyNames()): boolean {
    return busy.has(runtime.config.name.toLocaleLowerCase());
  }

  /**
   * 在跑的进程落后于当前代码：上报的指纹或包版本旧，或者在线却没上报版本（还不会上报的旧版 Bridge）。
   * 还没上线、当前版本判断不出来时不算。
   */
  private outdated(runtime: Runtime): boolean {
    const current = this.current?.version;
    if (!runtime.child || !current || !this.options.runningVersion) return false;
    if (!this.options.isAgentOnline(runtime.config.name)) return false;
    const running = this.options.runningVersion(runtime.config.name);
    return running ? isAgentOutdated(running, current, true) : true;
  }

  /** 这个名字是本机 Agent 时，它是否在跑旧代码；不是本机 Agent 返回 undefined */
  outdatedByName(name: string): boolean | undefined {
    const key = name.toLocaleLowerCase();
    for (const runtime of this.runtimes.values()) {
      if (runtime.config.name.toLocaleLowerCase() === key) return this.outdated(runtime);
    }
    return undefined;
  }

  /** 落后、这个目标版本还没自动重启过、也过了冷却期 */
  private updateDue(runtime: Runtime, current: AgentCodeVersion): boolean {
    if (!this.outdated(runtime)) return false;
    if (runtime.autoRestartedFor === versionKey(current)) return false;
    return (
      runtime.lastAutoRestartAt === undefined ||
      this.now() - runtime.lastAutoRestartAt >= AUTO_RESTART_COOLDOWN_MS
    );
  }

  async remove(id: string): Promise<void> {
    const runtime = this.require(id);
    await this.terminate(runtime);
    this.runtimes.delete(id);
    this.options.database.deleteLocalAgent(id);
  }

  /** 服务关闭：先 SIGTERM 让 Agent 正常离线，宽限期后仍未退出再 SIGKILL */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.cancelUpdateTimers();
    await Promise.all([...this.runtimes.values()].map((runtime) => this.terminate(runtime)));
  }

  private require(id: string): Runtime {
    const runtime = this.runtimes.get(id);
    if (!runtime)
      throw new HiveError("LOCAL_AGENT_NOT_FOUND", serverText("error.localAgent.notFound"));
    return runtime;
  }

  private track(config: LocalAgentConfig): Runtime {
    const runtime: Runtime = {
      config,
      pid: null,
      startedAt: null,
      lastExitCode: null,
      lastError: null,
      restarts: 0,
      failures: [],
      consecutiveFailures: 0,
      phase: config.autostart ? "running" : "stopped",
      stopping: false,
      logs: [],
      pendingLine: "",
      settingsApplied: false,
    };
    this.runtimes.set(config.id, runtime);
    return runtime;
  }

  private view(runtime: Runtime, busy?: ReadonlySet<string>): LocalAgent {
    const { config } = runtime;
    const running = runtime.child ? this.options.runningVersion?.(config.name) : undefined;
    const outdated = this.outdated(runtime);
    const current = this.current?.version;
    let status: LocalAgentStatus;
    if (runtime.child) {
      status = this.options.isAgentOnline(config.name) ? "running" : "starting";
    } else {
      status = runtime.phase === "running" ? "starting" : runtime.phase;
    }
    return {
      id: config.id,
      provider: config.provider,
      name: config.name,
      access: config.access,
      cwd: config.cwd,
      model: config.model,
      status,
      pid: runtime.child ? runtime.pid : null,
      startedAt: runtime.startedAt ? new Date(runtime.startedAt).toISOString() : null,
      lastExitCode: runtime.lastExitCode,
      lastError: runtime.lastError,
      restarts: runtime.restarts,
      createdAt: config.createdAt,
      mcpDisabled: config.mcpDisabled ?? [],
      autoSteer: this.options.database.getSetting(autoSteerKey(config.name)) === "1",
      // 正在运行、但启动时没带设置文件（升级前就在跑的进程）：勾选、模型要重启一次才生效
      ...(runtime.child && !runtime.settingsApplied && this.settingsFile(config)
        ? { settingsPendingRestart: true }
        : {}),
      busy: runtime.child ? this.isBusy(runtime, busy) : false,
      ...(running ? { version: running } : {}),
      ...(outdated ? { outdated: true } : {}),
      // 点过「重启」在等它忙完，或自动更新会在它空闲后重启它
      ...(runtime.pendingRestart ||
      (outdated &&
        current &&
        this.autoUpdateEnabled() &&
        runtime.autoRestartedFor !== versionKey(current))
        ? { restartWhenIdle: true }
        : {}),
    };
  }

  private launch(runtime: Runtime): void {
    if (this.shuttingDown || runtime.child) return;
    const { config } = runtime;
    // 新进程跑的就是现在的代码：之前等着的重启不用再做了
    runtime.pendingRestart = undefined;
    const settingsFile = this.writeSettings(config);
    runtime.settingsApplied = settingsFile !== undefined;
    const args = [
      ...this.options.cli.args,
      "join",
      "--server",
      this.options.serverUrl,
      "--name",
      config.name,
      "--provider",
      config.provider,
      "--access",
      config.access,
      ...(config.cwd ? ["--cwd", config.cwd] : []),
      // 有设置文件时模型只从设置文件读（每一轮生效），不再作为启动参数：改回默认才能真的回到默认
      ...(config.model && !settingsFile ? ["--model", config.model] : []),
      ...(settingsFile ? ["--agent-settings", settingsFile] : []),
      // 本机拉起的 Agent 是房主自己的：房主在网页上给房间设的工作区直接跟随，不用再手动 --allow-root
      "--trust-room-workspace",
    ];
    runtime.phase = "running";
    runtime.stopping = false;
    runtime.startedAt = this.now();
    this.appendLog(
      runtime,
      `[hive] 启动 ${config.name}（${config.provider} · ${config.access}）\n`,
    );
    const logFile = this.logFile(config);
    if (logFile) mkdirSync(path.dirname(logFile), { recursive: true });
    const child = this.spawnAgent(this.options.cli.command, args, {
      cwd: homedir(),
      env: {
        // token 走环境变量：命令行参数会被同机其他用户通过 ps 看到
        HIVE_AGENT_TOKEN: this.options.joinToken,
        // 让子进程在 Hive Server 消失（包括被 kill -9）且一段时间内没有回来时自行退出，不留孤儿
        HIVE_SUPERVISOR_PID: String(process.pid),
      },
      ...(logFile ? { logFile } : {}),
    });
    this.attach(runtime, child, runtime.startedAt);
  }

  private attach(runtime: Runtime, child: ChildHandle, startedAt: number): void {
    runtime.phase = "running";
    runtime.stopping = false;
    runtime.startedAt = startedAt;
    runtime.child = child;
    runtime.pid = child.pid ?? null;
    if (child.pid) {
      this.options.database.setLocalAgentProcess(
        runtime.config.id,
        child.pid,
        new Date(startedAt).toISOString(),
      );
    }
    let resolveExited!: () => void;
    runtime.exited = new Promise((resolve) => (resolveExited = resolve));
    child.onOutput((chunk) => this.appendLog(runtime, chunk));
    child.onExit((code, error) => {
      if (runtime.child === child) runtime.child = undefined;
      runtime.lastExitCode = code;
      if (!this.shuttingDown || runtime.stopping) {
        this.options.database.setLocalAgentProcess(runtime.config.id, null, null);
      }
      if (error) this.appendLog(runtime, `[hive] 无法启动：${error.message}\n`);
      resolveExited();
      this.handleExit(runtime, code, error);
    });
  }

  private handleExit(runtime: Runtime, code: number | null, error?: Error): void {
    if (runtime.stopping || this.shuttingDown) return;
    const now = this.now();
    const ranFor = runtime.startedAt ? now - runtime.startedAt : 0;
    if (ranFor >= STABLE_RUN_MS) runtime.consecutiveFailures = 0;
    runtime.consecutiveFailures += 1;
    runtime.failures = [...runtime.failures.filter((at) => now - at < CRASH_WINDOW_MS), now];
    runtime.lastError =
      error?.message ?? (this.tail(runtime, 5) || `进程退出，退出码 ${code ?? "未知"}`);
    if (runtime.failures.length >= CRASH_LIMIT) {
      runtime.phase = "crashed";
      this.log(`[local-agents] ${runtime.config.name} 连续崩溃，已停止自动重启`);
      this.appendLog(runtime, `[hive] 10 分钟内退出 ${CRASH_LIMIT} 次，已停止自动重启。\n`);
      return;
    }
    const delay = Math.min(BACKOFF_MAX_MS, 1_000 * 2 ** (runtime.consecutiveFailures - 1));
    runtime.phase = "restarting";
    this.appendLog(runtime, `[hive] 进程意外退出，${Math.round(delay / 1000)} 秒后重启。\n`);
    runtime.timer = this.setTimer(() => {
      runtime.timer = undefined;
      if (runtime.phase !== "restarting") return;
      runtime.restarts += 1;
      this.launch(runtime);
    }, delay);
  }

  private async terminate(runtime: Runtime): Promise<void> {
    runtime.timer?.cancel();
    runtime.timer = undefined;
    const child = runtime.child;
    if (!child) return;
    runtime.stopping = true;
    // Windows 上「信号」都是强制结束，Agent 来不及下线：先经连接请它自己退出，宽限期过了再结束进程树
    const asked =
      process.platform === "win32" &&
      (this.options.requestShutdown?.(runtime.config.name) ?? false);
    if (!asked) child.kill("SIGTERM");
    let forced: { cancel(): void } | undefined;
    await Promise.race([
      runtime.exited,
      new Promise<void>((resolve) => {
        forced = this.setTimer(() => {
          child.kill("SIGKILL");
          resolve();
        }, STOP_GRACE_MS);
      }),
    ]);
    forced?.cancel();
    if (runtime.child === child) runtime.child = undefined;
  }

  private appendLog(runtime: Runtime, chunk: string): void {
    const text = runtime.pendingLine + chunk.replace(ANSI_PATTERN, "").replace(/\r/g, "");
    const lines = text.split("\n");
    runtime.pendingLine = lines.pop() ?? "";
    runtime.logs.push(...lines);
    if (runtime.logs.length > LOG_LINES) runtime.logs.splice(0, runtime.logs.length - LOG_LINES);
  }

  private tail(runtime: Runtime, count: number): string {
    return runtime.logs
      .filter((line) => line.trim() && !line.startsWith("[hive] 启动"))
      .slice(-count)
      .join("\n")
      .slice(-1_000);
  }
}

/** workspace / full 的目录必须真实存在且是绝对路径；取 realpath 存储，拒绝文件系统根目录 */
/** 进程的命令行里是否带某个参数（读不到时按没有处理） */
function processHasArgument(pid: number | undefined, argument: string): boolean {
  return pid ? (processCommandLine(pid)?.includes(argument) ?? false) : false;
}

/** 读进程的完整命令行：macOS / Linux 用 ps，Windows 用 PowerShell 查 Win32_Process；读不到返回 undefined */
function processCommandLine(pid: number): string | undefined {
  try {
    if (process.platform === "win32") {
      return (
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}").CommandLine`,
          ],
          { encoding: "utf8", timeout: 10_000, windowsHide: true },
        ).trim() || undefined
      );
    }
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
    });
  } catch {
    return undefined;
  }
}

/**
 * Windows 上结束整棵进程树：信号在 Windows 上一律是强制结束，而且只结束 Agent 自己，
 * 它起的 claude / codex 与工具命令会留下来。taskkill /T 连同子进程一起结束。
 */
function killTree(pid: number): void {
  execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {
    /* 已经退出时 taskkill 报错，忽略 */
  });
}

export function resolveWorkspace(input: string | undefined): string {
  if (!input?.trim())
    throw new HiveError("LOCAL_AGENT_CWD_REQUIRED", serverText("error.localAgent.cwdRequired"));
  const cwd = expandHome(input);
  if (!path.isAbsolute(cwd)) {
    throw new HiveError("LOCAL_AGENT_CWD_INVALID", serverText("error.localAgent.cwdAbsolute"));
  }
  let resolved: string;
  try {
    resolved = realpathSync(cwd);
  } catch {
    throw new HiveError(
      "LOCAL_AGENT_CWD_INVALID",
      serverText("error.localAgent.cwdMissing", { path: cwd }),
    );
  }
  if (!statSync(resolved).isDirectory()) {
    throw new HiveError(
      "LOCAL_AGENT_CWD_INVALID",
      serverText("error.localAgent.cwdNotDirectory", { path: cwd }),
    );
  }
  if (path.parse(resolved).root === resolved) {
    throw new HiveError("LOCAL_AGENT_CWD_INVALID", serverText("error.localAgent.cwdRoot"));
  }
  return resolved;
}
