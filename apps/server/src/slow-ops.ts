import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { SlowOperation, SlowOperationsResponse } from "@superhive/protocol";

/**
 * 慢操作记录：锁、git 子进程、重查询、HTTP 请求超过阈值时写一条结构化日志，并在内存里留最近 N 条，
 * 供「这台电脑」设置页查看（#3944：锁被占 110 秒，当时只能靠读代码推断）。
 *
 * 只记操作名、耗时、仓库/房间和调用来源；git 只记子命令，HTTP 只记路由模板，不记参数、查询串和内容。
 * 调用来源经 AsyncLocalStorage 传下去：HTTP 请求、MCP 工具和 track() 包住的操作会成为里面
 * 锁和 git 调用的 source。
 */

type Logger = { warn: (object: Record<string, unknown>, message: string) => void };

export type SlowOpsSettings = {
  /** 锁、git、重查询的阈值（毫秒） */
  thresholdMs: number;
  /** HTTP 请求的阈值（毫秒） */
  requestThresholdMs: number;
  /** 内存里最多保留几条 */
  capacity: number;
};

export const DEFAULT_SLOW_OPS: SlowOpsSettings = {
  thresholdMs: 3_000,
  requestThresholdMs: 5_000,
  capacity: 200,
};

type Context = { source: string; roomId?: string | undefined };

type Entry = Omit<SlowOperation, "id" | "at">;

function positive(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** 从环境变量读阈值：HIVE_SLOW_OP_MS、HIVE_SLOW_REQUEST_MS、HIVE_SLOW_OP_HISTORY */
export function slowOpsSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): SlowOpsSettings {
  return {
    thresholdMs: positive(env.HIVE_SLOW_OP_MS) ?? DEFAULT_SLOW_OPS.thresholdMs,
    requestThresholdMs: positive(env.HIVE_SLOW_REQUEST_MS) ?? DEFAULT_SLOW_OPS.requestThresholdMs,
    capacity: positive(env.HIVE_SLOW_OP_HISTORY) ?? DEFAULT_SLOW_OPS.capacity,
  };
}

export class SlowOps {
  private settings: SlowOpsSettings = { ...DEFAULT_SLOW_OPS };
  private logger: Logger | undefined;
  private entries: SlowOperation[] = [];
  private readonly context = new AsyncLocalStorage<Context>();

  configure(settings: Partial<SlowOpsSettings>, logger?: Logger): void {
    this.settings = { ...this.settings, ...settings };
    if (logger) this.logger = logger;
    if (this.entries.length > this.settings.capacity)
      this.entries = this.entries.slice(-this.settings.capacity);
  }

  current(): Context | undefined {
    return this.context.getStore();
  }

  /** 在给定的调用来源下执行：里面的锁、git 调用都记成这个来源 */
  within<Result>(context: Context, operation: () => Result): Result {
    return this.context.run(context, operation);
  }

  /** 超过阈值就记一条；返回是否记了 */
  record(entry: Entry): boolean {
    const total = entry.durationMs + (entry.waitMs ?? 0);
    const threshold =
      entry.kind === "request" ? this.settings.requestThresholdMs : this.settings.thresholdMs;
    if (total < threshold) return false;
    const context = this.current();
    const item: SlowOperation = {
      id: randomUUID(),
      at: new Date().toISOString(),
      ...entry,
      durationMs: Math.round(entry.durationMs),
      ...(entry.waitMs !== undefined ? { waitMs: Math.round(entry.waitMs) } : {}),
      ...(entry.source === undefined && context?.source && context.source !== entry.name
        ? { source: context.source }
        : {}),
      ...(entry.roomId === undefined && context?.roomId ? { roomId: context.roomId } : {}),
    };
    this.entries.push(item);
    if (this.entries.length > this.settings.capacity) this.entries.shift();
    this.logger?.warn({ slowOp: item }, "slow operation");
    return true;
  }

  /**
   * 记一个操作的耗时（出错也记），并让它成为里面锁和 git 调用的来源。
   * 外层已有来源时，这个操作本身记在外层来源下。
   */
  async track<Result>(
    name: string,
    detail: { repo?: string | undefined; roomId?: string | undefined; kind?: Entry["kind"] },
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const started = performance.now();
    let failed = false;
    try {
      return await this.within(
        { source: name, roomId: detail.roomId ?? this.current()?.roomId },
        operation,
      );
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.record({
        kind: detail.kind ?? "operation",
        name,
        durationMs: performance.now() - started,
        ...(detail.repo ? { repo: detail.repo } : {}),
        ...(detail.roomId ? { roomId: detail.roomId } : {}),
        ...(failed ? { failed } : {}),
      });
    }
  }

  /** 同步版 track：数据库查询这类不让出事件循环的操作 */
  measure<Result>(
    name: string,
    detail: { repo?: string | undefined; roomId?: string | undefined },
    operation: () => Result,
  ): Result {
    const started = performance.now();
    let failed = false;
    try {
      return operation();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.record({
        kind: "operation",
        name,
        durationMs: performance.now() - started,
        ...(detail.repo ? { repo: detail.repo } : {}),
        ...(detail.roomId ? { roomId: detail.roomId } : {}),
        ...(failed ? { failed } : {}),
      });
    }
  }

  /** 最近的慢操作，新的在前 */
  list(): SlowOperationsResponse {
    return { operations: [...this.entries].reverse(), ...this.settings };
  }

  clear(): void {
    this.entries = [];
  }
}

/** 进程内共用一份：git 子进程这类没有 app 上下文的地方也能记 */
export const slowOps = new SlowOps();

/** git 只记子命令（跳过 -c 配置），不记分支名、路径等参数 */
export function gitOperationName(args: string[]): string {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "-c" || arg === "-C") {
      index++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return `git ${arg}`;
  }
  return "git";
}
