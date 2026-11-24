import { z } from "zod";

/**
 * 思考强度（reasoning effort / thinking level）：每个 Agent 可以单独设、「换个模型重试」时也能临时换。
 * 不设就不传参数，沿用 CLI 自己的配置（与没有这个功能时的行为一致）。
 *
 * 各运行时的传法（本机实测 Claude Code 2.1.330、codex-cli 0.171.0、Copilot CLI 1.0.114、omp 19.1.0）：
 * - claude：每轮 `--effort <level>`
 * - codex：app-server turn/start 的 `effort`（会沿用到后续回合，没指定的回合要传回会话原值）
 * - copilot：每轮 `--reasoning-effort <level>`
 * - omp：ACP 会话 configOptions 里 category 为 thought_level 的选项，用 session/set_config_option 切换
 * opencode、Gemini CLI 的 ACP 会话没有这个选项，OpenClaw 未验证，都不支持。
 */
export const reasoningEffortSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_-]*$/);

/** 各运行时 CLI 接受的全部档位（由低到高）；具体模型能用哪几档以运行时列出的为准 */
export const RUNTIME_REASONING_EFFORTS = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  copilot: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  omp: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"],
} as const satisfies Record<string, readonly string[]>;

export type ReasoningEffortProvider = keyof typeof RUNTIME_REASONING_EFFORTS;

/** 这个运行时能不能按 Agent、按轮切换思考强度 */
export function supportsReasoningEffort(provider: string): provider is ReasoningEffortProvider {
  return Object.hasOwn(RUNTIME_REASONING_EFFORTS, provider);
}

/** 运行时接受的档位；不支持的运行时返回空数组 */
export function runtimeReasoningEfforts(provider: string): readonly string[] {
  return supportsReasoningEffort(provider) ? RUNTIME_REASONING_EFFORTS[provider] : [];
}

/** 档位的排序（未知的排在最后），用来把各处拿到的档位按由低到高显示 */
const ORDER = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];
export function sortReasoningEfforts(efforts: Iterable<string>): string[] {
  const rank = (effort: string) => {
    const index = ORDER.indexOf(effort);
    return index < 0 ? ORDER.length : index;
  };
  return [...new Set(efforts)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
