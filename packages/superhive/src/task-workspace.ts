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

export async function resolveTaskWorkspace(
  hive: HiveMcpConnection,
  messageId: string,
): Promise<TaskWorkspaceSelection> {
  try {
    const response = await fetch(
      `${hive.serverUrl}/api/agent/worktree?messageId=${encodeURIComponent(messageId)}`,
      { headers: hiveMcpHeaders(hive), signal: AbortSignal.timeout(25_000) },
    );
    if (!response.ok) throw new Error(`Cannot verify managed task workspace (${response.status})`);
    const value = (await response.json()) as { worktree?: unknown };
    return await verifyWorkspace(hive, value.worktree);
  } catch (error) {
    throw new AgentNonRetryableError(
      `Cannot safely select the task workspace; confirm before retrying: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
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
): Promise<Map<string, TaskWorkspaceSelection>> {
  try {
    const response = await fetch(`${hive.serverUrl}/api/agent/worktree`, {
      method: "POST",
      headers: { ...hiveMcpHeaders(hive), "content-type": "application/json" },
      body: JSON.stringify({ messageIds }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) throw new Error(`Cannot verify managed task workspaces (${response.status})`);
    const value = (await response.json()) as { worktrees?: Record<string, unknown> };
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
    throw new AgentNonRetryableError(
      `Cannot safely select the task workspaces; confirm before retrying: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
