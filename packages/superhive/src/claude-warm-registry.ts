import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** 同一台机器上最多留几个空闲的 Claude 进程（每个几百 MB 内存） */
export const DEFAULT_CLAUDE_MAX_WARM = 8;

/** HIVE_CLAUDE_MAX_WARM：同一台机器上最多常驻几个空闲的 Claude 进程；0 = 不限，乱填按默认 */
export function claudeMaxWarm(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_CLAUDE_MAX_WARM;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_CLAUDE_MAX_WARM;
}

/** 这个用户的登记目录：每个 Bridge 一个进程，彼此只能通过文件知道对方 */
export function defaultWarmRegistryDir(): string {
  const user = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return path.join(tmpdir(), `superhive-claude-warm-${user}`);
}

type Entry = { file: string; pid: number; lastUsedAt: number };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：进程在，只是不是我们的
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 同一台机器上空闲（停着等下一轮）的 Claude 进程登记表。每个 Agent 是独立的 Bridge 进程，各留各的常驻进程；
 * 登记表让它们合起来不超过上限：新停下的进程登记后，超出上限就把最久没用的那个的登记删掉，
 * 它的主人轮询时发现自己的登记没了，就结束那个进程（下一轮照旧 --resume 接上）。
 */
export class ClaudeWarmRegistry {
  constructor(
    private readonly options: {
      dir: string;
      /** 0 = 不限 */
      max: number;
      now?: () => number;
      /** 测试注入：判断登记的 Bridge 进程还在不在 */
      isAlive?: (pid: number) => boolean;
    },
  ) {}

  /** 登记一个刚停下的进程，返回它的登记（用来查是否被淘汰、结束时注销） */
  park(): WarmTicket | undefined {
    if (this.options.max <= 0) return undefined;
    const now = (this.options.now ?? Date.now)();
    try {
      mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
      const file = path.join(this.options.dir, `${process.pid}-${randomUUID()}.json`);
      writeFileSync(file, JSON.stringify({ pid: process.pid, lastUsedAt: now }), { mode: 0o600 });
      this.evict(file);
      return new WarmTicket(file);
    } catch {
      // 登记不了（目录不可写等）：不限数量，照旧按空闲超时退出
      return undefined;
    }
  }

  /** 超出上限：按最近使用时间淘汰最久没用的（不淘汰刚登记的这个） */
  private evict(self: string): void {
    const isAlive = this.options.isAlive ?? alive;
    const entries: Entry[] = [];
    for (const name of readdirSync(this.options.dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.options.dir, name);
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as {
          pid?: unknown;
          lastUsedAt?: unknown;
        };
        const pid = typeof parsed.pid === "number" ? parsed.pid : 0;
        // 主人已经退出（崩溃、被结束）的登记直接清掉
        if (!pid || !isAlive(pid)) {
          rmSync(file, { force: true });
          continue;
        }
        entries.push({
          file,
          pid,
          lastUsedAt: typeof parsed.lastUsedAt === "number" ? parsed.lastUsedAt : 0,
        });
      } catch {
        // 刚被别人删掉或正在写：跳过
      }
    }
    const excess = entries.length - this.options.max;
    if (excess <= 0) return;
    entries
      .filter((entry) => entry.file !== self)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
      .slice(0, excess)
      .forEach((entry) => rmSync(entry.file, { force: true }));
  }
}

export class WarmTicket {
  constructor(readonly file: string) {}

  /** 登记还在：没被别的 Bridge 淘汰 */
  held(): boolean {
    return existsSync(this.file);
  }

  release(): void {
    rmSync(this.file, { force: true });
  }
}
