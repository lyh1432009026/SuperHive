import { realpath, stat } from "node:fs/promises";
import type { HiveMcpConnection } from "./hive-mcp-config.js";
import { hiveMcpHeaders } from "./hive-mcp-config.js";
import { AgentNonRetryableError } from "./responder.js";

export class TaskWorkspaceRemovedError extends Error {
  constructor(readonly path: string) {
    super(`The task workspace was cleaned up: ${path}`);
  }
}

export type TaskWorkspaceSelection = string | TaskWorkspaceRemovedError | undefined;

/**
 * 暂时没能确认任务目录：Server 忙（排在写操作后面等锁超时、git 超时）或连不上。
 * 不说明哪里不安全，这一轮也还没开始执行；已经自动重试过，稍后再试即可。
 */
export class TaskWorkspaceBusyError extends Error {
  constructor(
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`Task workspace lookup is busy: ${reason}`, options);
    this.name = "TaskWorkspaceBusyError";
  }
}

/** 暂时忙时的重试节奏：每次最多等 17 秒，两次之间隔 2、4 秒，三次合计约 57 秒 */
export type TaskWorkspaceRetry = {
  attempts: number;
  timeoutMs: number;
  delaysMs: number[];
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_RETRY: TaskWorkspaceRetry = {
  attempts: 3,
  timeoutMs: 17_000,
  delaysMs: [2_000, 4_000],
};

/** Server 明确说忙（503）、网关/限流类状态，或请求超时、连不上：都是等一会儿可能就好 */
class TransientLookupError extends Error {}

function transient(error: unknown): boolean {
  if (error instanceof TransientLookupError) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  // fetch 连不上时抛 TypeError("fetch failed")，具体原因在 cause 里
  return error instanceof TypeError && /fetch failed|network/i.test(error.message);
}

async function lookup<Body>(
  hive: HiveMcpConnection,
  init: { url: string; method?: string; body?: string },
  retry: TaskWorkspaceRetry,
): Promise<Body> {
  const sleep = retry.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(init.url, {
        ...(init.method ? { method: init.method } : {}),
        headers: init.body
          ? { ...hiveMcpHeaders(hive), "content-type": "application/json" }
          : hiveMcpHeaders(hive),
        ...(init.body ? { body: init.body } : {}),
        signal: AbortSignal.timeout(retry.timeoutMs),
      });
      if ([429, 502, 503, 504].includes(response.status))
        throw new TransientLookupError(`Hive Server is busy (${response.status})`);
      if (!response.ok)
        throw new Error(`Cannot verify managed task workspace (${response.status})`);
      return (await response.json()) as Body;
    } catch (error) {
      if (!transient(error)) throw error;
      if (attempt >= retry.attempts)
        throw new TaskWorkspaceBusyError(
          `${error instanceof Error ? error.message : String(error)} (after ${attempt} attempts)`,
          { cause: error },
        );
      await sleep(retry.delaysMs[attempt - 1] ?? retry.delaysMs.at(-1) ?? 0);
    }
  }
}

/** 身份不符、目录被换、回执不对：选不准目录就不能开工，直接失败，交给人核对 */
function unsafe(error: unknown, plural: boolean): Error {
  if (error instanceof TaskWorkspaceBusyError) return error;
  return new AgentNonRetryableError(
    `Cannot safely select the task workspace${plural ? "s" : ""}; confirm before retrying: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

export async function resolveTaskWorkspace(
  hive: HiveMcpConnection,
  messageId: string,
  retry: TaskWorkspaceRetry = DEFAULT_RETRY,
): Promise<TaskWorkspaceSelection> {
  try {
    const value = await lookup<{ worktree?: unknown }>(
      hive,
      { url: `${hive.serverUrl}/api/agent/worktree?messageId=${encodeURIComponent(messageId)}` },
      retry,
    );
    return await verifyWorkspace(hive, value.worktree);
  } catch (error) {
    throw unsafe(error, false);
  }
}

async function verifyWorkspace(
  hive: HiveMcpConnection,
  value: unknown,
): Promise<TaskWorkspaceSelection> {
  if (value === null) return undefined;
  const record = value as
    | { id?: unknown; path?: unknown; agentName?: unknown; roomId?: unknown; removed?: unknown }
    | undefined;
  if (
    !record ||
    typeof record.path !== "string" ||
    record.agentName !== hive.username ||
    record.roomId !== hive.roomId
  )
    throw new Error("Invalid managed task workspace identity");
  if (record.removed === true) {
    if (
      typeof record.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.id)
    )
      throw new Error("Invalid managed task workspace removal receipt");
    return new TaskWorkspaceRemovedError(record.path);
  }
  if ((await realpath(record.path)) !== record.path || !(await stat(record.path)).isDirectory())
    throw new Error("Managed task workspace has changed");
  return record.path;
}

export async function resolveTaskWorkspaces(
  hive: HiveMcpConnection,
  messageIds: string[],
  retry: TaskWorkspaceRetry = DEFAULT_RETRY,
): Promise<Map<string, TaskWorkspaceSelection>> {
  try {
    const value = await lookup<{ worktrees?: Record<string, unknown> }>(
      hive,
      {
        url: `${hive.serverUrl}/api/agent/worktree`,
        method: "POST",
        body: JSON.stringify({ messageIds }),
      },
      retry,
    );
    const verified = new Map<unknown, Promise<TaskWorkspaceSelection>>();
    return new Map(
      await Promise.all(
        messageIds.map(async (id): Promise<[string, TaskWorkspaceSelection]> => {
          if (!value.worktrees || !Object.hasOwn(value.worktrees, id))
            throw new Error("Incomplete managed task workspace response");
          const record = value.worktrees[id];
          const key = record === null ? null : JSON.stringify(record);
          let selection = verified.get(key);
          if (!selection) {
            selection = verifyWorkspace(hive, record);
            verified.set(key, selection);
          }
          return [id, await selection];
        }),
      ),
    );
  } catch (error) {
    throw unsafe(error, true);
  }
}
