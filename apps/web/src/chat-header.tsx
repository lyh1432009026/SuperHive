import { useMemo, type Dispatch, type RefObject, type SetStateAction } from "react";
import type {
  Attachment,
  ChatMessage,
  Invocation,
  Participant,
  RoomSummary,
  WorkspaceOverview,
} from "@superhive/protocol";
import { BranchGlyph, WorktreeSwitcher } from "./worktree-switcher";
import { WorkspaceGlyph } from "./workspace-panel";
import { BUDGET_EXTEND_TURNS, currentPausedInvocations } from "./invocations";
import type { LocalAgentsState } from "./local-agents";
import { t } from "./i18n";
import {
  storedMembersCollapsedKey,
  storedRoomsCollapsedKey,
  type MobilePanel,
  type SettingsTab,
} from "./app-storage";
import { animateLayout } from "./ui-utils";
import { Icon } from "./app-icons";
import { keepAwakeSummary } from "./host-settings";
import type { ShareSelection } from "./share-bar";

/** 对话区顶栏：房间名、在线人数、工作区与分支（房主可点开任务目录下拉），以及新话题、产物、代码、分享等入口 */
export function ChatHeader({
  roomsCollapsed,
  setRoomsCollapsed,
  mobilePanel,
  openMobilePanel,
  currentRoomName,
  online,
  messages,
  currentRoomWorkspace,
  currentRoom,
  isOwner,
  local,
  loadRoomWorktrees,
  loadWorkspaceDetail,
  openWorkspaceSource,
  openWorktrees,
  setSettingsTab,
  setSettingsOpen,
  startNewTopic,
  artifactsButtonRef,
  artifactsOpen,
  setArtifactsOpen,
  artifactCount,
  canViewWorkspace,
  workspaceButtonRef,
  workspaceOpen,
  setWorkspaceOpen,
  workspaceChangeCount,
  share,
  previewDocked,
  membersCollapsed,
  setMembersCollapsed,
  setDockedPreview,
}: {
  roomsCollapsed: boolean;
  setRoomsCollapsed: Dispatch<SetStateAction<boolean>>;
  mobilePanel: MobilePanel | undefined;
  openMobilePanel: (panel: MobilePanel, trigger: HTMLButtonElement) => void;
  currentRoomName: string;
  online: Participant[];
  messages: ChatMessage[];
  currentRoomWorkspace: string | undefined;
  currentRoom: RoomSummary | undefined;
  isOwner: boolean;
  local: LocalAgentsState;
  loadRoomWorktrees: () => ReturnType<LocalAgentsState["worktrees"]>;
  loadWorkspaceDetail: () => Promise<WorkspaceOverview>;
  openWorkspaceSource: (source: string) => void;
  /** 打开「任务目录」面板；trigger 是关掉面板后焦点要回去的按钮 */
  openWorktrees: (trigger: HTMLButtonElement) => void;
  setSettingsTab: Dispatch<SetStateAction<SettingsTab>>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  startNewTopic: () => void;
  artifactsButtonRef: RefObject<HTMLButtonElement | null>;
  artifactsOpen: boolean;
  setArtifactsOpen: Dispatch<SetStateAction<boolean>>;
  artifactCount: number | undefined;
  canViewWorkspace: boolean;
  workspaceButtonRef: RefObject<HTMLButtonElement | null>;
  workspaceOpen: boolean;
  setWorkspaceOpen: Dispatch<SetStateAction<boolean>>;
  workspaceChangeCount: number;
  share: ShareSelection;
  previewDocked: boolean;
  membersCollapsed: boolean;
  setMembersCollapsed: Dispatch<SetStateAction<boolean>>;
  setDockedPreview: Dispatch<
    SetStateAction<
      | { roomId: string; attachment: Attachment; senderId: string; seq: number; popped?: boolean }
      | undefined
    >
  >;
}) {
  const { shareMode, setShareMode, exitShareMode } = share;
  return (
    <header className="chat-header">
      <button
        type="button"
        className="header-button rooms-toggle"
        aria-label={roomsCollapsed ? t("显示房间列表") : t("隐藏房间列表")}
        aria-pressed={!roomsCollapsed}
        title={roomsCollapsed ? t("显示房间列表") : t("隐藏房间列表")}
        onClick={() =>
          animateLayout(() =>
            setRoomsCollapsed((current) => {
              localStorage.setItem(storedRoomsCollapsedKey, String(!current));
              return !current;
            }),
          )
        }
      >
        <Icon name="panel-left" size={17} />
      </button>
      <button
        type="button"
        className="header-button mobile-only"
        aria-label={t("打开房间列表")}
        aria-expanded={mobilePanel === "rooms"}
        onClick={(event) => openMobilePanel("rooms", event.currentTarget)}
      >
        <Icon name="hash" size={17} />
      </button>
      <div className="chat-title">
        <h1>{currentRoomName}</h1>
        <span>
          {online.length} {t("位在线 ·")} {messages.length} {t("条消息")}
          {currentRoomWorkspace && (
            <span
              className="chat-title-workspace"
              title={t("房间工作区：{0}", { 0: currentRoomWorkspace })}
            >
              {" "}
              · {currentRoomWorkspace.split("/").filter(Boolean).at(-1)}
              {currentRoom?.branch &&
                (isOwner && local.enabled ? (
                  <WorktreeSwitcher
                    branch={currentRoom.branch}
                    loadWorktrees={loadRoomWorktrees}
                    loadOverview={loadWorkspaceDetail}
                    onOpenSource={openWorkspaceSource}
                    onManage={openWorktrees}
                  />
                ) : (
                  <span className="chat-title-branch" title={t("当前分支")}>
                    <BranchGlyph />
                    {currentRoom.branch}
                  </span>
                ))}
            </span>
          )}
          {local.keepAwake &&
            (local.keepAwake.status === "active" || local.keepAwake.status === "failed") && (
              <button
                type="button"
                className={`keep-awake-badge ${local.keepAwake.status}`}
                title={keepAwakeSummary(local.keepAwake)}
                aria-label={keepAwakeSummary(local.keepAwake)}
                onClick={() => {
                  setSettingsTab("computer");
                  setSettingsOpen(true);
                }}
              >
                {local.keepAwake.status === "active" ? t("☾ 保持在线") : t("! 保持在线未生效")}
              </button>
            )}
        </span>
      </div>
      <div className="chat-header-actions">
        <button
          type="button"
          className="header-button new-topic"
          disabled={messages.length === 0 || messages.at(-1)?.kind === "topic"}
          title={t("开启新话题：房间里的 Agent 会丢弃之前的会话，从新会话开始；历史消息保留")}
          onClick={startNewTopic}
        >
          <Icon name="plus" size={16} />
          <span>{t("新话题")}</span>
        </button>
        <button
          ref={artifactsButtonRef}
          type="button"
          className={`header-button artifacts-toggle ${artifactsOpen ? "active" : ""}`}
          aria-label={
            artifactCount
              ? t("产物：{0} 个图片和文件", { 0: artifactCount })
              : t("产物：房间里的图片和文件")
          }
          aria-pressed={artifactsOpen}
          title={t("产物：房间里的图片和文件")}
          onClick={() => {
            setWorkspaceOpen(false);
            setArtifactsOpen((current) => !current);
          }}
        >
          <Icon name="files" size={16} />
          <span>{t("产物")}</span>
          {artifactCount ? (
            <span className="header-count" aria-hidden="true">
              {artifactCount > 99 ? "99+" : artifactCount}
            </span>
          ) : null}
        </button>
        {canViewWorkspace && (
          <button
            ref={workspaceButtonRef}
            type="button"
            className={`header-button workspace-toggle ${workspaceOpen ? "active" : ""}`}
            aria-pressed={workspaceOpen}
            aria-label={
              workspaceChangeCount
                ? t("工作区文件与改动（{0} 个文件有未提交改动）", { 0: workspaceChangeCount })
                : t("工作区文件与改动")
            }
            title={t("工作区文件与改动（只读）")}
            onClick={() => {
              setArtifactsOpen(false);
              setWorkspaceOpen((current) => !current);
            }}
          >
            <WorkspaceGlyph />
            <span>{t("代码")}</span>
            {workspaceChangeCount > 0 && (
              <span className="header-count workspace-toggle-count" aria-hidden="true">
                {workspaceChangeCount > 999 ? "999+" : workspaceChangeCount}
              </span>
            )}
          </button>
        )}
        <button
          type="button"
          className={`header-button share-fab ${shareMode ? "active" : ""}`}
          aria-label={shareMode ? t("退出分享模式") : t("分享对话")}
          aria-pressed={shareMode}
          onClick={() => (shareMode ? exitShareMode() : setShareMode(true))}
        >
          <Icon name="share" size={16} />
          <span>{shareMode ? t("取消") : t("分享")}</span>
        </button>
        <button
          type="button"
          className="header-button members-drawer-toggle"
          aria-label={t("打开成员列表")}
          aria-expanded={mobilePanel === "members"}
          onClick={(event) => openMobilePanel("members", event.currentTarget)}
        >
          <Icon name="users" size={17} />
        </button>
        <button
          type="button"
          className="header-button desktop-only"
          aria-label={
            previewDocked
              ? t("收起右侧栏")
              : membersCollapsed
                ? t("显示成员与白板")
                : t("隐藏成员与白板")
          }
          aria-pressed={previewDocked || !membersCollapsed}
          title={
            previewDocked
              ? t("收起右侧栏")
              : membersCollapsed
                ? t("显示成员与白板")
                : t("隐藏成员与白板")
          }
          onClick={() =>
            animateLayout(() => {
              // 停靠着预览时右侧栏一定是开着的：这里就是收起它，连预览一起关
              if (previewDocked) {
                setDockedPreview(undefined);
                localStorage.setItem(storedMembersCollapsedKey, "true");
                setMembersCollapsed(true);
                return;
              }
              setMembersCollapsed((current) => {
                localStorage.setItem(storedMembersCollapsedKey, String(!current));
                return !current;
              });
            })
          }
        >
          <Icon name="panel-right" size={17} />
        </button>
      </div>
    </header>
  );
}

