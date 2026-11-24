import { createHash } from "node:crypto";
import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type HiveMcpConnection = {
  serverUrl: string;
  roomId: string;
  username: string;
  token: string;
};

export function hiveMcpUrl(connection: HiveMcpConnection): string {
  return `${connection.serverUrl.replace(/\/$/, "")}/mcp`;
}

/**
 * HTTP 头的值只能是 Latin-1（Node 的 fetch 遇到「菜包-claude」这种中文名会直接抛错，
 * Claude Code 等 CLI 连 Hive MCP 时也一样），所以房间和名字一律按 URI 编码，Server 再解码。
 * 纯字母数字和 -_. 的名字编码前后一样，老版本 Server 照常认。
 */
export function encodeHiveHeaderValue(value: string): string {
  return encodeURIComponent(value);
}

/** 只标明房间和身份、不含 token 的请求头 */
function hiveMcpIdentityHeaders(connection: HiveMcpConnection): Record<string, string> {
  return {
    "X-Hive-Room": encodeHiveHeaderValue(connection.roomId),
    "X-Hive-Agent-Name": encodeHiveHeaderValue(connection.username),
  };
}

export function hiveMcpHeaders(connection: HiveMcpConnection): Record<string, string> {
  return {
    Authorization: `Bearer ${connection.token}`,
    ...hiveMcpIdentityHeaders(connection),
  };
}

export function claudeHiveMcpConfig(connection: HiveMcpConnection): string {
  return JSON.stringify({
    mcpServers: {
      hive: {
        type: "http",
        url: hiveMcpUrl(connection),
        headers: hiveMcpHeaders(connection),
      },
    },
  });
}

export function copilotHiveMcpConfig(connection: HiveMcpConnection): string {
  return JSON.stringify({
    mcpServers: {
      hive: {
        type: "http",
        url: hiveMcpUrl(connection),
        headers: hiveMcpHeaders(connection),
        tools: ["*"],
      },
    },
  });
}

/** ACP `session/new` / `session/load` 里的 mcpServers 条目（HTTP 传输，headers 为名值对数组） */
export type AcpMcpServer = {
  type: "http";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
};

export function acpHiveMcpServer(connection: HiveMcpConnection): AcpMcpServer {
  return {
    type: "http",
    name: "hive",
    url: hiveMcpUrl(connection),
    headers: Object.entries(hiveMcpHeaders(connection)).map(([name, value]) => ({ name, value })),
  };
}

/** Codex 读取 Hive token 的环境变量名 */
export const CODEX_HIVE_TOKEN_ENV = "HIVE_MCP_TOKEN";

/**
 * codex 的 `-c` 配置覆盖。token 不放进参数（同机其他用户用 ps 就能看到命令行），
 * 改用 bearer_token_env_var 让 Codex 从环境变量读；启动 Codex 时要带上 {@link codexHiveMcpEnv}。
 * Codex 默认把自己的环境变量原样传给模型执行的命令，所以再用 shell_environment_policy.set 把它清空：
 * 只改这一个键，用户自己配的 set / exclude 不受影响。
 */
export function codexHiveMcpOverrides(connection: HiveMcpConnection): string[] {
  const headerTable = Object.entries(hiveMcpIdentityHeaders(connection))
    .map(([name, value]) => `${JSON.stringify(name)}=${JSON.stringify(value)}`)
    .join(",");
  return [
    `mcp_servers.hive.url=${JSON.stringify(hiveMcpUrl(connection))}`,
    `mcp_servers.hive.bearer_token_env_var=${JSON.stringify(CODEX_HIVE_TOKEN_ENV)}`,
    `mcp_servers.hive.http_headers={${headerTable}}`,
    `shell_environment_policy.set.${CODEX_HIVE_TOKEN_ENV}=""`,
  ];
}

export function codexHiveMcpEnv(connection: HiveMcpConnection): Record<string, string> {
  return { [CODEX_HIVE_TOKEN_ENV]: connection.token };
}

/**
 * Hive 工具只作用于聊天室本身（服务端另有预算与权限限制），预先批准它们，
 * 否则只读档会把 hive_message_send / hive_board_update 的审批请求一并拒绝。
 * 仅用于 app-server 路径：更老的 codex 不认识这个字段。
 */
export const CODEX_HIVE_TOOLS_APPROVAL_OVERRIDE = `mcp_servers.hive.default_tools_approval_mode="approve"`;

/** `openclaw config set --batch-file` 的内容：把 Hive MCP 写到 mcp.servers 下（与 `openclaw mcp set` 同一位置） */
export function openClawHiveMcpBatch(connection: HiveMcpConnection): string {
  return JSON.stringify([
    {
      path: `mcp.servers.${openClawHiveMcpName(connection)}`,
      value: {
        url: hiveMcpUrl(connection),
        transport: "streamable-http",
        headers: hiveMcpHeaders(connection),
      },
    },
  ]);
}

export function openClawHiveMcpName(connection: HiveMcpConnection): string {
  const key = createHash("sha256")
    .update(`${connection.serverUrl}\0${connection.roomId}\0${connection.username}`)
    .digest("hex")
    .slice(0, 12);
  return `superhive-${key}`;
}

/** 带 Hive token 的临时 MCP 配置目录的名字前缀（mkdtemp 用） */
export const HIVE_MCP_TEMP_PREFIXES = [
  "hive-claude-mcp-",
  "hive-copilot-mcp-",
  "hive-openclaw-mcp-",
];

/**
 * 清掉之前遗留的临时 MCP 配置：进程被强行结束时来不及删，里面的 token 会一直留在磁盘上。
 * 只删一天前的，正在跑的回合（含同机其他 Agent 的）不受影响。
 */
export function sweepStaleHiveMcpConfigs(
  dir = tmpdir(),
  now = Date.now(),
  maxAgeMs = 24 * 60 * 60 * 1000,
): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!HIVE_MCP_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const target = path.join(dir, name);
    try {
      if (now - statSync(target).mtimeMs > maxAgeMs)
        rmSync(target, { recursive: true, force: true });
    } catch {
      // 别的进程刚删掉、或没有权限：跳过
    }
  }
}
