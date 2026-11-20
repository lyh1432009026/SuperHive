import { t } from "./i18n";
import { PanelResizer, type ResizablePanel } from "./panel-resizer";
import { FilePreview } from "./attachments";
import { fitSideTabs } from "./ui-utils";
import { sidePanelTabs, type MobilePanel, type SidePanelTab } from "./app-storage";
import { Icon } from "./app-icons";
import { SchedulePanel } from "./schedules";
import {
  ProgressPanel,
  type ProgressGroup,
  type ProgressItem,
  type ProgressTarget,
} from "./progress";
import { WhiteboardPanel } from "./whiteboard";
import { avatarHueStyle, AvatarGlyph } from "./avatar";
import { OutdatedBadge } from "./local-agent-updates";
import { GuestMemberActions, GuestAccessBadge } from "./invite-dialog";
import { agentProviderLabel, participantStatusLabel } from "./agent-setup";
import type {
  Attachment,
  Invocation,
  Participant,
  Schedule,
  WhiteboardEntry,
} from "@superhive/protocol";
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
  accessNow,
  agentDialogOpen,
  agentSettingsButton,
  appendMention,
  authToken,
  base,
  cancelSchedule,
  changeWhiteboardArchive,
  closeDockedPreview,
  closeMobilePanel,
  currentRoomId,
  dockedNewerNotice,
  dockedPreview,
  doingCount,
  guest,
  invocations,
  isLeadAgent,
  isOwner,
  jumpToMessage,
  loadWhiteboardHistory,
  local,
  localAgentNames,
  locateProgress,
  membersCloseRef,
  mobilePanel,
  offline,
  online,
  onlineAgentNames,
  openAgentDialog,
  openMemberMenu,
  panelWidths,
  pendingScheduleCount,
  previewDocked,
  progressGroups,
  removeWhiteboardEntry,
  resizePanel,
  schedules,
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
  appendMention: (usernameToMention: string) => void;
  authToken: string | undefined;
  base: string;
  cancelSchedule: (schedule: Schedule) => void;
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
  invocations: ReadonlyMap<string, Invocation>;
  isLeadAgent: (participant: Participant) => boolean;
  isOwner: boolean;
  jumpToMessage: (messageId: string) => void;
  loadWhiteboardHistory: () => Promise<void>;
  local: LocalAgentsState;
  localAgentNames: Set<string>;
  locateProgress: (target: ProgressTarget) => void;
  membersCloseRef: RefObject<HTMLButtonElement | null>;
  mobilePanel: MobilePanel | undefined;
  offline: Participant[];
  online: Participant[];
  onlineAgentNames: Set<string>;
  openAgentDialog: (trigger: HTMLButtonElement) => void;
  openMemberMenu: (event: ReactMouseEvent<HTMLElement>, participant: Participant) => void;
  panelWidths: { rooms: number; members: number; preview: number };
  pendingScheduleCount: number;
  previewDocked: boolean;
  progressGroups: Record<ProgressGroup, ProgressItem[]>;
  removeWhiteboardEntry: (entry: WhiteboardEntry) => void;
  resizePanel: (panel: ResizablePanel, width: number) => void;
  schedules: ReadonlyMap<string, Schedule>;
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
              <button
                type="button"
                role="tab"
                id="side-tab-members"
                title={t("成员")}
                aria-selected={sidePanelTab === "members"}
                aria-controls="side-panel-members"
                tabIndex={sidePanelTab === "members" ? 0 : -1}
                className={sidePanelTab === "members" ? "active" : ""}
                onClick={() => setSidePanelTab("members")}
              >
                <Icon name="users" size={15} />
                <span className="side-tab-label">{t("成员")}</span>
                <span className="side-tab-count" aria-label={t("{0} 位在线", { 0: online.length })}>
                  {online.length}
                </span>
              </button>
              <button
                type="button"
                role="tab"
                id="side-tab-whiteboard"
                title={t("进展")}
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
              <button
                type="button"
                role="tab"
                id="side-tab-schedules"
                title={t("定时")}
                aria-selected={sidePanelTab === "schedules"}
                aria-controls="side-panel-schedules"
                tabIndex={sidePanelTab === "schedules" ? 0 : -1}
                className={sidePanelTab === "schedules" ? "active" : ""}
                onClick={() => setSidePanelTab("schedules")}
              >
                <Icon name="clock" size={15} />
                <span className="side-tab-label">{t("定时")}</span>
                {pendingScheduleCount > 0 && (
                  <span
                    className="side-tab-count"
                    aria-label={t("{0} 个待执行", { 0: pendingScheduleCount })}
                  >
                    {pendingScheduleCount}
                  </span>
                )}
              </button>
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
          {sidePanelTab === "schedules" ? (
            <div
              className="whiteboard-scroll"
              role="tabpanel"
              id="side-panel-schedules"
              aria-labelledby="side-tab-schedules"
              tabIndex={0}
            >
              <SchedulePanel
                schedules={schedules}
                invocations={invocations}
                onlineAgents={onlineAgentNames}
                onCancel={cancelSchedule}
                onJump={jumpToMessage}
              />
            </div>
          ) : sidePanelTab === "whiteboard" ? (
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
                {online.map((participant) => (
                  <div
                    key={participant.id}
                    className="member-row"
                    onContextMenu={(event) => openMemberMenu(event, participant)}
                  >
                    {/* 用 div 承载点击：访客行里还要嵌入「⋯」按钮，button 不能嵌套 button */}
                    <div
                      role="button"
                      tabIndex={0}
                      className="member"
                      onClick={() => {
                        closeMobilePanel(false);
                        appendMention(participant.username);
                      }}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        closeMobilePanel(false);
                        appendMention(participant.username);
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
                  </div>
                ))}
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
                  <button
                    type="button"
                    className="member-invite-action"
                    aria-haspopup="dialog"
                    title={t("生成限时链接，到期后自动失效")}
                    onClick={() => setInviteDialogOpen(true)}
                  >
                    <Icon name="user-plus" size={16} />
                    <span>
                      <strong>{t("邀请成员")}</strong>
                    </span>
                  </button>
                ) : (
                  guest && (
                    <button
                      type="button"
                      className="member-invite-action"
                      aria-haspopup="dialog"
                      title={t("只能进本房间，和你同时到期")}
                      onClick={() => setGuestAgentDialogOpen(true)}
                    >
                      <Icon name="plug" size={16} />
                      <span>
                        <strong>{t("带入我的 Agent")}</strong>
                      </span>
                    </button>
                  )
                )}
                {isOwner && (
                  <button
                    type="button"
                    className="member-invite-action sidebar-agent-entry"
                    aria-label={t("接入 Agent")}
                    aria-haspopup="dialog"
                    aria-expanded={agentDialogOpen}
                    title={t("选择运行时并复制接入命令")}
                    onClick={(event) => openAgentDialog(event.currentTarget)}
                  >
                    <Icon name="plug" size={16} />
                    <span>
                      <strong>{t("接入 Agent")}</strong>
                    </span>
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </aside>
  );
}
