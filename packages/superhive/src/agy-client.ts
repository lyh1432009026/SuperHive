import { AcpResponder, type AcpResponderDependencies, type AcpToolCall } from "./acp-responder.js";
import { geminiHomeEnv, hasGeminiApiKey } from "./gemini-client.js";
import type { HiveMcpConnection } from "./hive-mcp-config.js";
import type { AgentAccessMode } from "./responder.js";

/**
 * agy（Antigravity CLI）的权限：默认模式下读文件、写文件、跑命令、调 MCP 工具都发 session/request_permission，
 * 由 AcpResponder 按档位裁决（只读只放行读取类；工作区放行命令和 cwd 内的改动）；
 * full 用 --dangerously-skip-permissions 全部自动放行。
 */
export function agyAccessArgs(access: AgentAccessMode): string[] {
  return access === "full" ? ["--dangerously-skip-permissions"] : [];
}

/** agy 的 MCP 工具名是 mcp_<server>_<tool>；Hive 的工具都以 hive_ 开头 */
export function isAgyHiveTool(toolCall: AcpToolCall): boolean {
  return typeof toolCall.name === "string" && toolCall.name.startsWith("mcp_hive_hive_");
}

/**
 * agy 在 initialize 里声明 _meta.antigravity.systemPrompt.append：打开会话（new / resume / load）时带上，
 * 内容追加进 agy 自己的系统提示，随会话保存；resume 时带新的会替换旧的（1.5.14 实测）
 */
export function agySystemPromptMeta(instructions: string): Record<string, unknown> {
  return { antigravity: { systemPrompt: { append: instructions } } };
}

export const AGY_AUTH_HINT =
  "请先在这台电脑的终端运行一次 agy，用 Google 账号登录；也可以在 ~/.gemini/.env 里配置 GEMINI_API_KEY（自建接口再加 GOOGLE_GEMINI_BASE_URL）改用 API key。然后再 @ 它";

export function createAgyResponder(
  options: {
    command: string;
    cwd: string;
    hive: HiveMcpConnection;
    access?: AgentAccessMode;
    /** agy 的模型，如 gemini-3.1-pro（见 hive models --provider agy） */
    model?: string;
    log?: (message: string) => void;
  },
  dependencies?: AcpResponderDependencies,
): AcpResponder {
  const access = options.access ?? "read-only";
  const env = geminiHomeEnv();
  return new AcpResponder(
    {
      label: "agy",
      command: options.command,
      // agy acp 没有指定模型的参数：启动时的模型按会话用 session/set_config_option 切
      args: ["acp", ...agyAccessArgs(access)],
      ...(Object.keys(env).length ? { env } : {}),
      cwd: options.cwd,
      hive: options.hive,
      access,
      isHiveTool: isAgyHiveTool,
      // 没登录 Google 账号时，环境里有 GEMINI_API_KEY 就用它登录（会连 GOOGLE_GEMINI_BASE_URL 指的接口）
      auth: {
        hint: AGY_AUTH_HINT,
        apiKeyMethod: "gemini-api-key",
        hasApiKey: hasGeminiApiKey(env),
      },
      ...(options.model ? { defaultModel: options.model } : {}),
      systemPromptMeta: agySystemPromptMeta,
      ...(options.log ? { log: options.log } : {}),
    },
    dependencies,
  );
}
