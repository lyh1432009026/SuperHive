import type { Participant } from "@superhive/protocol";
import { t } from "./i18n";
import "./styles/member-workspace.css";
import { Tooltip } from "./tooltip";

/**
 * 工作区档却没有系统沙箱时的说明（Windows 上的 Claude Code）。设置弹窗的档位说明和成员列表的悬停说明共用这一句，
 * 保证两处说法一致
 */
export function noSandboxNote(): string {
  return t(
    "Windows 上没有系统沙箱：命令可以访问工作区以外的文件；有风险的操作靠 Claude 的自动审核拦下，或先请你确认。",
  );
}

/**
 * 本机 Agent 跑在 Server 所在电脑上：按 Server 报的平台判断，不看浏览器所在平台（房主可能在 Mac 上管 Windows）。
 * 目前只有 Claude Code 在 Windows 上的工作区档没有系统沙箱，其余运行时的工作区档各有自己的限制方式
 */
export function workspaceLacksSandbox(
  provider: string,
  access: string,
  hostPlatform: string | undefined,
): boolean {
  return provider === "claude" && access === "workspace" && hostPlatform === "win32";
}

/** 成员名旁的低调标记：Agent 加入时报了自己在工作区档但没有系统沙箱才显示 */
export function MemberSandboxBadge({ participant }: { participant: Participant }) {
  if (participant.type !== "agent" || !participant.workspace?.noSandbox) return null;
  const hint = noSandboxNote();
  return (
    <Tooltip content={hint}>
      <span
        className="member-workspace-badge"
        tabIndex={0}
        aria-label={hint}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {t("无沙箱")}
      </span>
    </Tooltip>
  );
}
