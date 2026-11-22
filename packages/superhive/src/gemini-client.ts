import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { AcpResponder, type AcpResponderDependencies, type AcpToolCall } from "./acp-responder.js";
import type { HiveMcpConnection } from "./hive-mcp-config.js";
import type { AgentAccessMode } from "./responder.js";

/**
 * 解析 .env：KEY=VALUE 一行一个，支持 export 前缀、# 注释、单双引号。只做 Gemini CLI 自己认的那部分写法，
 * 读不懂的行跳过
 */
export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n");
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    result[match[1]!] = value;
  }
  return result;
}

/**
 * ~/.gemini/.env（GEMINI_CLI_HOME 可改家目录）里的变量，Gemini CLI 与 agy 的 API key、接口地址常写在这里。
 * Gemini CLI 只在受信任目录里读 .env，且项目里有 .env 时会先读到项目那份，所以由 Bridge 显式带上；
 * 环境里已有的同名变量优先（与 dotenv 一致）。值只进子进程环境，不进日志。
 */
export function geminiHomeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const home = env.GEMINI_CLI_HOME || homedir();
  let content: string;
  try {
    content = readFileSync(path.join(home, ".gemini", ".env"), "utf8");
  } catch {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseDotEnv(content))) {
    if (env[key] === undefined) result[key] = value;
  }
  return result;
}

/** 环境（含 ~/.gemini/.env）里有没有 Gemini API key */
export function hasGeminiApiKey(
  extra: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.GEMINI_API_KEY || extra.GEMINI_API_KEY);
}

/**
 * Gemini CLI 的审批模式：
 * - read-only、workspace：default，写文件、跑命令、调 MCP 工具都发 session/request_permission，
 *   由 AcpResponder 按档位裁决（只读只放行读取类；工作区放行命令和 cwd 内的改动）。显式传入，
 *   免得用户在 settings.json 里把默认改成 auto_edit / yolo 绕过裁决
 * - full：yolo，全部自动放行
 * Gemini CLI 的文件工具本身也只能碰工作区（和它的临时目录），命令不受限。
 */
export function geminiApprovalMode(access: AgentAccessMode): "default" | "yolo" {
  return access === "full" ? "yolo" : "default";
}

/** Gemini CLI 在权限请求的 _meta 里写明 MCP 服务器名；toolCallId 形如 mcp_hive_hive_board_update__… */
export function isGeminiHiveTool(toolCall: AcpToolCall): boolean {
  const meta = (
    toolCall._meta as { "gemini-cli"?: { mcp?: { server_name?: unknown } } } | undefined
  )?.["gemini-cli"];
  if (meta?.mcp) return meta.mcp.server_name === "hive";
  const id = (toolCall as { toolCallId?: unknown }).toolCallId;
  return typeof id === "string" && id.startsWith("mcp_hive_hive_");
}

export const GEMINI_AUTH_HINT =
  "在 ~/.gemini/.env 里配置 GEMINI_API_KEY（自建接口再加 GOOGLE_GEMINI_BASE_URL），或在终端运行一次 gemini 完成登录，然后重启这个 Agent";

export function createGeminiResponder(
  options: {
    command: string;
    cwd: string;
    hive: HiveMcpConnection;
    access?: AgentAccessMode;
    /** Gemini 模型 ID，如 gemini-2.5-pro */
    model?: string;
    log?: (message: string) => void;
  },
  dependencies?: AcpResponderDependencies,
): AcpResponder {
  const access = options.access ?? "read-only";
  const env = geminiHomeEnv();
  return new AcpResponder(
    {
      label: "Gemini CLI",
      command: options.command,
      args: [
        "--acp",
        // 只信任这一次会话的目录：不写 trustedFolders.json；不信任时 Gemini CLI 不读 .env、不加载项目配置
        "--skip-trust",
        "--approval-mode",
        geminiApprovalMode(access),
        ...(options.model ? ["--model", options.model] : []),
      ],
      ...(Object.keys(env).length ? { env } : {}),
      cwd: options.cwd,
      hive: options.hive,
      access,
      isHiveTool: isGeminiHiveTool,
      auth: { hint: GEMINI_AUTH_HINT },
      ...(options.log ? { log: options.log } : {}),
    },
    dependencies,
  );
}
