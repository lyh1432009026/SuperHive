import { t } from "./i18n";
import { PanelResizer, type ResizablePanel } from "./panel-resizer";
import { FilePreview } from "./attachments";
import { fitSideTabs } from "./ui-utils";
import { sidePanelTabs, type MobilePanel, type SidePanelTab } from "./app-storage";
import { Icon } from "./app-icons";
import { Tooltip } from "./tooltip";
import {
  ProgressPanel,
  type ProgressGroup,
  type ProgressItem,
  type ProgressTarget,
} from "./progress";
import { WhiteboardPanel } from "./whiteboard";
import { avatarHueStyle, AvatarGlyph } from "./avatar";
import { OutdatedBadge } from "./local-agent-updates";
import { MemberWorkspaceBadge } from "./member-workspace";
import { GuestMemberActions, GuestAccessBadge } from "./invite-dialog";
import { agentProviderLabel, participantStatusLabel } from "./agent-setup";
import type { Attachment, Participant, WhiteboardEntry } from "@superhive/protocol";
import type {
  Dispatch,
  SetStateAction,
  ReactNode,
  RefObject,
  MouseEvent as ReactMouseEvent,
} from "react";
import type { LocalAgentsState } from "./local-agents";
import type { GuestAccess } from "./access-gate";

/** 右侧栏：成员、进展、定时三个标签页，或停靠在这里的文件预览 */
export function SidePanel({
  roomWorkspace,
  accessNow,
  agentDialogOpen,
  agentSettingsButton,
  agentTaskSummary,
  appendMention,
  authToken,
  base,
  changeWhiteboardArchive,
  closeDockedPreview,
  closeMobilePanel,
  currentRoomId,
  dockedNewerNotice,
  dockedPreview,
  doingCount,
  guest,
  isLeadAgent,
  isOwner,
  loadWhiteboardHistory,
  local,
  localAgentNames,
  locateProgress,
  membersCloseRef,
  mobilePanel,
  offline,
  online,
  openAgentDialog,
  openAgentTask,
  openMemberMenu,
  panelWidths,
  previewDocked,
  progressGroups,
  removeWhiteboardEntry,
  resizePanel,
  setDockedPreview,
  setError,
  setGuestAgentDialogOpen,
  setInviteDialogOpen,
  setSidePanelTab,
  sidePanelTab,
  whiteboard,
  whiteboardEpochRef,
}: {
  accessNow: number;
  agentDialogOpen: boolean;
  agentSettingsButton: (name: string) => ReactNode;
  /** Agent 手上在办的事：有的话点成员行跳过去，而不是 @ 它 */
  agentTaskSummary: (
    name: string,
  ) => { count: number; seq: number | undefined; roomName: string | undefined } | undefined;
  appendMention: (usernameToMention: string) => void;
  authToken: string | undefined;
  base: string;
  changeWhiteboardArchive: (entries: WhiteboardEntry[], archive: boolean) => Promise<void>;
  closeDockedPreview: () => void;
  closeMobilePanel: (restoreFocus?: boolean) => void;
  currentRoomId: string;
  dockedNewerNotice: ReactNode | undefined;
  dockedPreview:
    | { roomId: string; attachment: Attachment; senderId: string; seq: number; popped?: boolean }
    | undefined;
  doingCount: number;
  guest: GuestAccess | undefined;
  isLeadAgent: (participant: Participant) => boolean;
  isOwner: boolean;
  /** 当前房间设置的工作区：和成员上报的对比，看工作区变更是否已生效 */
  roomWorkspace: string | undefined;
  loadWhiteboardHistory: () => Promise<void>;
  local: LocalAgentsState;
  localAgentNames: Set<string>;
  locateProgress: (target: ProgressTarget) => void;
  membersCloseRef: RefObject<HTMLButtonElement | null>;
  mobilePanel: MobilePanel | undefined;
  offline: Participant[];
  online: Participant[];
  openAgentDialog: (trigger: HTMLButtonElement) => void;
  openAgentTask: (name: string) => void;
  openMemberMenu: (event: ReactMouseEvent<HTMLElement>, participant: Participant) => void;
  panelWidths: { rooms: number; members: number; preview: number };
  previewDocked: boolean;
  progressGroups: Record<ProgressGroup, ProgressItem[]>;
  removeWhiteboardEntry: (entry: WhiteboardEntry) => void;
  resizePanel: (panel: ResizablePanel, width: number) => void;
  setDockedPreview: Dispatch<
    SetStateAction<
      | { roomId: string; attachment: Attachment; senderId: string; seq: number; popped?: boolean }
      | undefined
    >
  >;
  setError: Dispatch<SetStateAction<string | undefined>>;
  setGuestAgentDialogOpen: Dispatch<SetStateAction<boolean>>;
  setInviteDialogOpen: Dispatch<SetStateAction<boolean>>;
  setSidePanelTab: Dispatch<SetStateAction<SidePanelTab>>;
  sidePanelTab: SidePanelTab;
  whiteboard: ReadonlyMap<string, WhiteboardEntry>;
  whiteboardEpochRef: RefObject<number>;
}) {
  return (
    <aside
      className={`members-panel panel ${mobilePanel === "members" ? "mobile-open" : ""}`}
      aria-label={t("成员列表")}
    >
      {previewDocked && dockedPreview ? (
        <>
          <PanelResizer panel="preview" width={panelWidths.preview} onResize={resizePanel} />
          <FilePreview
            key={dockedPreview.attachment.id}
            attachment={dockedPreview.attachment}
            base={base}
            token={authToken}
            docked
            onClose={closeDockedPreview}
            onUndock={() => setDockedPreview((current) => current && { ...current, popped: true })}
            notice={dockedNewerNotice}
          />
        </>
      ) : (
        <>
          <PanelResizer panel="members" width={panelWidths.members} onResize={resizePanel} />
          <div className="panel-heading side-panel-heading">
            <div
              className="side-tabs"
              role="tablist"
              aria-label={t("侧栏视图")}
              ref={fitSideTabs}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const index = sidePanelTabs.indexOf(sidePanelTab);
                const next: SidePanelTab =
                  event.key === "Home"
                    ? sidePanelTabs[0]!
                    : event.key === "End"
                      ? sidePanelTabs.at(-1)!
                      : sidePanelTabs[
                          (index + (event.key === "ArrowLeft" ? -1 : 1) + sidePanelTabs.length) %
                            sidePanelTabs.length
                        ]!;
                setSidePanelTab(next);
                event.currentTarget.querySelector<HTMLButtonElement>(`#side-tab-${next}`)?.focus();
              }}
            >
              <Tooltip content={t("成员")}>
                <button
                  type="button"
                  role="tab"
                  id="side-tab-members"
                  aria-selected={sidePanelTab === "members"}
                  aria-controls="side-panel-members"
                  tabIndex={sidePanelTab === "members" ? 0 : -1}
                  className={sidePanelTab === "members" ? "active" : ""}
                  onClick={() => setSidePanelTab("members")}
                >
                  <Icon name="users" size={15} />
                  <span className="side-tab-label">{t("成员")}</span>
                  <span
                    className="side-tab-count"
                    aria-label={t("{0} 位在线", { 0: online.length })}
                  >
                    {online.length}
                  </span>
                </button>
              </Tooltip>
              <Tooltip content={t("进展")}>
                <button
                  type="button"
                  role="tab"
                  id="side-tab-whiteboard"
                  aria-selected={sidePanelTab === "whiteboard"}
                  aria-controls="side-panel-whiteboard"
                  tabIndex={sidePanelTab === "whiteboard" ? 0 : -1}
                  className={sidePanelTab === "whiteboard" ? "active" : ""}
                  onClick={() => setSidePanelTab("whiteboard")}
                >
                  <Icon name="board" size={15} />
                  <span className="side-tab-label">{t("进展")}</span>
                  {progressGroups.attention.length > 0 ? (
                    <span
                      className="side-tab-count warning"
                      aria-label={t("{0} 件等你处理", { 0: progressGroups.attention.length })}
                    >
                      {progressGroups.attention.length}
                    </span>
                  ) : (
                    doingCount > 0 && (
                      <span
                        className="side-tab-count"
                        aria-label={t("{0} 件在做", { 0: doingCount })}
                      >
                        {doingCount}
                      </span>
                    )
                  )}
                </button>
              </Tooltip>
            </div>
            <button
              ref={membersCloseRef}
              className="panel-close"
              type="button"
              aria-label={t("关闭成员列表")}
              onClick={() => closeMobilePanel()}
            >
              <Icon name="close" />
            </button>
          </div>
          {sidePanelTab === "whiteboard" ? (
            <div
              className="whiteboard-scroll"
              role="tabpanel"
              id="side-panel-whiteboard"
              aria-labelledby="side-tab-whiteboard"
              tabIndex={0}
            >
              <ProgressPanel
                key={currentRoomId}
                groups={progressGroups}
                onLocate={locateProgress}
                board={
                  <WhiteboardPanel
                    entries={whiteboard}
                    canManage={isOwner}
                    onRemove={removeWhiteboardEntry}
                    onArchive={changeWhiteboardArchive}
                    loadHistory={loadWhiteboardHistory}
                    historyEpoch={whiteboardEpochRef.current}
                  />
                }
              />
            </div>
          ) : (
            <>
              <div
                className="member-list"
                role="tabpanel"
                id="side-panel-members"
                aria-labelledby="side-tab-members"
              >
                {online.map((participant) => {
                  // 忙碌的 Agent 点击跳到它在做的事，@ 它改由名字旁的「@」按钮
                  const task =
                    participant.type === "agent"
                      ? agentTaskSummary(participant.username)
                      : undefined;
                  const activate = () => {
                    closeMobilePanel(false);
                    if (task) openAgentTask(participant.username);
                    else appendMention(participant.username);
                  };
                  return (
                    <div
                      key={participant.id}
                      className="member-row"
                      onContextMenu={(event) => openMemberMenu(event, participant)}
                    >
                      {/* 用 div 承载点击：访客行里还要嵌入「⋯」按钮，button 不能嵌套 button。
                          忙碌时悬停提示它在做哪条、点击会跳过去，读屏聚焦时作为描述念出 */}
                      <Tooltip content={task ? memberTaskHint(task) : undefined}>
                        <div
                          role="button"
                          tabIndex={0}
                          className={`member${task ? " has-task" : ""}`}
                          onClick={activate}
                          onKeyDown={(event) => {
                            if (event.target !== event.currentTarget) return;
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            activate();
                          }}
                        >
                          <span
                            className={`avatar ${participant.type}`}
                            style={
                              participant.type === "human"
                                ? avatarHueStyle(participant.username)
                                : undefined
                            }
                            aria-hidden="true"
                          >
                            <AvatarGlyph
                              type={participant.type}
                              name={participant.username}
                              provider={participant.provider}
                            />
                          </span>
                          <span className="member-copy">
                            <strong>
                              {participant.username}
                              {isLeadAgent(participant) && (
                                <span
                                  className="member-lead-badge"
                                  title={t("主 Agent：没有 @ 任何人的消息由它接话、调度其他 Agent")}
                                >
                                  {t("主")}
                                </span>
                              )}
                              <OutdatedBadge participant={participant} />
                              <MemberWorkspaceBadge
                                participant={participant}
                                roomWorkspace={roomWorkspace}
                              />
                              {participant.type === "agent" &&
                                localAgentNames.has(participant.username.toLocaleLowerCase()) && (
                                  <>
                                    <span
                                      className="member-local-badge"
                                      title={
                                        local.mode === "device"
                                          ? t("由 {0} 上的 Hive Server 启动", {
                                              0: local.hostLabel ?? t("Server 所在电脑"),
                                            })
                                          : t("由本机 Hive Server 启动")
                                      }
                                    >
                                      {local.mode === "device" ? t("主机") : t("本机")}
                                    </span>
                                    {agentSettingsButton(participant.username)}
                                  </>
                                )}
                              {task && (
                                <span className="guest-actions">
                                  <button
                                    type="button"
                                    className="guest-actions-trigger member-mention-trigger"
                                    aria-label={t("在输入框里 @{0}", { 0: participant.username })}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      closeMobilePanel(false);
                                      appendMention(participant.username);
                                    }}
                                    onKeyDown={(event) => event.stopPropagation()}
                                  >
                                    @
                                  </button>
                                </span>
                              )}
                              {isOwner && authToken && participant.access && (
                                <GuestMemberActions
                                  participant={participant}
                                  base={base}
                                  adminToken={authToken}
                                  now={accessNow}
                                  onError={setError}
                                />
                              )}
                            </strong>
                            <small>
                              {participant.access ? (
                                <>
                                  {participant.type === "agent"
                                    ? `${agentProviderLabel(participant.provider)} · `
                                    : ""}
                                  <GuestAccessBadge participant={participant} now={accessNow} />
                                </>
                              ) : participant.type === "agent" ? (
                                `${agentProviderLabel(participant.provider)} · ${participant.persona || t("通用协作 Agent")}`
                              ) : (
                                "Human"
                              )}
                            </small>
                          </span>
                          <span
                            className={`status-dot ${participant.status}`}
                            title={participantStatusLabel(participant.status)}
                            aria-label={participantStatusLabel(participant.status)}
                          />
                        </div>
                      </Tooltip>
                    </div>
                  );
                })}
                {offline.length > 0 && (
                  <p className="offline-label">{t("离线 · {0}", { 0: offline.length })}</p>
                )}
                {offline.map((participant) => (
                  <div
                    key={participant.id}
                    className="member-row"
                    onContextMenu={(event) => openMemberMenu(event, participant)}
                  >
                    <div className="member muted">
                      <span
                        className={`avatar ${participant.type}`}
                        style={
                          participant.type === "human"
                            ? avatarHueStyle(participant.username)
                            : undefined
                        }
                        aria-hidden="true"
                      >
                        <AvatarGlyph
                          type={participant.type}
                          name={participant.username}
                          provider={participant.provider}
                        />
                      </span>
                      <span className="member-copy">
                        <strong>
                          {participant.username}
                          {isLeadAgent(participant) && (
                            <span
                              className="member-lead-badge"
                              title={t("主 Agent：没有 @ 任何人的消息由它接话、调度其他 Agent")}
                            >
                              {t("主")}
                            </span>
                          )}
                          {participant.type === "agent" &&
                            agentSettingsButton(participant.username)}
                          {isOwner && authToken && participant.access && (
                            <GuestMemberActions
                              participant={participant}
                              base={base}
                              adminToken={authToken}
                              now={accessNow}
                              onError={setError}
                            />
                          )}
                        </strong>
                        <small>
                          {participant.access ? (
                            <>
                              {participant.type === "agent"
                                ? `${agentProviderLabel(participant.provider)} · `
                                : ""}
                              <GuestAccessBadge participant={participant} now={accessNow} />
                            </>
                          ) : participant.type === "agent" ? (
                            t("{0} · 离线", { 0: agentProviderLabel(participant.provider) })
                          ) : (
                            t("Human · 离线")
                          )}
                        </small>
                      </span>
                      <span className="status-dot offline" aria-label={t("离线")} />
                    </div>
                  </div>
                ))}
              </div>
              {/* 成员栏底部只留一行：邀请成员、接入 Agent 并排，说明放到悬停提示里 */}
              <div className="member-invite" role="group" aria-label={t("添加成员")}>
                {isOwner ? (
                  <Tooltip content={t("生成限时链接，到期后自动失效")}>
                    <button
                      type="button"
                      className="member-invite-action"
                      aria-haspopup="dialog"
                      onClick={() => setInviteDialogOpen(true)}
                    >
                      <Icon name="user-plus" size={16} />
                      <span>
                        <strong>{t("邀请成员")}</strong>
                      </span>
                    </button>
                  </Tooltip>
                ) : (
                  guest && (
                    <Tooltip content={t("只能进本房间，和你同时到期")}>
                      <button
                        type="button"
                        className="member-invite-action"
                        aria-haspopup="dialog"
                        onClick={() => setGuestAgentDialogOpen(true)}
                      >
                        <Icon name="plug" size={16} />
                        <span>
                          <strong>{t("带入我的 Agent")}</strong>
                        </span>
                      </button>
                    </Tooltip>
                  )
                )}
                {isOwner && (
                  <Tooltip content={t("选择运行时并复制接入命令")}>
                    <button
                      type="button"
                      className="member-invite-action sidebar-agent-entry"
                      aria-label={t("接入 Agent")}
                      aria-haspopup="dialog"
                      aria-expanded={agentDialogOpen}
                      onClick={(event) => openAgentDialog(event.currentTarget)}
                    >
                      <Icon name="plug" size={16} />
                      <span>
                        <strong>{t("接入 Agent")}</strong>
                      </span>
                    </button>
                  </Tooltip>
                )}
              </div>
            </>
          )}
        </>
      )}
    </aside>
  );
}

/** 忙碌 Agent 行的悬停提示：它在做哪条、在哪个房间，并说明点击会跳过去 */
function memberTaskHint({
  count,
  seq,
  roomName,
}: {
  count: number;
  seq: number | undefined;
  roomName: string | undefined;
}) {
  const where = [roomName && `#${roomName}`, seq !== undefined && `#${seq}`]
    .filter(Boolean)
    .join(" ");
  const doing = where ? t("正在处理 {0}", { 0: where }) : t("正在处理任务");
  return count > 1
    ? t("{0} 等 {1} 条 · 点击跳过去", { 0: doing, 1: count })
    : t("{0} · 点击跳过去", { 0: doing });
}
