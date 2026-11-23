import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  TerminalAttachResult,
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalSessionInfo,
} from "./ipc-contract.js";

/** node-pty 里用到的那一小部分，方便测试时替换 */
export type PtyProcess = {
  pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
};

export type PtySpawn = (
  file: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  },
) => PtyProcess;

export type TerminalSink = {
  data(ownerId: number, id: string, data: string): void;
  exit(ownerId: number, id: string, exitCode: number, signal?: number): void;
};

export type ShellChoice = { file: string; args: string[] };

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** 一个窗口最多同时开这么多终端，防止页面出错时无限新建进程 */
export const MAX_TERMINALS_PER_OWNER = 12;
/** 单次写入上限：正常键入和粘贴远小于这个值 */
const MAX_WRITE_CHARS = 1_000_000;
/** 每个终端在主进程里留最近这么多字符的输出，页面刷新后重新接上时回放（约 5000 行） */
export const REPLAY_BUFFER_CHARS = 512 * 1024;
/** 页面刷新、渲染进程崩溃后等这么久；新页面没接回去的终端才结束 */
export const REATTACH_GRACE_MS = 60_000;

/** 默认 shell：macOS / Linux 用用户的登录 shell（-l），Windows 用 PowerShell */
export function defaultShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ShellChoice {
  if (platform === "win32") {
    const systemRoot = env.SystemRoot ?? env.windir ?? "C:\\Windows";
    return {
      file: path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: ["-NoLogo"],
    };
  }
  const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : undefined;
  const fallback = platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  return { file: shell ?? fallback, args: ["-l"] };
}

/** 把 ~ 展开、确认是存在的目录；不行就回到主目录 */
export function resolveCwd(requested: string | null | undefined, home = os.homedir()): string {
  if (typeof requested !== "string" || requested.trim() === "") return home;
  let value = requested.trim();
  if (value === "~") value = home;
  else if (value.startsWith("~/") || value.startsWith("~\\"))
    value = path.join(home, value.slice(2));
  if (!path.isAbsolute(value)) return home;
  try {
    if (existsSync(value) && statSync(value).isDirectory()) return value;
  } catch {
    /* 没权限之类：用主目录 */
  }
  return home;
}

function clampDimension(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(2, Math.floor(value)));
}

/** 终端环境变量：去掉 Electron 和 Hive 内部变量，补上终端相关的 */
export function terminalEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key.startsWith("ELECTRON_") || key.startsWith("HIVE_")) continue;
    env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "SuperHive";
  // 从访达 / Dock 启动的程序没有 LANG，zsh 里中文会显示成乱码
  if (process.platform !== "win32" && !env.LANG && !env.LC_ALL) env.LANG = "en_US.UTF-8";
  return env;
}

type Session = {
  id: string;
  ownerId: number;
  shell: string;
  cwd: string;
  pty: PtyProcess;
  disposers: Array<{ dispose(): void }>;
  /** 最近的输出，按块存；总长超过 REPLAY_BUFFER_CHARS 时从头丢 */
  replay: string[];
  replayChars: number;
  /** 页面刷新后还没被新页面接回去 */
  detached: boolean;
};

function appendReplay(session: Session, data: string, limit: number): void {
  session.replay.push(data);
  session.replayChars += data.length;
  while (session.replayChars > limit && session.replay.length > 1) {
    session.replayChars -= session.replay.shift()!.length;
  }
  if (session.replayChars > limit) {
    // 只剩一块还超长：截掉开头
    const only = session.replay[0]!;
    session.replay[0] = only.slice(only.length - limit);
    session.replayChars = limit;
  }
}

/**
 * 终端会话管理：每个会话归属于创建它的 webContents（ownerId），别的页面不能读写它。
 * 页面刷新（同一个 webContents，id 不变）时调用方 detachOwner：进程继续跑、输出照常留着，
 * 新页面 list + attach 接回去并回放最近的输出；宽限期内没接回去的才结束。
 * 窗口关闭时由调用方 disposeOwner / disposeAll 结束全部进程。
 */
