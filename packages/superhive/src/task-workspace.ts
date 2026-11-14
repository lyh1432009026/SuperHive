import { realpath, stat } from "node:fs/promises";
import type { HiveMcpConnection } from "./hive-mcp-config.js";
import { hiveMcpHeaders } from "./hive-mcp-config.js";
import { AgentNonRetryableError } from "./responder.js";

export async function resolveTaskWorkspace(
  hive: HiveMcpConnection,
  messageId: string,
): Promise<string | undefined> {
  try {
    const response = await fetch(
      `${hive.serverUrl}/api/agent/worktree?messageId=${encodeURIComponent(messageId)}`,
      { headers: hiveMcpHeaders(hive), signal: AbortSignal.timeout(25_000) },
    );
    if (!response.ok) throw new Error(`Cannot verify managed task workspace (${response.status})`);
    const value = (await response.json()) as {
      worktree?: { path?: unknown; agentName?: unknown; roomId?: unknown } | null;
    };
    if (value.worktree === null) return undefined;
    const record = value.worktree;
    if (
      !record ||
      typeof record.path !== "string" ||
      record.agentName !== hive.username ||
      record.roomId !== hive.roomId
    )
      throw new Error("Invalid managed task workspace identity");
    if ((await realpath(record.path)) !== record.path || !(await stat(record.path)).isDirectory())
      throw new Error("Managed task workspace has changed");
    return record.path;
  } catch (error) {
    throw new AgentNonRetryableError(
      `Cannot safely select the task workspace; confirm before retrying: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
