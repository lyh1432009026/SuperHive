import type { Participant } from "@superhive/protocol";
import { t } from "./i18n";
import "./styles/member-workspace.css";
import { Tooltip } from "./tooltip";

export type MemberWorkspaceState =
  | { kind: "pending"; cwd: string; next: string | undefined }
  | { kind: "fallback"; cwd: string; note: string }
  | { kind: "following"; cwd: string };

/**
 * Agent 在本房间实际的工作目录（加入时上报）和房间当前设置的工作区对比：
 * 房间工作区改了、Agent 还没换过去 → pending（空闲后生效）；设了但没用上 → fallback；其余照实显示。
 * 旧版 Bridge 不上报时返回 undefined。
 */
export function memberWorkspaceState(
  participant: Participant,
  roomWorkspace: string | undefined,
): MemberWorkspaceState | undefined {
  const workspace = participant.workspace;
  if (participant.type !== "agent" || !workspace) return undefined;
  if ((workspace.roomWorkspace ?? "") !== (roomWorkspace ?? ""))
    return { kind: "pending", cwd: workspace.cwd, next: roomWorkspace };
  if (workspace.note) return { kind: "fallback", cwd: workspace.cwd, note: workspace.note };
  return { kind: "following", cwd: workspace.cwd };
}

export function memberWorkspaceHint(state: MemberWorkspaceState, name: string): string {
  if (state.kind === "pending")
    return state.next
      ? t("房间工作区已改为 {0}，{1} 空闲后生效；现在仍在 {2}", {
          0: state.next,
          1: name,
          2: state.cwd,
        })
      : t("房间已不再设工作区，{0} 空闲后生效；现在仍在 {1}", { 0: name, 1: state.cwd });
  if (state.kind === "fallback") return t("没有用上房间工作区：{0}", { 0: state.note });
  return t("在本房间的工作目录：{0}", { 0: state.cwd });
}

/** 成员名旁的工作目录标记：悬停看实际目录；工作区变更没生效、没用上时给出醒目的提示 */
export function MemberWorkspaceBadge({
  participant,
  roomWorkspace,
}: {
  participant: Participant;
  roomWorkspace: string | undefined;
}) {
  const state = memberWorkspaceState(participant, roomWorkspace);
  if (!state) return null;
  const label =
    state.kind === "pending"
      ? t("工作区待生效")
      : state.kind === "fallback"
        ? t("未用工作区")
        : t("目录");
  const hint = memberWorkspaceHint(state, participant.username);
  return (
    <Tooltip content={hint}>
      <span
        className={`member-workspace-badge ${state.kind}`}
        tabIndex={0}
        aria-label={hint}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {label}
      </span>
    </Tooltip>
  );
}