export class TerminalManager {
  private readonly sessions = new Map<string, Session>();
  private readonly graceTimers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly options: {
      spawn: PtySpawn;
      sink: TerminalSink;
      env: () => NodeJS.ProcessEnv;
      shell?: () => ShellChoice;
      home?: () => string;
      replayChars?: number;
    },
  ) {}

  create(ownerId: number, request: TerminalCreateRequest): TerminalCreateResult {
    if (this.countFor(ownerId) >= MAX_TERMINALS_PER_OWNER) {
      throw new Error(`Too many terminals (max ${MAX_TERMINALS_PER_OWNER})`);
    }
    const shell = (this.options.shell ?? (() => defaultShell()))();
    const cwd = resolveCwd(request?.cwd, (this.options.home ?? os.homedir)());
    const id = randomUUID();
    const pty = this.options.spawn(shell.file, shell.args, {
      name: "xterm-256color",
      cols: clampDimension(request?.cols, DEFAULT_COLS, 1000),
      rows: clampDimension(request?.rows, DEFAULT_ROWS, 500),
      cwd,
      env: terminalEnv(this.options.env()),
    });
    const session: Session = {
      id,
      ownerId,
      shell: shell.file,
      cwd,
      pty,
      disposers: [],
      replay: [],
      replayChars: 0,
      detached: false,
    };
    const limit = this.options.replayChars ?? REPLAY_BUFFER_CHARS;
    session.disposers.push(
      pty.onData((data) => {
        appendReplay(session, data, limit);
        this.options.sink.data(ownerId, id, data);
      }),
    );
    session.disposers.push(
      pty.onExit(({ exitCode, signal }) => {
        this.forget(id);
        this.options.sink.exit(ownerId, id, exitCode, signal);
      }),
    );
    this.sessions.set(id, session);
    return { id, shell: shell.file, cwd };
  }

  write(ownerId: number, id: unknown, data: unknown): void {
    const session = this.owned(ownerId, id);
    if (!session || typeof data !== "string" || data.length > MAX_WRITE_CHARS) return;
    session.pty.write(data);
  }

  resize(ownerId: number, id: unknown, cols: unknown, rows: unknown): void {
    const session = this.owned(ownerId, id);
    if (!session) return;
    try {
      session.pty.resize(
        clampDimension(cols, DEFAULT_COLS, 1000),
        clampDimension(rows, DEFAULT_ROWS, 500),
      );
    } catch {
      /* 进程刚好退出 */
    }
  }

  /** 这个页面（webContents）名下还在跑的终端，按创建顺序 */
  list(ownerId: number): TerminalSessionInfo[] {
    const result: TerminalSessionInfo[] = [];
    for (const session of this.sessions.values()) {
      if (session.ownerId === ownerId)
        result.push({ id: session.id, shell: session.shell, cwd: session.cwd });
    }
    return result;
  }

  /** 刷新后的新页面接回一个终端：拿到最近的输出用来回放，之后的输出照常推送 */
  attach(ownerId: number, id: unknown): TerminalAttachResult | undefined {
    const session = this.owned(ownerId, id);
    if (!session) return undefined;
    session.detached = false;
    return {
      id: session.id,
      shell: session.shell,
      cwd: session.cwd,
      replay: session.replay.join(""),
    };
  }

  /**
   * 页面要刷新或渲染进程崩了：终端先留着，等 graceMs；到时还没被 attach 的才结束。
   * 再次调用会重新计时（连续刷新）。
   */
  detachOwner(ownerId: number, graceMs = REATTACH_GRACE_MS): void {
    let any = false;
    for (const session of this.sessions.values()) {
      if (session.ownerId !== ownerId) continue;
      session.detached = true;
      any = true;
    }
    this.clearGrace(ownerId);
    if (!any) return;
    const timer = setTimeout(() => {
      this.graceTimers.delete(ownerId);
      for (const session of [...this.sessions.values()]) {
        if (session.ownerId === ownerId && session.detached) this.terminate(session);
      }
    }, graceMs);
    timer.unref?.();
    this.graceTimers.set(ownerId, timer);
  }

  kill(ownerId: number, id: unknown): void {
    const session = this.owned(ownerId, id);
    if (session) this.terminate(session);
  }

  disposeOwner(ownerId: number): void {
    this.clearGrace(ownerId);
    for (const session of [...this.sessions.values()]) {
      if (session.ownerId === ownerId) this.terminate(session);
    }
  }

  disposeAll(): void {
    for (const ownerId of [...this.graceTimers.keys()]) this.clearGrace(ownerId);
    for (const session of [...this.sessions.values()]) this.terminate(session);
  }

  countFor(ownerId: number): number {
    let count = 0;
    for (const session of this.sessions.values()) if (session.ownerId === ownerId) count += 1;
    return count;
  }

  get size(): number {
    return this.sessions.size;
  }

  private clearGrace(ownerId: number): void {
    const timer = this.graceTimers.get(ownerId);
    if (timer) clearTimeout(timer);
    this.graceTimers.delete(ownerId);
  }

  private owned(ownerId: number, id: unknown): Session | undefined {
    if (typeof id !== "string") return undefined;
    const session = this.sessions.get(id);
    return session && session.ownerId === ownerId ? session : undefined;
  }

  private forget(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    for (const disposer of session.disposers) disposer.dispose();
  }

  private terminate(session: Session): void {
    this.forget(session.id);
    try {
      // Windows 上 node-pty 不接受信号参数
      if (process.platform === "win32") session.pty.kill();
      else session.pty.kill("SIGHUP");
    } catch {
      /* 已经退出 */
    }
  }
}