/** 顶栏下方的提示条：可清理的 worktree、错误、Agent 连续对话暂停、开启浏览器通知 */
export function ChatNotices({
  error,
  setError,
  showNotificationPrompt,
  invocations,
  messages,
  worktreeNotices,
  setWorktreeNotices,
  isOwner,
  local,
  currentRoomId,
  setGotoNotice,
  extendAgentBudget,
  dismissNotificationPrompt,
  ensureNotificationPermission,
}: {
  error: string | undefined;
  setError: Dispatch<SetStateAction<string | undefined>>;
  showNotificationPrompt: boolean;
  invocations: ReadonlyMap<string, Invocation>;
  messages: ChatMessage[];
  worktreeNotices: Map<string, { batchId: string; count: number }>;
  setWorktreeNotices: Dispatch<SetStateAction<Map<string, { batchId: string; count: number }>>>;
  isOwner: boolean;
  local: LocalAgentsState;
  currentRoomId: string;
  setGotoNotice: Dispatch<SetStateAction<string | undefined>>;
  extendAgentBudget: () => void;
  dismissNotificationPrompt: () => void;
  ensureNotificationPermission: () => Promise<boolean>;
}) {
  const pausedInvocations = useMemo(
    () => currentPausedInvocations(invocations.values(), messages),
    [invocations, messages],
  );
  const pausedAgentNames = useMemo(
    () => [...new Set(pausedInvocations.map((invocation) => `@${invocation.agentName}`))],
    [pausedInvocations],
  );
  return (
    <>
      {(error ||
        showNotificationPrompt ||
        pausedInvocations.length > 0 ||
        worktreeNotices.has(currentRoomId)) && (
        <div className="chat-notices">
          {isOwner && local.enabled && worktreeNotices.has(currentRoomId) && (
            <div className="notification-prompt worktree-batch" role="status">
              <span>
                {t("{0} 个任务目录已合入，可清理。", {
                  0: worktreeNotices.get(currentRoomId)!.count,
                })}
              </span>
              <button
                type="button"
                disabled={!local.canManage}
                onClick={async () => {
                  const notice = worktreeNotices.get(currentRoomId)!;
                  try {
                    await local.cleanWorktreeBatch(currentRoomId, notice.batchId);
                    setWorktreeNotices((current) => {
                      const next = new Map(current);
                      next.delete(currentRoomId);
                      return next;
                    });
                    setGotoNotice(t("已提交批量清理请求，完成后通知。"));
                  } catch (reason) {
                    setError(reason instanceof Error ? reason.message : String(reason));
                  }
                }}
              >
                {t("清理这批目录")}
              </button>
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button
                type="button"
                aria-label={t("关闭错误提示")}
                onClick={() => setError(undefined)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
          {pausedInvocations.length > 0 && (
            <div
              className="notification-prompt budget-prompt"
              role="status"
              aria-label={t("Agent 连续对话已暂停")}
            >
              <Icon name="shield" size={18} />
              <p>
                <strong>{t("Agent 连续对话已暂停，等待你确认")}</strong>
                {pausedAgentNames.slice(0, 3).join(t("、"))}
                {pausedAgentNames.length > 3 ? t(" 等") : ""} {t("的调用触及了轮数上限。")}
              </p>
              <div className="notification-prompt-actions">
                <button type="button" className="primary" onClick={extendAgentBudget}>
                  {t("继续 {0} 轮", { 0: BUDGET_EXTEND_TURNS })}
                </button>
              </div>
            </div>
          )}
          {showNotificationPrompt && (
            <div className="notification-prompt" role="status" aria-label={t("开启浏览器通知")}>
              <Icon name="bell" size={18} />
              <p>
                <strong>{t("开启浏览器通知")}</strong>
                {t("页面不在前台时，有人 @ 你会收到系统提醒。")}
              </p>
              <div className="notification-prompt-actions">
                <button type="button" onClick={dismissNotificationPrompt}>
                  {t("暂不")}
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void ensureNotificationPermission()}
                >
                  {t("开启")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
