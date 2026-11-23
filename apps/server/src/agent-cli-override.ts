import type { AgentCli } from "./local-agents.js";

/**
 * 外部宿主（桌面端）指定拉起本机 Agent 的命令：HIVE_LOCAL_AGENT_CLI 是 JSON 数组，
 * 第一项是程序，其余是固定参数，后面再由 Server 接上 join 等参数。
 * 桌面端里 process.execPath 是 Electron 本身，不能当 Node 用，所以由它告诉 Server 怎么起 Agent。
 * 格式不对就报错，不悄悄退回默认（那样会拉起一个错的程序）。
 */
export function agentCliOverride(value: string | undefined): AgentCli | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("HIVE_LOCAL_AGENT_CLI must be a JSON array of strings");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new Error("HIVE_LOCAL_AGENT_CLI must be a non-empty JSON array of strings");
  }
  const [command, ...args] = parsed as string[];
  return { command: command!, args };
}
