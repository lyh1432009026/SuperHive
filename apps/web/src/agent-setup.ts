import type { MetaResponse, Participant } from "@superhive/protocol";
import { agentNameFor, type SelectableAgentProvider } from "./agent-name";
import { localized, t } from "./i18n";

export type AgentAccessMode = "read-only" | "workspace" | "full";
export type AgentSetupStep = 1 | 2 | 3;

export const selectableAgentProviders = [
  "codex",
  "claude",
  "copilot",
  "opencode",
  "omp",
  "openclaw",
] as const;

export const agentProviderDescriptions: Record<SelectableAgentProvider, string> = localized(() => ({
  codex: t("OpenAI 编程 Agent"),
  claude: "Anthropic CLI",
  copilot: t("GitHub 编程助手"),
  openclaw: t("本地自主 Agent"),
  opencode: t("开源终端 Agent，模型自选"),
  omp: t("oh-my-pi 终端 Agent"),
}));

export const agentAccessOptions: Array<{
  id: AgentAccessMode;
  label: string;
  description: string;
}> = localized(() => [
  {
    id: "read-only",
    label: t("只读"),
    description: t("只能读代码、出方案，不能改文件、跑命令；适合只想让它看看、给建议。"),
  },
  {
    id: "workspace",
    label: t("工作区"),
    description: t("推荐。可在指定目录内读写文件、运行命令；越界的操作会被拦下或先问你。"),
  },
  {
    id: "full",
    label: t("完全访问"),
    description: t("不设 Hive 沙箱，可执行当前系统用户的所有操作。"),
  },
]);

export const agentSetupSteps: Array<{ step: AgentSetupStep; label: string }> = localized(() => [
  { step: 1, label: t("选择 Agent") },
  { step: 2, label: t("设置权限") },
  { step: 3, label: t("复制命令") },
]);

/** "继续"按钮一次追加的 Agent 互相对话轮数 */

export function participantStatusLabel(status: Participant["status"]): string {
  if (status === "online") return t("在线");
  if (status === "busy") return t("正在处理");
  return t("离线");
}

export function agentProviderLabel(provider?: string): string {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude Code";
  if (provider === "copilot") return "GitHub Copilot";
  if (provider === "openclaw") return "OpenClaw";
  if (provider === "opencode") return "OpenCode";
  if (provider === "omp") return "omp";
  if (provider === "echo") return "Echo";
  return provider || "Agent";
}

export function agentCommandFor(
  meta: MetaResponse,
  provider: SelectableAgentProvider,
  ownerUsername: string,
  access: AgentAccessMode,
  takenNames?: ReadonlySet<string>,
): string {
  const agentName = agentNameFor(ownerUsername, provider, takenNames);
  return (meta.agentCommand ?? "")
    .replace(" join ", ` join --provider ${provider} `)
    .replace("--room general ", "")
    .replace("--name my-agent", `--name ${agentName}`)
    .concat(` --access ${access}${access === "read-only" ? "" : " --cwd ."}`)
    .concat(provider === "openclaw" ? " --openclaw-configure-mcp" : "");
}
