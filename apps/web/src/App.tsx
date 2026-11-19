import {
  Fragment,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { WorktreePanel } from "./worktree-panel";
import { sortParticipantsByLastSeen } from "@superhive/protocol";
import type {
  ChatMessage,
  Invocation,
  KeepAwakeSettings,
  KeepAwakeState,
  LocalAgent,
  MessagesResponse,
  MetaResponse,
  Participant,
  QuestionAnswer,
  RoomSummary,
  RoomsResponse,
  ServerEvent,
  WhiteboardEntry,
  Schedule,
  TraceStep,
  UsageSummary,
} from "@superhive/protocol";
import {
  applyMention,
  draftMentions,
  filterMentionParticipants,
  recentMentionOrder,
  findMentionContext,
  type MentionContext,
} from "./mention-autocomplete";
import { createClientMessageId } from "./client-id";
import { localizeServerPayload, serverError } from "./server-text";
import { composerHistory, stepComposerHistory } from "./composer-history";
import {
  InvocationChips,
  groupInvocationsByMessage,
  BUDGET_EXTEND_TURNS,
  currentPausedInvocations,
  invocationStatusLabel,
  upsertInvocation,
  waitingInvocationForQuestion,
} from "./invocations";
import { WhiteboardPanel, upsertWhiteboardEntry } from "./whiteboard";
import { highlightDraft } from "./draft-highlight";
import type { ComposerHandle, ComposerKeyInfo } from "./rich-composer";
import { SchedulePanel, isPendingSchedule, upsertSchedule } from "./schedules";
import {
  sortRoomsForSidebar,
  moveRoom,
  orderRooms,
  storedRoomOrderKey,
  useRoomReorder,
} from "./room-reorder";
import { isLiveInvocation, mergeTraceSteps } from "./live-trace";
import {
  ActivityPanel,
  isInFlight,
  needsAttention,
  plainPreview,
  type ActivityView,
} from "./activity";
import { ThinkingCard, TraceRecap, groupLiveCards, showsLiveCard } from "./thinking-card";
import { buildGoToItems } from "./goto";
import { GoToPalette } from "./goto-palette";
import { KeyCombo } from "./key-combo";
import { matchShortcut, type ShortcutId } from "./shortcuts";
import { ShortcutsHelp } from "./shortcuts-help";
import {
  ContextMenu,
  contextMenuPoint,
  type ContextMenuItem,
  type ContextMenuState,
} from "./context-menu";
import { Select } from "./select";
import { ConfirmPopover } from "./confirm-popover";
import { AgentRuntimesPanel } from "./agent-runtimes-panel";
import { isMachineMessage, machinePreview, splitMentions } from "./machine-message";
import {
  AttentionRoomGroup,
  AttentionToasts,
  attentionDeliveryOptions,
  playAttentionTone,
  useAttention,
  type AttentionDelivery,
} from "./attention-alerts";
import { attentionLabels, concernsMe, nextAttention } from "./attention";
import { useFaviconBadge } from "./favicon-badge";
import {
  OnboardingGuide,
  finishOnboarding,
  markOnboardingIfNew,
  onboardingPending,
  type OnboardingStep,
} from "./onboarding";
import {
  LocalLaunch,
  providerInfo,
  useLocalAgents,
  DirectoryPicker,
  type LocalAgentsState,
  type HostApprover,
  type OwnerDevice,
} from "./local-agents";
import { agentNameFor, type SelectableAgentProvider } from "./agent-name";
import { createFrameClock, easeInOutCubic, easeOutQuint } from "./easing";
import { ShadowContent } from "./shadow-content";
import {
  CollapsibleMessage,
  MAX_MESSAGE_LENGTH,
  MESSAGE_LENGTH_WARNING_RATIO,
} from "./collapsible-message";
import { buildShareMarkdown, downloadFile, formatShareTimestamp, shareFilename } from "./share";

// Markdown 渲染器（react-markdown + highlight.js）体积较大，拆成独立 chunk 且在应用启动时
// 立即预加载：不阻塞首屏解析，又通常能赶在 WebSocket 快照到达前就绪，避免消息先以纯文本闪现
const messageMarkdownModule = import("./message-markdown");
type MessageMarkdownComponent = (typeof import("./message-markdown"))["MessageMarkdown"];
// 模块下载完成后同步渲染：React.lazy 第一次使用时总会挂起一轮（即使模块早已就绪），
// 先显示纯文本占位再换成 Markdown，会让消息列表在刷新时多一次重排和高度跳变
let loadedMessageMarkdown: MessageMarkdownComponent | undefined;
void messageMarkdownModule.then((module) => {
  loadedMessageMarkdown = module.MessageMarkdown;
});
const LazyMessageMarkdown = lazy(() =>
  messageMarkdownModule.then((module) => ({ default: module.MessageMarkdown })),
);
function MessageMarkdown({ content }: { content: string }) {
  // 每个实例挂载时选定一次，避免模块就绪后组件类型改变导致整条消息重新挂载
  const [Component] = useState<MessageMarkdownComponent | typeof LazyMessageMarkdown>(
    () => loadedMessageMarkdown ?? LazyMessageMarkdown,
  );
  return <Component content={content} />;
}

/** 自绘滚动动画单帧最多推进的时间：约两帧，主线程卡顿时动画放慢而不是跳跃 */
const MAX_FRAME_STEP_MS = 32;
import { copyTextToClipboard } from "./clipboard";
import { QuestionOptions } from "./question-options";
import type { GuestAccess } from "./access-gate";
import {
  GuestAccessBadge,
  GuestAgentDialog,
  GuestMemberActions,
  InviteDialog,
} from "./invite-dialog";
import { ImDialog } from "./im-dialog";
import { AgentSettingsDialog, SettingsGlyph } from "./agent-settings-dialog";
import { RetryModelDialog } from "./model-picker";
import {
  ComposerAttachments,
  MessageAttachments,
  PaperclipIcon,
  useAttachmentQueue,
} from "./attachments";
import { agentActivity } from "./agent-activity";
import { IM_CHANNEL_LABELS, listImConnections } from "./im-api";
import { ProviderLogo, providerLogoName } from "./provider-logos";
import { resolveServerBase, resolveShareBase, resolveWebSocketUrl } from "./server-url";
import {
  LOCALE_OPTIONS,
  getLocale,
  getLocalePreference,
  localized,
  setLocalePreference,
  t,
  useLocale,
} from "./i18n";
import { PanelResizer, usePanelWidths } from "./panel-resizer";

const storedUsernameKey = "superhive.username";
const storedRoomKey = "superhive.room";
const storedSendShortcutKey = "superhive.send-shortcut";
const storedAutoSaveDraftKey = "superhive.auto-save-draft";
const storedRichComposerKey = "superhive.rich-composer";
/** 所见即所得输入框（Tiptap）单独打包，用到时才加载；加载完之前先用纯文本输入框顶着 */
const RichComposer = lazy(() => import("./rich-composer"));
const storedTimeFormatKey = "superhive.time-format";
const storedMessageNotificationsKey = "superhive.notify-messages";
const storedNotificationPromptDismissedKey = "superhive.notify-prompt-dismissed";
const storedNotificationSoundKey = "superhive.notification-sound";
const storedPresenceNotificationsKey = "superhive.notify-agent-presence";
const storedThemeKey = "superhive.theme";
const storedDensityKey = "superhive.density";
const storedThreadWidthKey = "superhive.thread-width";
const storedMessageSizeKey = "superhive.message-size";
const storedMembersCollapsedKey = "superhive.members-collapsed";
const storedRoomsCollapsedKey = "superhive.rooms-collapsed";
const storedReduceMotionKey = "superhive.reduce-motion";
const storedAttentionDeliveryKey = "superhive.attention-delivery";
const storedAttentionSoundKey = "superhive.attention-sound";
const storedAttentionGroupKey = "superhive.attention-group";
type AgentAccessMode = "read-only" | "workspace" | "full";
type AgentSetupStep = 1 | 2 | 3;
type MessageNotificationMode = "off" | "mentions" | "all";
type SendShortcut = "modifier-enter" | "enter";
type SettingsTab = "chat" | "notifications" | "appearance" | "computer" | "runtimes";
type TimeFormat = "system" | "24h" | "12h";
type ThemePreference = "system" | "dark" | "light";
type InterfaceDensity = "comfortable" | "compact";
/** 消息区宽度：标准约 768px、宽约 1040px（默认）、铺满随窗口（上限约 1600px） */
type ThreadWidth = "standard" | "wide" | "full";
type MessageSize = "small" | "standard" | "large";
type BrowserNotificationPermission = NotificationPermission | "unsupported";
type MobilePanel = "members" | "rooms";
type SidePanelTab = "members" | "whiteboard" | "schedules";
const sidePanelTabs: SidePanelTab[] = ["members", "whiteboard", "schedules"];

/**
 * 侧栏标签一行放不下时（窄面板、英文等较长的译文），未选中的标签只留图标和计数，文字仍供读屏与悬停提示；
 * 按实际宽度判断，不按语言写死，任何语言都不会折行。
 */
function fitSideTabs(element: HTMLDivElement | null) {
  if (!element) return;
  const fit = () => {
    element.classList.remove("compact");
    if (element.scrollWidth > element.clientWidth + 1) element.classList.add("compact");
  };
  fit();
  if (typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return;
  const resize = new ResizeObserver(fit);
  resize.observe(element);
  // 切换标签、计数变化都会改变所需宽度
  const mutation = new MutationObserver((records) => {
    if (records.some((record) => record.target !== element)) fit();
  });
  mutation.observe(element, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => {
    resize.disconnect();
    mutation.disconnect();
  };
}
type IconName =
  | "arrow-down"
  | "arrow-right"
  | "arrow-up"
  | "at"
  | "activity"
  | "bell"
  | "board"
  | "check"
  | "clock"
  | "close"
  | "copy"
  | "external"
  | "hash"
  | "logout"
  | "maximize"
  | "minimize"
  | "message"
  | "more"
  | "panel-left"
  | "panel-right"
  | "plug"
  | "plus"
  | "send"
  | "search"
  | "settings"
  | "share"
  | "shield"
  | "undo"
  | "user-plus"
  | "users";

const selectableAgentProviders = [
  "codex",
  "claude",
  "copilot",
  "opencode",
  "omp",
  "openclaw",
] as const;

const agentProviderDescriptions: Record<SelectableAgentProvider, string> = localized(() => ({
  codex: t("OpenAI 编程 Agent"),
  claude: "Anthropic CLI",
  copilot: t("GitHub 编程助手"),
  openclaw: t("本地自主 Agent"),
  opencode: t("开源终端 Agent，模型自选"),
  omp: t("oh-my-pi 终端 Agent"),
}));

const agentAccessOptions: Array<{
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

const messageNotificationModes = ["off", "mentions", "all"] as const;

const messageNotificationOptions: Array<{
  id: MessageNotificationMode;
  label: string;
  description: string;
}> = localized(() => [
  { id: "off", label: t("关闭通知"), description: t("不弹系统通知，提示音不受影响") },
  { id: "mentions", label: t("@ 我时通知"), description: t("只有消息里提到我才提醒") },
  { id: "all", label: t("当前房间任意消息"), description: t("所在房间的每条新消息都提醒") },
]);

const agentSetupSteps: Array<{ step: AgentSetupStep; label: string }> = localized(() => [
  { step: 1, label: t("选择 Agent") },
  { step: 2, label: t("设置权限") },
  { step: 3, label: t("复制命令") },
]);

/** "继续"按钮一次追加的 Agent 互相对话轮数 */

const settingsTabs: Array<{ id: SettingsTab; label: string; description: string }> = localized(
  () => [
    { id: "chat", label: t("聊天与输入"), description: t("发送、草稿与时间") },
    { id: "notifications", label: t("通知"), description: t("提及、声音与状态") },
    { id: "appearance", label: t("外观"), description: t("语言、主题、密度与字号") },
    { id: "computer", label: t("这台电脑"), description: t("熄屏后保持在线") },
    { id: "runtimes", label: t("Agent 运行时"), description: t("接口地址与密钥、CLI 升级") },
  ],
);

function storedSendShortcut(): SendShortcut {
  return localStorage.getItem(storedSendShortcutKey) === "enter" ? "enter" : "modifier-enter";
}

function storedBoolean(key: string, fallback: boolean): boolean {
  const value = localStorage.getItem(key);
  return value === null ? fallback : value === "true";
}

function storedChoice<T extends string>(key: string, choices: readonly T[], fallback: T): T {
  const value = localStorage.getItem(key);
  return choices.includes(value as T) ? (value as T) : fallback;
}

function storedMessageNotificationMode(): MessageNotificationMode {
  return storedChoice(storedMessageNotificationsKey, messageNotificationModes, "mentions");
}

function draftStorageKey(username: string, roomId: string): string {
  return `superhive.draft.${username.toLocaleLowerCase()}.${roomId}`;
}

function readSeqStorageKey(roomId: string): string {
  return `superhive.read-seq.${roomId}`;
}

const roomIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

function roomIdFromHash(): string | undefined {
  const value = window.location.hash.replace(/^#/, "");
  return roomIdPattern.test(value) ? value : undefined;
}

function initialRoomId(): string {
  const value = roomIdFromHash() ?? localStorage.getItem(storedRoomKey);
  return value && roomIdPattern.test(value) ? value : "general";
}

function sortRooms(rooms: RoomSummary[]): RoomSummary[] {
  return [...rooms].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

function browserNotificationPermission(): BrowserNotificationPermission {
  return "Notification" in window ? Notification.permission : "unsupported";
}

function showBrowserNotification(title: string, body: string): void {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, tag: "superhive" });
  } catch {
    // Notification support can be restricted by browser or embedding context.
  }
}

// AudioContext 是稀缺资源（Chrome 有并发上限），全局复用一个而不是每次提示音都新建
let sharedToneContext: AudioContext | undefined;

function playNotificationTone(): void {
  const AudioContextConstructor =
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return;
  try {
    sharedToneContext ??= new AudioContextConstructor();
    const context = sharedToneContext;
    if (context.state === "suspended") void context.resume().catch(() => undefined);
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 620;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.16);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.17);
    oscillator.addEventListener("ended", () => {
      oscillator.disconnect();
      gain.disconnect();
    });
  } catch {
    // Audio playback can be blocked until the page receives a user gesture.
  }
}

function platformModifierLabel(): string {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "Cmd" : "Ctrl";
}

/** git 分支的小图标（房间工作区是仓库时显示当前分支） */
/** 置顶房间名前的小图钉 */
function PinGlyph() {
  return (
    <svg className="room-item-pin" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path
        d="M10.3 1.8 14.2 5.7l-1.4.5-2.6 2.6.3 3.2-1.3 1.3-2.6-2.6L3 14.3l-.9.1-.1-.9 3.6-3.6L3 7.3 4.3 6l3.2.3 2.6-2.6.2-1.9Z"
        fill="currentColor"
      />
    </svg>
  );
}

function BranchGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4.5" cy="12.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11.5" cy="5.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M4.5 5.1v5.8M11.5 7.1c0 2.4-2.6 2.9-5.6 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    "arrow-down": <path d="M12 5v14m-5-5 5 5 5-5" />,
    "arrow-right": <path d="M5 12h14m-5-5 5 5-5 5" />,
    "arrow-up": <path d="M12 19V5m-6 6 6-6 6 6" />,
    at: (
      <>
        <circle cx="12" cy="12" r="3.6" />
        <path d="M15.6 12v1.4a2.6 2.6 0 0 0 5.2 0V12a8.8 8.8 0 1 0-3.4 7" />
      </>
    ),
    activity: <path d="M3 12h4l2.5-6 5 12 2.5-6H21" />,
    maximize: <path d="M15 4h5v5M9 20H4v-5M20 4l-6.5 6.5M4 20l6.5-6.5" />,
    minimize: <path d="M14 10h5.5M14 10V4.5M10 14H4.5M10 14v5.5M14 10l6-6M10 14l-6 6" />,
    search: (
      <>
        <circle cx="11" cy="11" r="6.5" />
        <path d="m20 20-4.4-4.4" />
      </>
    ),
    board: (
      <>
        <rect x="5" y="4" width="14" height="17" rx="2" />
        <path d="M9 3h6v3H9zM9 11h6M9 15h4" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </>
    ),
    close: <path d="m6 6 12 12M18 6 6 18" />,
    copy: (
      <>
        <rect x="8" y="8" width="11" height="11" rx="2" />
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
      </>
    ),
    external: (
      <path d="M14 5h5v5m0-5-8 8M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    ),
    bell: <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2H4.5L6 16Zm4 4a2 2 0 0 0 4 0" />,
    undo: <path d="M9 14 4 9l5-5M4 9h9.5a6.5 6.5 0 0 1 0 13H11" />,
    hash: <path d="M9 4 7 20M17 4l-2 16M4 9h17M3 15h17" />,
    logout: <path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4m5-4 3-3-3-3m3 3H9" />,
    more: <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth="2.6" />,
    "panel-left": (
      <>
        <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
        <path d="M9.5 4.5v15" />
      </>
    ),
    "panel-right": (
      <>
        <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
        <path d="M14.5 4.5v15" />
      </>
    ),
    plug: <path d="M8 3v4m8-4v4M6 7h12v2a6 6 0 0 1-6 6v0a6 6 0 0 1-6-6V7Zm6 8v6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    send: <path d="m21 3-7.4 18-3.7-7.9L2 9.4 21 3Zm-11.1 10.1L14 9" />,
    share: <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13" />,
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.96 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.08A1.7 1.7 0 0 0 4.6 8.96a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 10 3.08V3h4v.08a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
      </>
    ),
    shield: <path d="M12 3 5 6v5c0 4.6 2.9 8 7 10 4.1-2 7-5.4 7-10V6l-7-3Zm-3 9 2 2 4-4" />,
    message: <path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 3.5V6a1 1 0 0 1 1-1z" />,
    "user-plus": (
      <>
        <circle cx="10" cy="8" r="3.5" />
        <path d="M3.5 20a6.5 6.5 0 0 1 13 0M19 8v6m3-3h-6" />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.8M16.5 14a5 5 0 0 1 4 5" />
      </>
    ),
  };

  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

const themeOptions: Array<{ value: ThemePreference; label: string }> = localized(() => [
  { value: "dark", label: t("深色") },
  { value: "system", label: t("自动") },
  { value: "light", label: t("浅色") },
]);

function ThemeGlyph({ theme }: { theme: ThemePreference }) {
  if (theme === "dark") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20.3 14.6A7.7 7.7 0 0 1 9.4 3.7 8.4 8.4 0 1 0 20.3 14.6Z" />
      </svg>
    );
  }
  if (theme === "system") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20.5 12a8.5 8.5 0 1 1-2.1-5.6M18.7 3.8v3.4h-3.4M12 7.2V12l3 1.8" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3.8" />
      <path d="M12 2.8v2.1M12 19.1v2.1M4.1 4.1l1.5 1.5M18.4 18.4l1.5 1.5M2.8 12h2.1M19.1 12h2.1M4.1 19.9l1.5-1.5M18.4 5.6l1.5-1.5" />
    </svg>
  );
}

function ThemeSwitcher({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (value: ThemePreference) => void;
}) {
  const currentLabel = themeOptions.find((option) => option.value === value)?.label ?? t("自动");
  return (
    <div
      className={`theme-switcher ${value}`}
      role="radiogroup"
      aria-label={t("颜色主题")}
      title={t("当前：{0}", { 0: currentLabel })}
    >
      <span className="theme-switcher-indicator" aria-hidden="true" />
      {themeOptions.map((option) => (
        <button
          type="button"
          role="radio"
          aria-checked={value === option.value}
          aria-label={option.label}
          title={option.label}
          className={value === option.value ? "active" : ""}
          onClick={() => onChange(option.value)}
          key={option.value}
        >
          <ThemeGlyph theme={option.value} />
        </button>
      ))}
    </div>
  );
}

function HiveLogo({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`hive-logo ${compact ? "compact" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 48 48" width="40" height="40" fill="none">
        <path d="m24 3 18 10.5v21L24 45 6 34.5v-21L24 3Z" />
        <path d="m24 12 10 6v12l-10 6-10-6V18l10-6Z" />
        <circle cx="24" cy="24" r="2.75" />
      </svg>
    </span>
  );
}

function participantStatusLabel(status: Participant["status"]): string {
  if (status === "online") return t("在线");
  if (status === "busy") return t("正在处理");
  return t("离线");
}

function agentProviderLabel(provider?: string): string {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude Code";
  if (provider === "copilot") return "GitHub Copilot";
  if (provider === "openclaw") return "OpenClaw";
  if (provider === "opencode") return "OpenCode";
  if (provider === "omp") return "omp";
  if (provider === "echo") return "Echo";
  return provider || "Agent";
}

function agentCommandFor(
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

function moveRadioSelection(
  event: ReactKeyboardEvent<HTMLElement>,
  checkedIndex: number,
  select: (index: number) => void,
): void {
  const delta =
    event.key === "ArrowDown" || event.key === "ArrowRight"
      ? 1
      : event.key === "ArrowUp" || event.key === "ArrowLeft"
        ? -1
        : 0;
  if (!delta) return;
  event.preventDefault();
  const radios = event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
  const next = (checkedIndex + delta + radios.length) % radios.length;
  select(next);
  radios[next]?.focus();
}

export function serverBase(): string {
  return resolveServerBase({
    configured: import.meta.env.VITE_HIVE_SERVER as string | undefined,
    development: import.meta.env.DEV,
    protocol: window.location.protocol,
    hostname: window.location.hostname,
    origin: window.location.origin,
  });
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

const messageGroupWindowMs = 5 * 60_000;

type TimelineEntry = { message: ChatMessage; newDay: boolean; grouped: boolean };

function buildTimeline(messages: ChatMessage[]): TimelineEntry[] {
  return messages.map((message, index) => {
    const previous = messages[index - 1];
    const newDay =
      !previous ||
      new Date(previous.createdAt).toDateString() !== new Date(message.createdAt).toDateString();
    const grouped =
      !newDay &&
      previous !== undefined &&
      previous.senderId === message.senderId &&
      new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() <
        messageGroupWindowMs;
    return { message, newDay, grouped };
  });
}

function dateDividerLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return t("今天");
  if (date.toDateString() === yesterday.toDateString()) return t("昨天");
  return date.toLocaleDateString(getLocale(), { year: "numeric", month: "long", day: "numeric" });
}

function avatarHue(name: string): number {
  let hash = 0;
  for (const char of name.toLocaleLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }
  return hash;
}

/** 头像内容：Agent 显示厂商标识（未知厂商回退为 "AI"），人类显示名字首字母 */
function AvatarGlyph({ type, name, provider }: { type: string; name: string; provider?: string }) {
  if (type !== "agent") return <>{name.slice(0, 1).toUpperCase()}</>;
  const logo = providerLogoName(provider);
  return logo ? <ProviderLogo provider={logo} /> : <>AI</>;
}

function avatarHueStyle(name: string): CSSProperties {
  return { "--avatar-hue": avatarHue(name) } as CSSProperties;
}

/**
 * 输入框随内容长高：平时最多约窗口高度的 40%（至少 176px），展开后最多约 70%；
 * 超出才出现滚动条。
 */
function composerMaxHeight(expanded: boolean): number {
  const viewport = typeof window === "undefined" ? 800 : window.innerHeight;
  return Math.round(Math.max(176, viewport * (expanded ? 0.7 : 0.4)));
}

/** 展开后直接变高（约半屏），不用等写满才看得出变化 */
function composerMinHeight(expanded: boolean): number {
  if (!expanded) return 54;
  const viewport = typeof window === "undefined" ? 800 : window.innerHeight;
  return Math.round(Math.max(176, viewport * 0.5));
}

function resizeComposer(textarea: HTMLTextAreaElement, expanded = false): void {
  const max = composerMaxHeight(expanded);
  textarea.style.maxHeight = `${max}px`;
  textarea.style.height = "0px";
  const nextHeight = Math.min(max, Math.max(composerMinHeight(expanded), textarea.scrollHeight));
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > max ? "auto" : "hidden";
}

function SettingsSwitch({
  checked,
  disabled = false,
  label,
  description,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  description: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="settings-switch-row"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <i className="switch-control" aria-hidden="true">
        <b />
      </i>
    </button>
  );
}

/** 侧栏小月亮的悬停说明 */
function keepAwakeSummary(state: KeepAwakeState): string {
  if (state.status === "failed") {
    return t("熄屏后保持在线没有生效：{0}", { 0: state.detail ?? t("原因未知") });
  }
  return t("熄屏后保持在线：{0}，正在阻止系统睡眠（屏幕照常熄灭）", {
    0: state.reasons.join(t("、")),
  });
}

const keepAwakeStatusText: Record<KeepAwakeState["status"], string> = localized(() => ({
  active: t("正在阻止系统睡眠"),
  idle: t("现在不需要保持（没有符合条件的 IM 连接或任务），电脑会照常睡眠"),
  battery: t("正在用电池，已暂停保持在线"),
  disabled: t("已关闭，电脑会照常睡眠"),
  unsupported: t("当前系统暂不支持，请在系统电源设置里关闭自动睡眠"),
  failed: t("没有生效"),
}));

/**
 * 房主在其他设备上：查看直接可用；要启动 Agent、改设置先申请管理权，经飞书或 Server 所在电脑批准。
 * compact 用在接入面板里，只留一行说明和按钮
 */
export function HostManageNotice({
  local,
  compact = false,
}: {
  local: LocalAgentsState;
  compact?: boolean;
}) {
  const [error, setError] = useState<string>();
  if (!local.enabled || local.mode !== "device") return null;
  const host = local.hostLabel ?? t("Server 所在电脑");
  if (local.canManage) {
    if (compact) return null;
    return (
      <p className="host-manage-notice granted" role="status">
        {t(
          "这台设备已获准管理 {0}，到 {1} 为止。启动的 Agent 和 MCP 可能在没有沙箱的情况下执行命令；只有用完全权限启动时会再逐次确认。",
          {
            0: host,
            1: new Date(local.manageUntil ?? "").toLocaleString(),
          },
        )}
      </p>
    );
  }
  const waiting = local.waitingApproval?.kind === "manage";
  return (
    <div className="host-manage-notice" role="status">
      <p>
        {waiting
          ? local.approvalVia === "im"
            ? t("已发出申请，请在飞书里点「允许」，或到 {0} 上批准。", { 0: host })
            : t("已发出申请，请到 {0} 上打开 SuperHive 批准。", { 0: host })
          : t(
              "你在另一台设备上，可以查看 {0} 上的 Agent 和目录。要启动、停止 Agent 或修改设置，先申请管理权（批准后 12 小时内有效）。获批后启动的 Agent 和 MCP 可能在没有沙箱的情况下执行命令。",
              { 0: host },
            )}
      </p>
      {!waiting && (
        <button
          type="button"
          className="settings-action"
          onClick={() => {
            setError(undefined);
            local.requestManage().catch((reason: unknown) => {
              setError(reason instanceof Error ? reason.message : String(reason));
            });
          }}
        >
          {t("申请管理这台电脑")}
        </button>
      )}
      {error && <p className="settings-note error">{error}</p>}
    </div>
  );
}

/** 本机页面：其他设备发来的申请，直接在这里批准或拒绝 */
function HostApprovalsBanner({ local }: { local: LocalAgentsState }) {
  const [error, setError] = useState<string>();
  if (local.mode !== "local" || local.approvals.length === 0) return null;
  return (
    <div className="host-approvals-banner" role="alertdialog" aria-label={t("待批准的申请")}>
      {local.approvals.map((approval) => (
        <div key={approval.id} className="host-approval">
          <p>
            <strong>{t("需要你批准")}</strong>
            {approval.summary}
          </p>
          <small>{t("不是你本人在操作就拒绝，并在设置 → 已登录设备里全部退出。")}</small>
          <div className="host-approval-actions">
            <button
              type="button"
              className="primary"
              onClick={() => local.decideApproval(approval.id, true).catch(fail)}
            >
              {t("允许")}
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => local.decideApproval(approval.id, false).catch(fail)}
            >
              {t("拒绝")}
            </button>
          </div>
        </div>
      ))}
      {error && <p className="settings-note error">{error}</p>}
    </div>
  );
  function fail(reason: unknown) {
    setError(reason instanceof Error ? reason.message : String(reason));
  }
}

/** 设备上的单次操作在等批准：提示去哪里确认 */
function HostApprovalWaiting({ local }: { local: LocalAgentsState }) {
  const approval = local.waitingApproval;
  if (local.mode !== "device" || approval?.kind !== "action") return null;
  const host = local.hostLabel ?? t("Server 所在电脑");
  return (
    <div className="host-approvals-banner" role="status">
      <div className="host-approval">
        <p>
          <strong>{t("等你确认")}</strong>
          {approval.summary}
        </p>
        <small>
          {local.approvalVia === "im"
            ? t("请在飞书里点「允许」，或到 {0} 上批准；5 分钟内有效。", { 0: host })
            : t("请到 {0} 上打开 SuperHive 批准；5 分钟内有效。", { 0: host })}
        </small>
      </div>
    </div>
  );
}

function KeepAwakeSettingsGroup({ local }: { local: LocalAgentsState }) {
  const state = local.keepAwake;
  const [error, setError] = useState<string>();
  if (!local.enabled || !state) {
    return (
      <div className="settings-group">
        <p className="settings-note">
          {t(
            "只有在运行 Hive Server 的这台电脑上打开网页，或用扫码、飞书登录的房主设备，才能查看这些设置。",
          )}
        </p>
      </div>
    );
  }
  const disabled = !state.supported || !local.canManage;
  const change = (patch: Partial<KeepAwakeSettings>) => {
    setError(undefined);
    local.updateKeepAwake(patch).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };
  return (
    <div className="settings-group">
      <div className="settings-section-heading">
        <div>
          <h4>{t("熄屏后保持在线")}</h4>
          <p>
            {t(
              "屏幕照常熄灭，只是电脑不进入睡眠，飞书消息和 Agent 任务不会中断。只在下面勾选的情况下生效，其他时候照常睡眠。",
            )}
          </p>
        </div>
      </div>
      <SettingsSwitch
        checked={state.whenIm}
        disabled={disabled}
        label={t("连着 IM 时保持在线")}
        description={t("有飞书、微信连接（包括正在重连）时阻止系统睡眠")}
        onChange={(checked) => change({ whenIm: checked })}
      />
      <SettingsSwitch
        checked={state.whenTasks}
        disabled={disabled}
        label={t("Agent 执行任务时保持在线")}
        description={t("有任务正在执行时阻止系统睡眠，执行完就恢复")}
        onChange={(checked) => change({ whenTasks: checked })}
      />
      <SettingsSwitch
        checked={state.onBattery}
        disabled={disabled}
        label={t("用电池时也保持")}
        description={t("默认只在接电源时生效；打开后用电池也不睡眠，比较耗电")}
        onChange={(checked) => change({ onBattery: checked })}
      />
      <p className={`keep-awake-status ${state.status}`} role="status">
        <strong>{keepAwakeStatusText[state.status]}</strong>
        {state.status === "active" && state.reasons.length
          ? t("（{0}）", { 0: state.reasons.join(t("、")) })
          : ""}
        {state.status === "failed" && state.detail ? t("：{0}", { 0: state.detail }) : ""}
      </p>
      <p className="settings-note">
        {t(
          "合上笔记本盖子、手动睡眠仍会睡眠（接着电源和外接显示器时合盖除外）；Hive 重启升级的几秒里不保证。",
        )}
      </p>
      {error && <p className="settings-note error">{error}</p>}
    </div>
  );
}

/** 在其他设备上登录：二维码 / 一次性链接、已登录设备、复制总令牌 */
export function OwnerDevicesGroup({ local }: { local: LocalAgentsState }) {
  const [devices, setDevices] = useState<OwnerDevice[]>();
  const [pair, setPair] = useState<{ url: string; expiresAt: string; qrDataUrl: string }>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState<string>();
  const enabled = local.enabled;
  const { ownerDevices } = local;
  const refresh = useCallback(() => {
    ownerDevices().then(setDevices, () => setDevices(undefined));
  }, [ownerDevices]);
  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh]);
  // 二维码用过（多了一台设备）或到期就收起
  useEffect(() => {
    if (!pair) return;
    const timer = window.setInterval(() => {
      if (Date.parse(pair.expiresAt) <= Date.now()) setPair(undefined);
      refresh();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [pair, refresh]);
  if (!enabled) return null;
  const fail = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : String(reason));
  const copy = (text: string, label: string) => {
    void copyTextToClipboard(text).then(() => {
      setCopied(label);
      window.setTimeout(() => setCopied(undefined), 1_500);
    }, fail);
  };
  return (
    <div className="settings-group">
      <div className="settings-section-heading">
        <div>
          <h4>{t("在其他设备上登录")}</h4>
          <p>
            {t(
              "手机或另一台电脑扫码（或打开链接）后，直接以房主身份进入，不用填令牌。每台设备单独登录，可以随时退出。飞书卡片上的「在网页查看」也会自动登录。",
            )}
          </p>
        </div>
      </div>
      {local.mode === "device" ? null : pair ? (
        <div className="owner-pair">
          <img src={pair.qrDataUrl} alt={t("登录二维码")} width={160} height={160} />
          <div>
            <p>
              {t(
                "用手机相机或飞书扫码，5 分钟内有效，只能用一次。设备要和这台电脑在同一个网络里。",
              )}
            </p>
            <code className="owner-pair-url">{pair.url}</code>
            <div className="owner-pair-actions">
              <button type="button" onClick={() => copy(pair.url, "link")}>
                {copied === "link" ? t("已复制") : t("复制链接")}
              </button>
              <button type="button" onClick={() => setPair(undefined)}>
                {t("收起")}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="settings-action"
          onClick={() => {
            setError(undefined);
            local.pairOwnerDevice().then(setPair, fail);
          }}
        >
          {t("显示登录二维码")}
        </button>
      )}
      <h4 className="owner-devices-heading">{t("已登录的设备")}</h4>
      {devices?.length ? (
        <ul className="owner-devices">
          {devices.map((device) => (
            <li key={device.id}>
              <span>
                <strong>
                  {device.name}
                  {device.id === local.deviceId ? t("（这台）") : ""}
                </strong>
                <small>
                  {t("{0}登录 · 最近活跃 {1}", {
                    0: device.source === "im" ? t("经飞书卡片") : t("扫码"),
                    1: new Date(device.lastSeenAt).toLocaleString(),
                  })}
                </small>
              </span>
              {(device.id === local.deviceId || local.canManage) && (
                <button
                  type="button"
                  onClick={() => local.revokeOwnerDevice(device.id).then(refresh, fail)}
                >
                  {t("退出登录")}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-note">{t("还没有其他设备登录。")}</p>
      )}
      {local.canManage &&
        (devices?.filter((device) => device.id !== local.deviceId).length ?? 0) > 0 && (
          <button
            type="button"
            className="settings-action danger"
            onClick={() => {
              if (!window.confirm(t("退出其他所有已登录的设备？手机丢了或怀疑被盗用时用。")))
                return;
              local.revokeAllOwnerDevices().then(refresh, fail);
            }}
          >
            {local.mode === "device" ? t("退出其他所有设备") : t("全部退出")}
          </button>
        )}
      {local.mode === "local" && <HostApproversGroup local={local} onError={fail} />}
      {local.mode === "local" && (
        <details className="owner-token-details">
          <summary>{t("房主接入令牌（高级）")}</summary>
          <p className="settings-note">
            {t(
              "这是房主的总钥匙，有完整权限，只在接入远程 Agent 或扫码不方便时使用，不要发给别人。",
            )}
          </p>
          <button
            type="button"
            className="settings-action"
            onClick={() => local.ownerToken().then((token) => copy(token, "token"), fail)}
          >
            {copied === "token" ? t("已复制") : t("复制令牌")}
          </button>
        </details>
      )}
      {error && <p className="settings-note error">{error}</p>}
    </div>
  );
}

/** 本机：哪些 IM 账号可以在卡片上批准其他设备管理这台电脑 */
function HostApproversGroup({
  local,
  onError,
}: {
  local: LocalAgentsState;
  onError: (reason: unknown) => void;
}) {
  const [approvers, setApprovers] = useState<HostApprover[]>();
  const { hostApprovers } = local;
  useEffect(() => {
    hostApprovers().then(setApprovers, () => setApprovers(undefined));
  }, [hostApprovers]);
  if (!approvers?.length) return null;
  return (
    <>
      <h4 className="owner-devices-heading">{t("在 IM 里批准")}</h4>
      <p className="settings-note">
        {t(
          "其他设备申请管理这台电脑（启动 Agent、改设置）时，把批准卡推到这些账号。在这台电脑上扫码连接的会自动勾上。",
        )}
      </p>
      {approvers.map((approver) => (
        <SettingsSwitch
          key={approver.connectionId}
          checked={approver.allowed}
          label={approver.label}
          description={
            approver.channel === "feishu"
              ? t("飞书")
              : t("微信（不支持卡片，申请只能在这台电脑上批准）")
          }
          onChange={(checked) =>
            local.setHostApprover(approver.connectionId, checked).then(setApprovers, onError)
          }
        />
      ))}
    </>
  );
}

function LoginDialog({ onJoin }: { onJoin: (username: string) => void }) {
  const [username, setUsername] = useState(localStorage.getItem(storedUsernameKey) ?? "");
  return (
    <div className="login-shell">
      <main className="login-card">
        <section className="login-intro">
          <div className="login-brand">
            <HiveLogo />
            <strong>SuperHive</strong>
          </div>
          <div className="login-thesis">
            <h1>
              {t("让人类与 Agent，")}
              <span>{t("沿着同一条思路工作。")}</span>
            </h1>
            <p>{t("把消息、协作者与本地 Agent 放进一个实时工作区，所有人都看见同一份上下文。")}</p>
          </div>
          <div className="signal-map" aria-hidden="true">
            <span className="signal-node human">RD</span>
            <span className="signal-node agent">AI</span>
            <span className="signal-node agent secondary">AI</span>
            <p>{t("3 位协作者 · 同一条实时对话")}</p>
          </div>
        </section>

        <section className="login-form-panel">
          <div className="login-form-heading">
            <h2>{t("进入 SuperHive")}</h2>
            <p className="login-copy">{t("选择一个在当前房间中可识别的名字。")}</p>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const clean = username.trim();
              if (clean) onJoin(clean);
            }}
          >
            <label htmlFor="username">{t("你的用户名")}</label>
            <input
              id="username"
              name="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              maxLength={32}
              pattern="[A-Za-z0-9_.\-\u4e00-\u9fff]+"
              placeholder={t("例如 rongding…")}
              autoComplete="username"
              spellCheck={false}
            />
            <button type="submit">
              <span>{t("进入聊天室")}</span>
              <Icon name="arrow-right" />
            </button>
          </form>
          <p className="fine-print">{t("支持中英文、数字、点、下划线与连字符。")}</p>
          <div className="login-trust">
            <Icon name="shield" size={16} />
            <span>{t("仅在局域网内共享，Agent 权限留在本机。")}</span>
          </div>
        </section>
      </main>
    </div>
  );
}

/** 纯文本输入框背后的高亮层与输入框排版一致：在它里面找到第 offset 个字符，量出它在屏幕上的横坐标 */
function highlightOffsetX(layer: HTMLElement | null, offset: number): number | undefined {
  if (!layer) return undefined;
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.setEnd(node, Math.min(remaining + 1, length));
      // jsdom 等环境没有排版信息，量不到就让面板照旧靠左
      if (typeof range.getBoundingClientRect !== "function") return undefined;
      const rect = range.getBoundingClientRect();
      return rect.width || rect.left ? rect.left : undefined;
    }
    remaining -= length;
  }
  return undefined;
}

export function App({
  guest,
  ownerToken,
  onAccessLost,
}: {
  /** 凭限时邀请进入的访客：只能在这个房间、以这个名字活动 */
  guest?: GuestAccess;
  /** 远程房主手动填入的共享接入令牌；本机房主不需要 */
  ownerToken?: string;
  onAccessLost?: (reason: "expired" | "revoked") => void;
} = {}) {
  // 语言切换后整棵界面重新渲染，t() 取到新语言
  const locale = useLocale();
  const localePreference = getLocalePreference();
  const [meta, setMeta] = useState<MetaResponse>();
  // 第一次打开（本机还没有昵称）的标成待引导；必须在读昵称之前判断
  const [onboardingWanted, setOnboardingWanted] = useState(() => {
    if (guest) return false;
    markOnboardingIfNew(localStorage, storedUsernameKey);
    return onboardingPending(localStorage);
  });
  const [onboardingOpen, setOnboardingOpen] = useState(true);
  const [imConnected, setImConnected] = useState(false);
  const [username, setUsername] = useState(
    () => guest?.username ?? localStorage.getItem(storedUsernameKey) ?? "",
  );
  const [currentRoomId, setCurrentRoomId] = useState(() => guest?.roomId ?? initialRoomId());
  // 访客用兑换得到的会话令牌；房主用共享 join token（只在 Server 所在电脑或填入令牌时拿得到）
  const authToken = meta?.joinToken ?? guest?.token;
  const isOwner = Boolean(meta?.joinToken);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [imDialogOpen, setImDialogOpen] = useState(false);
  const [guestAgentDialogOpen, setGuestAgentDialogOpen] = useState(false);
  const [accessNow, setAccessNow] = useState(() => Date.now());
  useEffect(() => {
    // 成员列表的剩余时间每分钟刷新一次
    const timer = window.setInterval(() => setAccessNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [readSeqs, setReadSeqs] = useState<Record<string, number>>({});
  const [showArchivedRooms, setShowArchivedRooms] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  // 消息本身不带 provider：按发送者名到成员表里查，离开房间的 Agent 回退为 "AI"
  const agentProviderByName = useMemo(
    () =>
      new Map(
        participants
          .filter((participant) => participant.type === "agent")
          .map((participant) => [participant.username.toLocaleLowerCase(), participant.provider]),
      ),
    [participants],
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // 收到房间快照之前为 false：区分"还在加载"和"房间真的是空的"，避免欢迎页闪现
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [invocations, setInvocations] = useState<ReadonlyMap<string, Invocation>>(new Map());
  const [whiteboard, setWhiteboard] = useState<ReadonlyMap<string, WhiteboardEntry>>(new Map());
  const whiteboardEpochRef = useRef(0);
  const whiteboardChangesRef = useRef(new Map<string, number>());
  const [schedules, setSchedules] = useState<ReadonlyMap<string, Schedule>>(new Map());
  /** 还在等人批的权限申请（提问消息 ID） */
  const [pendingApprovals, setPendingApprovals] = useState<ReadonlySet<string>>(new Set());
  /**
   * 调用的实时过程（房主和获准看过程的访客的页面会收到）。结束后在这个页面里留着，
   * 刷新或切换房间就没了；服务端不保存。
   */
  const [traces, setTraces] = useState<ReadonlyMap<string, TraceStep[]>>(new Map());
  /** 收到过结束标记的调用：同一个调用重试时重新开始记，不和上一次的步骤混在一起 */
  const endedTracesRef = useRef(new Set<string>());
  const [sidePanelTab, setSidePanelTab] = useState<SidePanelTab>("members");
  const [highlightedMessageId, setHighlightedMessageId] = useState<string>();
  const [pendingJumpId, setPendingJumpId] = useState<string>();
  // 跨房间入口：搜索、提及我、Agent 任务
  const [activityView, setActivityView] = useState<ActivityView>();
  const [gotoOpen, setGotoOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // 房间列表、成员列表的右键菜单
  const [contextMenu, setContextMenu] = useState<ContextMenuState>();
  // Agent 之间的委派、回执默认收成一行；点开的记在这里
  const [openMachineIds, setOpenMachineIds] = useState<ReadonlySet<string>>(new Set());
  const agentNames = useMemo(
    () =>
      new Set(
        participants
          .filter((participant) => participant.type === "agent")
          .map((participant) => participant.username.toLocaleLowerCase()),
      ),
    [participants],
  );
  const isMachine = (message: ChatMessage) =>
    isMachineMessage(message, (name) => agentNames.has(name.toLocaleLowerCase()));
  const closeContextMenu = useCallback(() => setContextMenu(undefined), []);
  const [mentionMessages, setMentionMessages] = useState<ChatMessage[]>([]);
  // 正在回答的 Agent 提问；发送时作为 replyToMessageId
  const [answering, setAnswering] = useState<ChatMessage>();
  // 已点选提交、等服务端确认的提问 ID → 幂等键（重发沿用同一个键，只续接一次）
  const [pendingAnswers, setPendingAnswers] = useState<ReadonlyMap<string, string>>(new Map());
  const [activeInvocations, setActiveInvocations] = useState<ReadonlyMap<string, Invocation>>(
    new Map(),
  );
  const [invocationMessages, setInvocationMessages] = useState<ReadonlyMap<string, ChatMessage>>(
    new Map(),
  );
  // 切换语言：已经收到的消息、任务、定时按新语言重新显示服务端写的文字
  useEffect(() => {
    const relocalize = <T,>(map: ReadonlyMap<string, T>) =>
      new Map([...map].map(([id, value]) => [id, localizeServerPayload(value)]));
    setMessages((current) => localizeServerPayload(current));
    setInvocations(relocalize);
    setActiveInvocations(relocalize);
    setSchedules(relocalize);
    setInvocationMessages(relocalize);
  }, [locale]);
  // 切换房间后待定位的消息（在新房间快照到达后再滚动过去）
  const [crossRoomJumpId, setCrossRoomJumpId] = useState<string>();
  const [onlineInvocationIds, setOnlineInvocationIds] = useState<ReadonlySet<string>>(new Set());
  const activityTriggerRef = useRef<HTMLElement | null>(null);
  const attentionRef = useRef<ReturnType<typeof useAttention> | undefined>(undefined);
  const globalEventsRef = useRef<{
    onInvocation: (invocation: Invocation) => void;
    onRoomActivity: () => void;
    onSnapshot: () => void;
  }>({
    onInvocation: () => undefined,
    onRoomActivity: () => undefined,
    onSnapshot: () => undefined,
  });
  const [draft, setDraft] = useState(() => {
    const storedUsername = localStorage.getItem(storedUsernameKey) ?? "";
    return storedUsername && storedBoolean(storedAutoSaveDraftKey, true)
      ? (localStorage.getItem(draftStorageKey(storedUsername, initialRoomId())) ?? "")
      : "";
  });
  const [mentionContext, setMentionContext] = useState<MentionContext>();
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [connectionState, setConnectionState] = useState<"connecting" | "online" | "offline">(
    "connecting",
  );
  const [error, setError] = useState<string>();
  const [commandCopied, setCommandCopied] = useState(false);
  const [copyError, setCopyError] = useState<string>();
  const [agentProvider, setAgentProvider] = useState<SelectableAgentProvider>("codex");
  // 默认工作区档：只读什么都改不了，接进来基本没用；完全访问每次都要明确选
  const [agentAccess, setAgentAccess] = useState<AgentAccessMode>("workspace");
  // 第一步先让人选 Agent，选了才能下一步（不默认替人选一个）
  const [agentProviderChosen, setAgentProviderChosen] = useState(false);
  // 真的启动了或复制了命令才显示「完成」，免得第 3 步点了「完成」却什么也没发生
  const [agentConnected, setAgentConnected] = useState(false);
  const [agentStep, setAgentStep] = useState<AgentSetupStep>(1);
  const [fullAccessConfirmationOpen, setFullAccessConfirmationOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>();
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [roomDialog, setRoomDialog] = useState<
    { mode: "create" } | { mode: "manage"; room: RoomSummary }
  >();
  const [roomDialogId, setRoomDialogId] = useState("");
  const [roomDialogName, setRoomDialogName] = useState("");
  const [roomDialogWorkspace, setRoomDialogWorkspace] = useState("");
  const [roomDialogLead, setRoomDialogLead] = useState("");
  const [roomWorkspacePicking, setRoomWorkspacePicking] = useState(false);
  const [roomDialogError, setRoomDialogError] = useState<string>();
  const [roomDialogBusy, setRoomDialogBusy] = useState(false);
  const [worktreeNotices, setWorktreeNotices] = useState<
    Map<string, { batchId: string; count: number }>
  >(new Map());
  const worktreeNoticeVersion = useRef(0);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearWhiteboard, setClearWhiteboard] = useState(true);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuHoverTimer = useRef<number | undefined>(undefined);
  const [pendingNewMessages, setPendingNewMessages] = useState(0);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [shadowHost, setShadowHost] = useState<HTMLDivElement | null>(null);
  const [scrollContentElement, setScrollContentElement] = useState<HTMLDivElement | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string>();
  const [recallCandidateId, setRecallCandidateId] = useState<string>();
  const [shareMode, setShareMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<ReadonlySet<string>>(new Set());
  const [shareBusy, setShareBusy] = useState(false);
  const [shareFeedback, setShareFeedback] = useState<string>();
  const shareCardRef = useRef<HTMLDivElement>(null);
  const selectedMessages = useMemo(
    () => messages.filter((message) => selectedMessageIds.has(message.id) && !message.deletedAt),
    [messages, selectedMessageIds],
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("chat");
  const [sendShortcut, setSendShortcut] = useState<SendShortcut>(storedSendShortcut);
  const [autoSaveDraft, setAutoSaveDraft] = useState(() =>
    storedBoolean(storedAutoSaveDraftKey, true),
  );
  /** 输入框边写边渲染 Markdown；关掉就是纯文本输入框 + 预览。单元测试里默认关（jsdom 跑不了编辑器的选区） */
  const [richComposer, setRichComposer] = useState(() =>
    storedBoolean(storedRichComposerKey, import.meta.env.MODE !== "test"),
  );
  const [timeFormat, setTimeFormat] = useState<TimeFormat>(() =>
    storedChoice(storedTimeFormatKey, ["system", "24h", "12h"], "system"),
  );
  const [messageNotifications, setMessageNotifications] = useState<MessageNotificationMode>(
    storedMessageNotificationMode,
  );
  const [notificationSound, setNotificationSound] = useState(() =>
    storedBoolean(storedNotificationSoundKey, false),
  );
  const [presenceNotifications, setPresenceNotifications] = useState(() =>
    storedBoolean(storedPresenceNotificationsKey, false),
  );
  const [attentionDelivery, setAttentionDelivery] = useState<AttentionDelivery>(() =>
    storedChoice(storedAttentionDeliveryKey, ["system", "page", "off"], "system"),
  );
  const [attentionSound, setAttentionSound] = useState(() =>
    storedBoolean(storedAttentionSoundKey, true),
  );
  const [attentionGroup, setAttentionGroup] = useState(() =>
    storedBoolean(storedAttentionGroupKey, true),
  );
  const [notificationPermission, setNotificationPermission] =
    useState<BrowserNotificationPermission>(browserNotificationPermission);
  const [notificationPromptDismissed, setNotificationPromptDismissed] = useState(() =>
    storedBoolean(storedNotificationPromptDismissedKey, false),
  );
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    storedChoice(storedThemeKey, ["system", "dark", "light"], "system"),
  );
  const [interfaceDensity, setInterfaceDensity] = useState<InterfaceDensity>(() =>
    storedChoice(storedDensityKey, ["comfortable", "compact"], "comfortable"),
  );
  const [threadWidth, setThreadWidth] = useState<ThreadWidth>(() =>
    storedChoice(storedThreadWidthKey, ["standard", "wide", "full"], "wide"),
  );
  const [membersCollapsed, setMembersCollapsed] = useState(() =>
    storedBoolean(storedMembersCollapsedKey, false),
  );
  const [roomsCollapsed, setRoomsCollapsed] = useState(() =>
    storedBoolean(storedRoomsCollapsedKey, false),
  );
  const [messageSize, setMessageSize] = useState<MessageSize>(() =>
    storedChoice(storedMessageSizeKey, ["small", "standard", "large"], "standard"),
  );
  const [reduceMotion, setReduceMotion] = useState(() =>
    storedBoolean(storedReduceMotionKey, false),
  );
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const retryRef = useRef(0);
  const latestSeqRef = useRef(0);
  const composingRef = useRef(false);
  const draftContextRef = useRef(`${username}:${initialRoomId()}`);
  const participantStatusRef = useRef(new Map<string, Participant["status"]>());
  const notificationPreferencesRef = useRef({
    messageNotifications,
    notificationSound,
    presenceNotifications,
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageScrollContentRef = useRef<HTMLDivElement>(null);
  const bottomAnimationRef = useRef(0);
  const detachAnimationCancelRef = useRef<(() => void) | undefined>(undefined);
  const messageListRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const messageCountRef = useRef(0);
  /** 纯文本模式下就是 textarea 本身；所见即所得模式下是编辑器给的同名方法 */
  const textareaRef = useRef<ComposerHandle | null>(null);
  /** 输入框：预览 Markdown 效果、展开成大输入框 */
  const [composerPreview, setComposerPreview] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  /** 打开或刷新页面后，输入框出现时自动聚焦一次（触屏不聚焦，免得一进来就弹出键盘） */
  const composerAutoFocused = useRef(false);
  const attachComposer = useCallback((element: ComposerHandle | null) => {
    textareaRef.current = element;
    if (!element || composerAutoFocused.current) return;
    composerAutoFocused.current = true;
    if (window.matchMedia?.("(hover: none)").matches) return;
    window.requestAnimationFrame(() => {
      // 已经有别的地方拿到焦点（弹窗、搜索框）就不抢
      const active = document.activeElement;
      if (active && active !== document.body) return;
      // 所见即所得编辑器加载完会顶替先挂上的纯文本输入框，聚焦当下的那个
      textareaRef.current?.focus({ preventScroll: true });
    });
  }, []);
  const browsingHistoryRef = useRef<string | undefined>(undefined);
  const highlightRef = useRef<HTMLDivElement>(null);
  const membersCloseRef = useRef<HTMLButtonElement>(null);
  const roomsCloseRef = useRef<HTMLButtonElement>(null);
  const agentDialogRef = useRef<HTMLDivElement>(null);
  const agentDialogCloseRef = useRef<HTMLButtonElement>(null);
  const agentDialogTriggerRef = useRef<HTMLButtonElement>(null);
  const agentStepHeadingRef = useRef<HTMLHeadingElement>(null);
  const fullAccessOptionRef = useRef<HTMLButtonElement>(null);
  const roomDialogRef = useRef<HTMLDivElement>(null);
  const roomDialogCloseRef = useRef<HTMLButtonElement>(null);
  const roomDialogTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsDialogRef = useRef<HTMLDivElement>(null);
  const settingsCloseRef = useRef<HTMLButtonElement>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const lastPanelTriggerRef = useRef<HTMLButtonElement>(null);
  const base = useMemo(serverBase, []);
  const attachmentQueue = useAttachmentQueue({ base, token: authToken, roomId: currentRoomId });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<string>();
  const [dragActive, setDragActive] = useState(false);
  function addAttachments(files: File[]) {
    if (files.length === 0) return;
    setAttachmentNotice(attachmentQueue.add(files));
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }
  // Hive Server 就在这台电脑上时，可以直接在网页上拉起 Agent
  const local = useLocalAgents(base, agentDialogOpen, authToken);
  // 「Agent 运行时」只给页面开在 Server 所在电脑上的本机房主
  const visibleSettingsTabs = settingsTabs.filter(
    (tab) => tab.id !== "runtimes" || local.mode === "local",
  );
  useEffect(() => {
    if (!isOwner || !local.enabled) return;
    let cancelled = false;
    const refresh = () => {
      const version = worktreeNoticeVersion.current;
      void local
        .worktrees(currentRoomId)
        .then((inventory) => {
          if (cancelled || version !== worktreeNoticeVersion.current) return;
          setWorktreeNotices((current) => {
            const next = new Map(current);
            if (inventory.cleanupBatch)
              next.set(currentRoomId, {
                batchId: inventory.cleanupBatch.id,
                count: inventory.cleanupBatch.count,
              });
            else next.delete(currentRoomId);
            return next;
          });
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [currentRoomId, isOwner, local.enabled, local.worktrees]);
  const localAgentNames = useMemo(
    () => new Set(local.agents.map((agent) => agent.name.toLocaleLowerCase())),
    [local.agents],
  );
  const [settingsAgentId, setSettingsAgentId] = useState<string | undefined>();
  /** 「换个模型重试」正在选模型的那条调用 */
  const [retryModelFor, setRetryModelFor] = useState<Invocation | undefined>();
  const retryModelAgent = retryModelFor ? localAgentFor(retryModelFor.agentName) : undefined;
  const settingsAgent = local.agents.find((agent) => agent.id === settingsAgentId);
  function localAgentFor(name: string) {
    const key = name.toLocaleLowerCase();
    return local.agents.find((agent) => agent.name.toLocaleLowerCase() === key);
  }
  /** 本机 Agent 名字旁的设置入口（悬停成员行时出现）；写成函数而非组件，避免每次渲染重建按钮 */
  function agentSettingsButton(name: string) {
    const agent = localAgentFor(name);
    if (!agent) return null;
    return (
      <span className="guest-actions">
        <button
          type="button"
          className="guest-actions-trigger agent-settings-trigger"
          aria-label={t("{0} 的设置", { 0: agent.name })}
          title={t("设置（重启、停止、MCP 等）")}
          onClick={(event) => {
            event.stopPropagation();
            setSettingsAgentId(agent.id);
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <SettingsGlyph />
        </button>
      </span>
    );
  }
  const modifierKeyLabel = useMemo(platformModifierLabel, []);
  // 两侧栏可拖宽：默认宽度即最小宽度，记在本机
  const { widths: panelWidths, resize: resizePanel } = usePanelWidths();
  const recentMentions = useMemo(
    () => recentMentionOrder(messages, username),
    [messages, username],
  );
  const mentionSuggestions = useMemo(
    () =>
      mentionContext
        ? filterMentionParticipants(
            participants,
            mentionContext.query,
            username,
            undefined,
            recentMentions,
            mentionContext.attached,
          )
        : [],
    [mentionContext, participants, username, recentMentions],
  );
  // 候选面板贴着 @ 的位置弹出（输入框很宽时不用把视线挪回最左边）；靠右时往回收，不超出输入区
  const mentionMenuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = mentionMenuRef.current;
    const parent = menu?.offsetParent as HTMLElement | null | undefined;
    if (!menu || !parent) return;
    const anchorX = mentionContext?.anchorX;
    if (anchorX === undefined) {
      menu.style.left = "";
      return;
    }
    const room = parent.clientWidth - menu.offsetWidth;
    const left = anchorX - parent.getBoundingClientRect().left - 12;
    menu.style.left = `${Math.max(0, Math.min(left, room))}px`;
  }, [mentionContext]);
  // 点输入框和面板以外的地方就收起面板
  useEffect(() => {
    if (!mentionContext) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".mention-menu, .composer-box")) return;
      setMentionContext(undefined);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [mentionContext]);
  const activeMentionId = mentionSuggestions[activeMentionIndex]?.id;
  useEffect(() => {
    if (!activeMentionId) return;
    document
      .getElementById(`mention-option-${activeMentionId}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeMentionId]);
  // 接入默认名要避开房间现有成员（含离线）：服务端按房间大小写不敏感查重，撞名直接 409
  const takenAgentNames = useMemo(
    () => new Set(participants.map((participant) => participant.username.toLocaleLowerCase())),
    [participants],
  );
  const selectedAgentCommand = useMemo(() => {
    if (!meta) return t("加载中…");
    return agentCommandFor(meta, agentProvider, username, agentAccess, takenAgentNames);
  }, [agentAccess, agentProvider, meta, takenAgentNames, username]);
  const showNotificationPrompt =
    messageNotifications !== "off" &&
    notificationPermission === "default" &&
    !notificationPromptDismissed;
  const currentRoom = useMemo(
    () => rooms.find((room) => room.id === currentRoomId),
    [currentRoomId, rooms],
  );
  const currentRoomName = currentRoom?.name ?? currentRoomId;
  const currentRoomWorkspace = currentRoom?.workspace;
  const isLeadAgent = (participant: Participant) =>
    participant.type === "agent" &&
    currentRoom?.leadAgent?.toLocaleLowerCase() === participant.username.toLocaleLowerCase();
  // 主 Agent 被删掉后服务端不再派给它：输入框不再这么提示
  const currentLeadAgent = participants.find(isLeadAgent)?.username;
  // 房间顺序：置顶的在最前（顺序存在服务端，跟着房主走），其余按最近活跃倒序。
  // 鼠标停在列表上或焦点在列表里时，不置顶区暂停重排，免得正要点的房间被新消息顶走
  const [roomListFrozen, setRoomListFrozen] = useState<string[]>();
  const sidebarRooms = useMemo(() => {
    const sorted = sortRoomsForSidebar(
      rooms
        .filter((room) => showArchivedRooms || !room.archivedAt)
        // 访客看不到房主的置顶
        .map((room) =>
          isOwner || room.pinned === undefined ? room : { ...room, pinned: undefined },
        ),
    );
    return roomListFrozen
      ? { pinned: sorted.pinned, others: orderRooms(sorted.others, roomListFrozen) }
      : sorted;
  }, [isOwner, roomListFrozen, rooms, showArchivedRooms]);
  const pinnedRoomIds = useMemo(
    () => sidebarRooms.pinned.map((room) => room.id),
    [sidebarRooms.pinned],
  );
  const freezeRoomList = () =>
    setRoomListFrozen((current) => current ?? sidebarRooms.others.map((room) => room.id));
  const thawRoomList = (element: HTMLElement) => {
    if (element.matches(":hover") || element.contains(document.activeElement)) return;
    setRoomListFrozen(undefined);
  };
  const refreshRoomsRef = useRef<() => Promise<unknown>>(undefined);
  /** 整份写回置顶列表：先在本地改好，服务端确认后会广播新的房间摘要 */
  const savePinnedRooms = useCallback(
    (next: string[]) => {
      const index = new Map(next.map((id, position) => [id, position]));
      setRooms((current) =>
        current.map((room) => {
          const pinned = index.get(room.id);
          if (pinned === room.pinned) return room;
          const { pinned: _old, ...rest } = room;
          void _old;
          return pinned === undefined ? rest : { ...rest, pinned };
        }),
      );
      void fetch(`${base}/api/room-pins`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ roomIds: next }),
      })
        .then(async (response) => {
          if (!response.ok) {
            const failure: unknown = await response.json().catch(() => ({}));
            throw new Error(
              serverError(failure) ?? t("置顶没保存上（{0}）", { 0: response.status }),
            );
          }
        })
        .catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
          // 没存上就以服务端为准重新拉一遍
          void refreshRoomsRef.current?.().catch(() => undefined);
        });
    },
    [authToken, base],
  );
  // 拖动和 Alt+↑/↓ 只在置顶区里排序
  const roomReorder = useRoomReorder(pinnedRoomIds, savePinnedRooms);
  useEffect(() => {
    try {
      localStorage.removeItem(storedRoomOrderKey);
    } catch {
      // 清不掉也无妨：已经不再读取
    }
  }, []);
  const activeRoomCount = useMemo(() => rooms.filter((room) => !room.archivedAt).length, [rooms]);
  // 渲染窗口：只挂载最近的一段消息，重房间切换时的同步提交成本与内存尖峰被限定为常量；
  // 更早的消息按需点击展开（数据仍全量在 messages 中，仅渲染被窗口化）
  const [visibleLimit, setVisibleLimit] = useState(25);
  // 默认只显示当前话题（最近一条话题分隔之后）；更早的话题折叠，按需展开。
  // 展开状态绑定到分隔消息本身：开启新话题或切换房间后自动重新折叠
  const [expandedTopicId, setExpandedTopicId] = useState<string>();
  const currentTopic = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]!.kind === "topic") return { index, id: messages[index]!.id };
    }
    return undefined;
  }, [messages]);
  const earlierTopicCount =
    currentTopic && expandedTopicId !== currentTopic.id ? currentTopic.index : 0;
  const topicMessages = useMemo(
    () => (earlierTopicCount > 0 ? messages.slice(earlierTopicCount) : messages),
    [messages, earlierTopicCount],
  );
  const hiddenCount = Math.max(0, topicMessages.length - visibleLimit);
  const timeline = useMemo(
    () => buildTimeline(hiddenCount > 0 ? topicMessages.slice(-visibleLimit) : topicMessages),
    [topicMessages, visibleLimit, hiddenCount],
  );
  // 点「显示更早」把更早的消息插到上方：浏览器在贴顶（scrollTop=0，正是按钮的位置）时
  // 不会做滚动锚定，视口会落到插入内容的最顶部、读的位置被顶走。这里在点击瞬间记下
  // 「视口到内容底部的距离」（新消息只往上方插入，底部不动），渲染完成后按该距离恢复
  // scrollTop，正在读的内容保持在原位。jumpToMessage 也会扩大窗口，但它要滚到目标消息，不经过这里。
  const earlierScrollAnchorRef = useRef<number | undefined>(undefined);
  const captureScrollAnchor = () => {
    const list = messageListRef.current;
    earlierScrollAnchorRef.current = list
      ? Math.max(0, list.scrollHeight - list.scrollTop)
      : undefined;
  };
  useLayoutEffect(() => {
    const distance = earlierScrollAnchorRef.current;
    if (distance === undefined) return;
    earlierScrollAnchorRef.current = undefined;
    const list = messageListRef.current;
    if (list && typeof list.scrollTo === "function")
      list.scrollTo({ top: Math.max(0, list.scrollHeight - distance), behavior: "instant" });
  }, [timeline]);
  const invocationsByMessage = useMemo(() => groupInvocationsByMessage(invocations), [invocations]);
  /** 回复消息 → 产生它的那次调用：回复上方显示这一轮过程的回顾 */
  const invocationByReply = useMemo(() => {
    const byReply = new Map<string, Invocation>();
    for (const invocation of invocations.values()) {
      if (invocation.replyMessageId) byReply.set(invocation.replyMessageId, invocation);
    }
    return byReply;
  }, [invocations]);
  // 点选提交的答案按提问归档，用来在提问上高亮所选；先到的一条生效
  const choiceAnswers = useMemo(() => {
    const answers = new Map<string, QuestionAnswer>();
    for (const message of messages) {
      if (message.answer && !message.deletedAt && !answers.has(message.answer.questionMessageId)) {
        answers.set(message.answer.questionMessageId, message.answer);
      }
    }
    return answers;
  }, [messages]);
  const pausedInvocations = useMemo(
    () => currentPausedInvocations(invocations.values(), messages),
    [invocations, messages],
  );
  const whiteboardBlockedCount = useMemo(
    () =>
      [...whiteboard.values()].filter((entry) => !entry.archivedAt && entry.slot === "blocked")
        .length,
    [whiteboard],
  );
  const whiteboardCurrentCount = useMemo(
    () => [...whiteboard.values()].filter((entry) => !entry.archivedAt).length,
    [whiteboard],
  );
  const pausedAgentNames = useMemo(
    () => [...new Set(pausedInvocations.map((invocation) => `@${invocation.agentName}`))],
    [pausedInvocations],
  );
  const loadedMessageIds = useMemo(
    () => new Set(messages.filter((message) => !message.deletedAt).map((message) => message.id)),
    [messages],
  );
  const formatMessageTime = useCallback(
    (iso: string) =>
      new Date(iso).toLocaleTimeString(getLocale(), {
        hour: "2-digit",
        minute: "2-digit",
        ...(timeFormat === "system" ? {} : { hour12: timeFormat === "12h" }),
      }),
    [timeFormat],
  );

  useEffect(() => {
    notificationPreferencesRef.current = {
      messageNotifications,
      notificationSound,
      presenceNotifications,
    };
  }, [messageNotifications, notificationSound, presenceNotifications]);

  useEffect(() => {
    if (notificationPermission !== "denied" && notificationPermission !== "unsupported") return;
    setMessageNotifications("off");
    setPresenceNotifications(false);
    localStorage.setItem(storedMessageNotificationsKey, "off");
    localStorage.setItem(storedPresenceNotificationsKey, "false");
  }, [notificationPermission]);

  useEffect(() => {
    const contextKey = `${username}:${currentRoomId}`;
    if (draftContextRef.current !== contextKey) {
      draftContextRef.current = contextKey;
      browsingHistoryRef.current = undefined;
      setDraft(
        username && autoSaveDraft
          ? (localStorage.getItem(draftStorageKey(username, currentRoomId)) ?? "")
          : "",
      );
      setMentionContext(undefined);
    }
  }, [autoSaveDraft, currentRoomId, username]);

  useEffect(() => {
    if (!username || !autoSaveDraft || draftContextRef.current !== `${username}:${currentRoomId}`) {
      return;
    }
    const key = draftStorageKey(username, currentRoomId);
    // 方向键翻到的旧消息没改过就不算草稿，刷新后不该留在输入框里
    if (draft && draft !== browsingHistoryRef.current) localStorage.setItem(key, draft);
    else localStorage.removeItem(key);
  }, [autoSaveDraft, currentRoomId, draft, username]);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      root.dataset.theme =
        themePreference === "system" ? (media?.matches ? "dark" : "light") : themePreference;
    };
    applyTheme();
    media?.addEventListener?.("change", applyTheme);
    return () => media?.removeEventListener?.("change", applyTheme);
  }, [themePreference]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.density = interfaceDensity;
    root.dataset.threadWidth = threadWidth;
    root.dataset.messageSize = messageSize;
    root.dataset.reduceMotion = String(reduceMotion);
  }, [interfaceDensity, messageSize, reduceMotion, threadWidth]);

  useEffect(() => {
    fetch(
      `${base}/api/meta`,
      ownerToken ? { headers: { Authorization: `Bearer ${ownerToken}` } } : undefined,
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        return (await response.json()) as MetaResponse;
      })
      .then(setMeta)
      .catch((reason: unknown) => {
        setConnectionState("offline");
        setError(
          t("无法连接 Hive Server。请确认服务已启动并检查网络：{0}", {
            0: reason instanceof Error ? reason.message : String(reason),
          }),
        );
      });
  }, [base, ownerToken]);

  // 自绘滚动动画：每帧重读底部目标位置，消息异步变高（Markdown 渲染、content-visibility
  // 惰性布局）也能追踪并精确落底；原生 scrollIntoView({behavior:"smooth"}) 的目标在调用
  // 瞬间就固定了，内容随后变高会导致停在半路
  const scrollToBottom = useCallback((animated: boolean) => {
    cancelAnimationFrame(bottomAnimationRef.current);
    bottomAnimationRef.current = 0;
    detachAnimationCancelRef.current?.();
    setShowJumpToBottom(false);
    const list = messageListRef.current;
    if (!list || typeof list.scrollTo !== "function") return;
    nearBottomRef.current = true;
    const reduceMotion = document.documentElement.dataset.reduceMotion === "true";
    if (!animated || reduceMotion) {
      list.scrollTo({ top: list.scrollHeight, behavior: "instant" });
      return;
    }
    const startY = list.scrollTop;
    const initialDistance = Math.abs(list.scrollHeight - list.clientHeight - startY);
    if (initialDistance < 2) return;
    // 时长随距离自适应：短距离（一条新消息）从容一些，长距离（刷新进入）也不至于拖沓；
    // 长距离用慢起步的 ease-in-out——起步柔和可避开首屏渲染高峰，也不会高速冲进未布局区域
    const duration = Math.min(1100, Math.max(550, 260 + initialDistance * 0.45));
    const easing = initialDistance > list.clientHeight * 1.5 ? easeInOutCubic : easeOutQuint;
    // 进度按实际播放过的帧时间累计而不是墙钟：主线程被长任务卡住后，恢复的第一帧不会把
    // 落下的进度一次补上（实测曾冻住 528ms 后一帧跳 1800px），只会让动画放慢
    const clock = createFrameClock(MAX_FRAME_STEP_MS);
    // 用户主动滚动（滚轮/触摸板/触屏）时动画立即让位：既是正确的交互，也避免动画与用户
    // 输入每帧互抢 scrollTop 引发布局风暴（实测该冲突可导致渲染进程崩溃）
    const detach = () => {
      detachAnimationCancelRef.current = undefined;
      list.removeEventListener("wheel", stopForUserInput);
      list.removeEventListener("touchstart", stopForUserInput);
    };
    const stopForUserInput = () => {
      cancelAnimationFrame(bottomAnimationRef.current);
      bottomAnimationRef.current = 0;
      detach();
      nearBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    };
    detachAnimationCancelRef.current = detach;
    list.addEventListener("wheel", stopForUserInput, { passive: true });
    list.addEventListener("touchstart", stopForUserInput, { passive: true });
    const step = (now: number) => {
      const target = list.scrollHeight - list.clientHeight;
      const progress = Math.min(1, clock(now) / duration);
      const eased = easing(progress);
      list.scrollTo({ top: startY + (target - startY) * eased, behavior: "instant" });
      if (progress < 1) {
        bottomAnimationRef.current = requestAnimationFrame(step);
      } else {
        bottomAnimationRef.current = 0;
        detach();
      }
    };
    bottomAnimationRef.current = requestAnimationFrame(step);
  }, []);

  useLayoutEffect(() => {
    const previousCount = messageCountRef.current;
    messageCountRef.current = messages.length;
    const last = messages.at(-1);
    if (!last) return;
    const own = last.senderName.toLocaleLowerCase() === username.toLocaleLowerCase();
    if (nearBottomRef.current || own) {
      setPendingNewMessages(0);
      // 首屏（刷新、切换房间）：在首帧绘制前直接定位到底部，和 Slack / ChatGPT 打开会话一样，
      // 不从顶部播动画——那段动画正好落在启动渲染高峰里，任何长任务都会让它冻住再跳。
      // 随后 Markdown 替换占位导致的高度变化由下方 ResizeObserver 继续贴底
      scrollToBottom(previousCount !== 0);
    } else if (messages.length > previousCount) {
      setPendingNewMessages((current) => current + (messages.length - previousCount));
    }
    return undefined;
  }, [messages, username, scrollToBottom]);

  const handleMessageListScroll = useCallback(() => {
    // 动画进行中的 scroll 事件是程序驱动的，不代表用户离开了底部
    if (bottomAnimationRef.current) return;
    const list = messageListRef.current;
    if (!list) return;
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    const nearBottom = distance < 120;
    nearBottomRef.current = nearBottom;
    if (nearBottom) setPendingNewMessages(0);
    setShowJumpToBottom(distance > 320);
  }, []);

  // 读者在底部附近点「展开全文」：内容变高时不能被贴底逻辑拉到底，停在原处继续读。
  // 之后滚回底部时 handleMessageListScroll 会恢复贴底
  const releaseBottomPin = useCallback(() => {
    cancelAnimationFrame(bottomAnimationRef.current);
    bottomAnimationRef.current = 0;
    detachAnimationCancelRef.current?.();
    nearBottomRef.current = false;
  }, []);

  const jumpToLatest = useCallback(() => {
    setPendingNewMessages(0);
    scrollToBottom(true);
  }, [scrollToBottom]);

  // 消息内容异步变高（懒加载的 Markdown 渲染、图片等）时，若用户本就在底部附近则保持贴底。
  // 内容节点在 shadow root 中经 portal 挂载，比首次 commit 晚一拍，因此用 state 驱动附着时机
  useEffect(() => {
    const list = messageListRef.current;
    if (!list || !scrollContentElement || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (bottomAnimationRef.current || !nearBottomRef.current) return;
      const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
      if (distance > 1) {
        list.scrollTo({ top: list.scrollHeight, behavior: "instant" });
      }
    });
    observer.observe(scrollContentElement);
    return () => observer.disconnect();
  }, [scrollContentElement]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    resizeComposer(textarea, composerExpanded);
    if (highlightRef.current) highlightRef.current.scrollTop = textarea.scrollTop;
  }, [draft, username, composerExpanded, composerPreview, richComposer]);
  // 窗口大小变了，输入框的最高高度跟着变
  useEffect(() => {
    const onResize = () => {
      const textarea = textareaRef.current;
      if (textarea instanceof HTMLTextAreaElement) resizeComposer(textarea, composerExpanded);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [composerExpanded]);

  const closeMobilePanel = useCallback((restoreFocus = true) => {
    setMobilePanel(undefined);
    if (restoreFocus) {
      window.requestAnimationFrame(() => lastPanelTriggerRef.current?.focus());
    }
  }, []);

  const openMobilePanel = useCallback((panel: MobilePanel, trigger: HTMLButtonElement) => {
    lastPanelTriggerRef.current = trigger;
    setMobilePanel(panel);
  }, []);

  useEffect(() => {
    if (!mobilePanel) return;
    window.requestAnimationFrame(() => {
      if (mobilePanel === "members") membersCloseRef.current?.focus();
      if (mobilePanel === "rooms") roomsCloseRef.current?.focus();
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMobilePanel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeMobilePanel, mobilePanel]);

  const closeAgentDialog = useCallback(() => {
    setAgentDialogOpen(false);
    setFullAccessConfirmationOpen(false);
    window.requestAnimationFrame(() => agentDialogTriggerRef.current?.focus());
  }, []);

  const openAgentDialog = useCallback((trigger: HTMLButtonElement) => {
    agentDialogTriggerRef.current = trigger;
    setAgentStep(1);
    setAgentProviderChosen(false);
    setAgentConnected(false);
    // 完全访问不跨次保留：每次打开都要重新明确选择最高权限
    setAgentAccess((current) => (current === "full" ? "workspace" : current));
    setCommandCopied(false);
    setCopyError(undefined);
    setAgentDialogOpen(true);
  }, []);

  const goToAgentStep = useCallback((step: AgentSetupStep) => {
    setAgentStep(step);
    setFullAccessConfirmationOpen(false);
    setCommandCopied(false);
    setCopyError(undefined);
    window.requestAnimationFrame(() => agentStepHeadingRef.current?.focus());
  }, []);

  const chooseAgentAccess = useCallback(
    (access: AgentAccessMode) => {
      if (access === "full" && agentAccess !== "full") {
        setFullAccessConfirmationOpen(true);
        return;
      }
      setFullAccessConfirmationOpen(false);
      setAgentAccess(access);
    },
    [agentAccess],
  );

  const closeFullAccessConfirmation = useCallback(() => {
    setFullAccessConfirmationOpen(false);
    fullAccessOptionRef.current?.focus();
  }, []);

  const confirmFullAccess = useCallback(() => {
    setAgentAccess("full");
    setFullAccessConfirmationOpen(false);
    fullAccessOptionRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!agentDialogOpen) return;
    window.requestAnimationFrame(() => agentDialogCloseRef.current?.focus());

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeAgentDialog();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = agentDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], details, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleDialogKeyDown);
    return () => window.removeEventListener("keydown", handleDialogKeyDown);
  }, [agentDialogOpen, closeAgentDialog]);

  const closeRoomDialog = useCallback(() => {
    setRoomDialog(undefined);
    setArchiveConfirmOpen(false);
    setClearConfirmOpen(false);
    window.requestAnimationFrame(() => roomDialogTriggerRef.current?.focus());
  }, []);

  const openRoomDialog = useCallback(
    (
      dialog: { mode: "create" } | { mode: "manage"; room: RoomSummary },
      trigger: HTMLButtonElement,
    ) => {
      roomDialogTriggerRef.current = trigger;
      setRoomDialogError(undefined);
      setArchiveConfirmOpen(false);
      setClearConfirmOpen(false);
      setRoomDialogId(dialog.mode === "manage" ? dialog.room.id : "");
      setRoomDialogName(dialog.mode === "manage" ? dialog.room.name : "");
      setRoomDialogWorkspace(dialog.mode === "manage" ? (dialog.room.workspace ?? "") : "");
      setRoomDialogLead(dialog.mode === "manage" ? (dialog.room.leadAgent ?? "") : "");
      setRoomWorkspacePicking(false);
      setRoomDialog(dialog);
    },
    [],
  );

  useEffect(() => {
    if (!roomDialog) return;
    window.requestAnimationFrame(() => roomDialogCloseRef.current?.focus());

    const handleRoomDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRoomDialog();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = roomDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleRoomDialogKeyDown);
    return () => window.removeEventListener("keydown", handleRoomDialogKeyDown);
  }, [closeRoomDialog, roomDialog]);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    window.requestAnimationFrame(() => settingsTriggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!userMenuOpen) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!userMenuRef.current?.contains(event.target as Node)) setUserMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setUserMenuOpen(false);
        settingsTriggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [userMenuOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    window.requestAnimationFrame(() => settingsCloseRef.current?.focus());

    const handleSettingsKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSettings();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = settingsDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleSettingsKeyDown);
    return () => window.removeEventListener("keydown", handleSettingsKeyDown);
  }, [closeSettings, settingsOpen]);

  const markRoomRead = useCallback((roomId: string) => {
    const seq = latestSeqRef.current;
    if (seq <= 0) return;
    const stored = Number(localStorage.getItem(readSeqStorageKey(roomId)) ?? "0");
    if (seq > stored) localStorage.setItem(readSeqStorageKey(roomId), String(seq));
    setReadSeqs((current) =>
      (current[roomId] ?? 0) >= seq ? current : { ...current, [roomId]: seq },
    );
  }, []);

  const upsertRoom = useCallback((room: RoomSummary) => {
    setRooms((current) =>
      sortRooms([...current.filter((existing) => existing.id !== room.id), room]),
    );
  }, []);

  const switchRoom = useCallback(
    (roomId: string) => {
      if (roomId === currentRoomId) return;
      // 访客只能待在被邀请的房间
      if (guest && roomId !== guest.roomId) return;
      markRoomRead(currentRoomId);
      setMessages([]);
      setMessagesLoaded(false);
      setInvocations(new Map());
      setWhiteboard(new Map());
      whiteboardEpochRef.current += 1;
      whiteboardChangesRef.current.clear();
      setSchedules(new Map());
      setPendingApprovals(new Set());
      setTraces(new Map());
      setHighlightedMessageId(undefined);
      setPendingJumpId(undefined);
      setParticipants([]);
      participantStatusRef.current = new Map();
      latestSeqRef.current = 0;
      retryRef.current = 0;
      messageCountRef.current = 0;
      nearBottomRef.current = true;
      setPendingNewMessages(0);
      setError(undefined);
      setMentionContext(undefined);
      setVisibleLimit(25);
      setShowJumpToBottom(false);
      setCurrentRoomId(roomId);
      closeMobilePanel(false);
    },
    [closeMobilePanel, currentRoomId, markRoomRead],
  );

  useEffect(() => {
    localStorage.setItem(storedRoomKey, currentRoomId);
    if (roomIdFromHash() === currentRoomId) return;
    window.history.replaceState(window.history.state, "", `#${currentRoomId}`);
  }, [currentRoomId]);

  useEffect(() => {
    const handleHashChange = () => {
      const roomId = roomIdFromHash();
      if (roomId) switchRoom(roomId);
      else window.history.replaceState(window.history.state, "", `#${currentRoomId}`);
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [currentRoomId, switchRoom]);

  const refreshRooms = useCallback(async () => {
    if (!meta || !authToken) return;
    const response = await fetch(`${base}/api/rooms?includeArchived=true`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!response.ok) throw new Error(t("房间列表拉取失败 ({0})", { 0: response.status }));
    const payload = (await response.json()) as RoomsResponse;
    setRooms(sortRooms(payload.rooms));
    setReadSeqs((current) => {
      const next = { ...current };
      for (const room of payload.rooms) {
        if (next[room.id] === undefined) {
          next[room.id] = Number(localStorage.getItem(readSeqStorageKey(room.id)) ?? "0");
        }
      }
      return next;
    });
  }, [authToken, base, meta]);
  refreshRoomsRef.current = refreshRooms;

  useEffect(() => {
    if (!meta || !username) return;
    void refreshRooms().catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [meta, refreshRooms, username]);

  useEffect(() => {
    if (messages.length > 0) markRoomRead(currentRoomId);
  }, [currentRoomId, markRoomRead, messages]);

  const catchUp = useCallback(
    async (afterSeq: number) => {
      if (!meta || !authToken || afterSeq <= 0) return;
      const response = await fetch(
        `${base}/api/rooms/${encodeURIComponent(currentRoomId)}/messages?afterSeq=${afterSeq}`,
        { headers: { Authorization: `Bearer ${authToken}` } },
      );
      if (!response.ok) throw new Error(t("增量消息拉取失败 ({0})", { 0: response.status }));
      const payload = localizeServerPayload((await response.json()) as MessagesResponse);
      setMessages((current) => mergeMessages(current, payload.messages));
      latestSeqRef.current = Math.max(latestSeqRef.current, payload.latestSeq);
    },
    [authToken, base, currentRoomId, meta],
  );

  useEffect(() => {
    if (!meta || !username || !authToken) return;
    let cancelled = false;
    let reconnectAllowed = true;

    const connect = () => {
      if (cancelled) return;
      setConnectionState("connecting");
      const socket = new WebSocket(
        resolveWebSocketUrl({
          serverBase: base,
          development: import.meta.env.DEV,
          advertisedUrl: meta.wsUrl,
        }),
      );
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            type: "participant.join",
            username,
            participantType: "human",
            roomId: currentRoomId,
            token: authToken,
          }),
        );
      });
      socket.addEventListener("message", (rawEvent) => {
        const event = localizeServerPayload(JSON.parse(String(rawEvent.data)) as ServerEvent);
        if (event.type === "room.snapshot") {
          const beforeReconnect = latestSeqRef.current;
          participantStatusRef.current = new Map(
            event.participants.map((participant) => [participant.id, participant.status]),
          );
          setParticipants(sortParticipantsByLastSeen(event.participants));
          setMessages((current) => mergeMessages(current, event.messages));
          setMessagesLoaded(true);
          // 快照里的调用与白板是服务端当前全集，直接替换（重连期间的变化也一并对齐）
          setInvocations(
            new Map((event.invocations ?? []).map((invocation) => [invocation.id, invocation])),
          );
          setWhiteboard(new Map((event.whiteboard ?? []).map((entry) => [entry.id, entry])));
          whiteboardEpochRef.current += 1;
          whiteboardChangesRef.current.clear();
          setSchedules(new Map((event.schedules ?? []).map((schedule) => [schedule.id, schedule])));
          setPendingApprovals(new Set(event.approvals ?? []));
          // 重连后服务端会重新补发执行中调用的过程；已经结束的留着汇总
          {
            const live = new Set(
              (event.invocations ?? [])
                .filter((invocation) => isLiveInvocation(invocation))
                .map((invocation) => invocation.id),
            );
            setTraces(
              (current) =>
                new Map([...current].filter(([invocationId]) => !live.has(invocationId))),
            );
          }
          latestSeqRef.current = Math.max(latestSeqRef.current, event.latestSeq);
          retryRef.current = 0;
          setConnectionState("online");
          setError(undefined);
          void refreshRooms().catch(() => undefined);
          globalEventsRef.current.onSnapshot();
          if (beforeReconnect > 0)
            void catchUp(beforeReconnect).catch((reason: unknown) => setError(String(reason)));
        } else if (event.type === "room.cleared") {
          if (event.message.roomId !== currentRoomId) return;
          if (event.whiteboardArchived) {
            whiteboardEpochRef.current += 1;
            setWhiteboard(
              (current) => new Map([...current].filter(([, entry]) => entry.archivedAt)),
            );
          }
          // 房主清空了房间：本地的消息和调用记录一并丢弃，只留清空后的话题分隔
          setMessages([event.message]);
          setInvocations(new Map());
          setPendingNewMessages(0);
          setRecallCandidateId(undefined);
          latestSeqRef.current = Math.max(latestSeqRef.current, event.message.seq);
        } else if (event.type === "message.deleted") {
          if (event.message.roomId !== currentRoomId) return;
          setMessages((current) => mergeMessages(current, [event.message]));
          setRecallCandidateId((current) => (current === event.message.id ? undefined : current));
        } else if (event.type === "message.created") {
          if (event.message.roomId !== currentRoomId) return;
          setMessages((current) => mergeMessages(current, [event.message]));
          // 新的权限申请：等人批，选项可点
          if (event.message.approval) {
            const approvalId = event.message.id;
            setPendingApprovals((current) => new Set(current).add(approvalId));
          }
          latestSeqRef.current = Math.max(latestSeqRef.current, event.message.seq);
          socket.send(JSON.stringify({ type: "message.ack", seq: event.message.seq }));
          if (event.message.senderName.toLocaleLowerCase() !== username.toLocaleLowerCase()) {
            const preferences = notificationPreferencesRef.current;
            if (preferences.notificationSound) playNotificationTone();
            const mentioned = event.message.mentions.some(
              (mention) => mention.toLocaleLowerCase() === username.toLocaleLowerCase(),
            );
            const shouldNotify =
              preferences.messageNotifications === "all" ||
              (preferences.messageNotifications === "mentions" && mentioned);
            if (shouldNotify && document.visibilityState !== "visible") {
              showBrowserNotification(
                mentioned
                  ? t("{0} 在 SuperHive 提到了你", { 0: event.message.senderName })
                  : `${event.message.senderName} · # ${event.message.roomId}`,
                event.message.content.slice(0, 180) ||
                  (event.message.attachments?.length
                    ? t("[{0} 个附件]", { 0: event.message.attachments.length })
                    : ""),
              );
            }
          }
        } else if (event.type === "worktree.cleanup") {
          worktreeNoticeVersion.current++;
          setWorktreeNotices((current) => {
            const next = new Map(current);
            if (event.state === "available")
              next.set(event.roomId, { batchId: event.batchId, count: event.count });
            else if (next.get(event.roomId)?.batchId === event.batchId) next.delete(event.roomId);
            return next;
          });
        } else if (event.type === "invocation.updated") {
          attentionRef.current?.observe(event.invocation);
          globalEventsRef.current.onInvocation(event.invocation);
          if (event.invocation.roomId !== currentRoomId) return;
          setInvocations((current) => upsertInvocation(current, event.invocation));
        } else if (event.type === "whiteboard.updated") {
          if (event.entry.roomId !== currentRoomId) return;
          whiteboardChangesRef.current.set(
            event.entry.id,
            (whiteboardChangesRef.current.get(event.entry.id) ?? 0) + 1,
          );
          setWhiteboard((current) => upsertWhiteboardEntry(current, event.entry));
        } else if (event.type === "invocation.trace") {
          if (event.roomId !== currentRoomId) return;
          const ended = endedTracesRef.current;
          const restarted = !event.ended && ended.delete(event.invocationId);
          if (event.ended) ended.add(event.invocationId);
          setTraces((current) => {
            const next = new Map(current);
            const previous = restarted ? [] : (current.get(event.invocationId) ?? []);
            const steps = mergeTraceSteps(previous, event.steps);
            if (steps.length) next.set(event.invocationId, steps);
            else next.delete(event.invocationId);
            // 结束后的汇总只留最近 50 个，页面开久了也不会越攒越多
            for (const invocationId of next.keys()) {
              if (next.size <= 50) break;
              if (ended.has(invocationId)) next.delete(invocationId);
            }
            return next;
          });
        } else if (event.type === "approval.updated") {
          if (event.roomId !== currentRoomId) return;
          setPendingApprovals((current) => {
            if (!current.has(event.messageId)) return current;
            const next = new Set(current);
            next.delete(event.messageId);
            return next;
          });
        } else if (event.type === "schedule.updated") {
          if (event.schedule.roomId !== currentRoomId) return;
          setSchedules((current) => upsertSchedule(current, event.schedule));
        } else if (event.type === "whiteboard.removed") {
          if (event.roomId !== currentRoomId) return;
          whiteboardChangesRef.current.set(
            event.entryId,
            (whiteboardChangesRef.current.get(event.entryId) ?? 0) + 1,
          );
          setWhiteboard((current) => {
            if (event.archivedEntry) return upsertWhiteboardEntry(current, event.archivedEntry);
            if (!current.has(event.entryId)) return current;
            const next = new Map(current);
            next.delete(event.entryId);
            return next;
          });
        } else if (event.type === "presence.changed") {
          const previousStatus = participantStatusRef.current.get(event.participant.id);
          participantStatusRef.current.set(event.participant.id, event.participant.status);
          setParticipants((current) => {
            const byId = new Map(current.map((participant) => [participant.id, participant]));
            byId.set(event.participant.id, event.participant);
            return sortParticipantsByLastSeen([...byId.values()]);
          });
          if (
            notificationPreferencesRef.current.presenceNotifications &&
            document.visibilityState !== "visible" &&
            event.participant.type === "agent" &&
            event.participant.username.toLocaleLowerCase() !== username.toLocaleLowerCase() &&
            (event.participant.status === "offline" ||
              (event.participant.status === "online" && previousStatus === "offline"))
          ) {
            showBrowserNotification(
              `${event.participant.username} ${event.participant.status === "online" ? t("已上线") : t("已离线")}`,
              `#${event.participant.roomId} · ${agentProviderLabel(event.participant.provider)}`,
            );
          }
        } else if (event.type === "rooms.changed") {
          upsertRoom(event.room);
          if (event.room.id === currentRoomId && event.room.archivedAt) {
            setError(t("房间 # {0} 已被归档，已切换回默认房间。", { 0: event.room.name }));
            switchRoom("general");
          }
        } else if (event.type === "room.activity") {
          globalEventsRef.current.onRoomActivity();
          setRooms((current) =>
            current.map((room) =>
              room.id === event.roomId
                ? {
                    ...room,
                    latestSeq: event.latestSeq,
                    onlineCount: event.onlineCount,
                    ...(event.lastActivityAt ? { lastActivityAt: event.lastActivityAt } : {}),
                  }
                : room,
            ),
          );
        } else if (event.type === "error") {
          if (event.code === "SESSION_EXPIRED" || event.code === "SESSION_REVOKED") {
            // 访问到期或被房主移除：不再重连，回到入口页给出原因
            reconnectAllowed = false;
            socket.close();
            onAccessLost?.(event.code === "SESSION_EXPIRED" ? "expired" : "revoked");
          } else if (event.code === "USERNAME_TAKEN") {
            reconnectAllowed = false;
            setConnectionState("offline");
            setError(
              t("用户名 {0} 已被同名 Agent 或其他身份占用，请点击右上角“退出”后更换用户名。", {
                0: username,
              }),
            );
            socket.close();
          } else if (event.code === "ROOM_ARCHIVED") {
            reconnectAllowed = false;
            setError(t("房间 # {0} 已归档，无法加入，已切换回默认房间。", { 0: currentRoomId }));
            socket.close();
            switchRoom("general");
          } else if (event.text) {
            // 新服务端：说明已经是结构化文案、按当前语言显示，比按错误码猜更准确
            if (
              event.code === "INVALID_ANSWER" ||
              event.code === "QUESTION_CLOSED" ||
              event.code === "QUESTION_NOT_FOUND" ||
              event.code === "ANSWER_FAILED"
            ) {
              setPendingAnswers(new Map());
            }
            setError(event.message);
          } else if (event.code === "FORBIDDEN") {
            // 旧服务端只发英文说明，按错误码给出中文提示
            setError(t("只能撤回自己发送的消息。"));
          } else if (event.code === "MESSAGE_NOT_FOUND" || event.code === "DELETE_FAILED") {
            setError(t("撤回失败：消息不存在或已被处理。"));
          } else if (event.code === "INVOCATION_NOT_RETRYABLE") {
            setError(t("这次调用当前无法重试：它可能已在进行中，或触发消息已被撤回。"));
          } else if (event.code === "INVOCATION_NOT_FOUND") {
            setError(t("找不到这次调用，它可能属于其他房间或已被清理。"));
          } else if (
            event.code === "INVALID_ANSWER" ||
            event.code === "QUESTION_CLOSED" ||
            event.code === "QUESTION_NOT_FOUND" ||
            event.code === "ANSWER_FAILED"
          ) {
            // 点选没被接受：放开选项让人重选，选择与输入保留在表单里
            setPendingAnswers(new Map());
            setError(event.message);
          } else {
            setError(event.message);
          }
        }
      });
      socket.addEventListener("close", () => {
        if (cancelled || !reconnectAllowed) return;
        setConnectionState("offline");
        const wait = Math.min(10_000, 500 * 2 ** retryRef.current++);
        reconnectTimerRef.current = window.setTimeout(connect, wait);
      });
      socket.addEventListener("error", () => socket.close());
    };

    connect();
    const heartbeat = window.setInterval(() => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "presence.heartbeat" }));
      }
    }, 15_000);

    return () => {
      cancelled = true;
      window.clearInterval(heartbeat);
      window.clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
    };
  }, [base, catchUp, currentRoomId, meta, refreshRooms, switchRoom, upsertRoom, username]);

  // 点击已完成的调用跳到 Agent 回复：等目标消息挂载（可能需要先扩大渲染窗口）后再滚动并短暂高亮
  useEffect(() => {
    if (!pendingJumpId) return;
    const list = messageListRef.current;
    const root = list?.shadowRoot ?? list;
    const target = root?.querySelector<HTMLElement>(`[data-message-id="${pendingJumpId}"]`);
    if (!target) return;
    setPendingJumpId(undefined);
    cancelAnimationFrame(bottomAnimationRef.current);
    bottomAnimationRef.current = 0;
    detachAnimationCancelRef.current?.();
    nearBottomRef.current = false;
    const reduce =
      document.documentElement.dataset.reduceMotion === "true" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    setHighlightedMessageId(pendingJumpId);
    const timer = window.setTimeout(
      () => setHighlightedMessageId((current) => (current === pendingJumpId ? undefined : current)),
      2200,
    );
    return () => window.clearTimeout(timer);
  }, [pendingJumpId, timeline]);

  const authorizedJson = useCallback(
    async <T,>(path: string): Promise<T> => {
      if (!meta || !authToken) throw new Error(t("尚未连接 Hive Server。"));
      const response = await fetch(`${base}${path}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!response.ok) throw new Error(t("请求失败 ({0})", { 0: response.status }));
      return localizeServerPayload((await response.json()) as T);
    },
    [base, meta],
  );

  const loadUsage = useCallback(
    (roomId: string, days: number, alertTokens: number) =>
      authorizedJson<UsageSummary>(
        `/api/rooms/${encodeURIComponent(roomId)}/usage?days=${days}&alert=${Math.round(alertTokens)}`,
      ),
    [authorizedJson],
  );

  const refreshMentions = useCallback(async () => {
    if (!username) return;
    const payload = await authorizedJson<{ messages: ChatMessage[] }>(
      `/api/mentions?username=${encodeURIComponent(username)}`,
    );
    setMentionMessages(payload.messages);
  }, [authorizedJson, username]);

  const refreshTasks = useCallback(async () => {
    const payload = await authorizedJson<{
      invocations: Invocation[];
      messages: ChatMessage[];
      onlineInvocationIds?: string[];
    }>("/api/invocations");
    setOnlineInvocationIds(new Set(payload.onlineInvocationIds ?? []));
    attentionRef.current?.seed(payload.invocations);
    setActiveInvocations(
      new Map(payload.invocations.map((invocation) => [invocation.id, invocation])),
    );
    setInvocationMessages(new Map(payload.messages.map((message) => [message.id, message])));
  }, [authorizedJson]);

  const searchMessages = useCallback(
    async (query: string) =>
      (
        await authorizedJson<{ messages: ChatMessage[] }>(
          `/api/search?q=${encodeURIComponent(query)}`,
        )
      ).messages,
    [authorizedJson],
  );

  // 跨房间数据随全局事件更新：调用状态直接合并，新的提及合并拉取（同一秒内多次活动只查一次）
  useEffect(() => {
    let mentionTimer: number | undefined;
    let taskTimer: number | undefined;
    const debounced = (timer: number | undefined, run: () => Promise<void>, delay: number) => {
      window.clearTimeout(timer);
      return window.setTimeout(() => void run().catch(() => undefined), delay);
    };
    globalEventsRef.current = {
      onInvocation: (invocation) => {
        setActiveInvocations((current) => {
          const next = new Map(current);
          if (isInFlight(invocation) || needsAttention(invocation))
            next.set(invocation.id, invocation);
          else next.delete(invocation.id);
          return next;
        });
        taskTimer = debounced(taskTimer, refreshTasks, 1_000);
      },
      onRoomActivity: () => {
        mentionTimer = debounced(mentionTimer, refreshMentions, 800);
      },
      onSnapshot: () => {
        void refreshMentions().catch(() => undefined);
        void refreshTasks().catch(() => undefined);
      },
    };
    return () => {
      window.clearTimeout(mentionTimer);
      window.clearTimeout(taskTimer);
    };
  }, [refreshMentions, refreshTasks]);

  const unreadMentionCount = useMemo(
    () =>
      mentionMessages.filter(
        (message) =>
          message.roomId !== currentRoomId && message.seq > (readSeqs[message.roomId] ?? 0),
      ).length,
    [currentRoomId, mentionMessages, readSeqs],
  );
  const taskCounts = useMemo(() => {
    let attention = 0;
    let inFlight = 0;
    for (const invocation of activeInvocations.values()) {
      if (needsAttention(invocation)) attention += 1;
      else if (isInFlight(invocation)) inFlight += 1;
    }
    return { attention, inFlight };
  }, [activeInvocations]);
  /** 每个房间正在跑、需要处理的任务数：房间列表右侧据此显示状态 */
  const roomTaskCounts = useMemo(() => {
    const counts = new Map<string, { attention: number; inFlight: number }>();
    for (const invocation of activeInvocations.values()) {
      const entry = counts.get(invocation.roomId) ?? { attention: 0, inFlight: 0 };
      if (needsAttention(invocation)) entry.attention += 1;
      else if (isInFlight(invocation)) entry.inFlight += 1;
      counts.set(invocation.roomId, entry);
    }
    return counts;
  }, [activeInvocations]);

  function openActivity(view: ActivityView, trigger?: HTMLElement | null) {
    activityTriggerRef.current = trigger ?? null;
    closeMobilePanel(false);
    setActivityView(view);
    if (view === "mentions") void refreshMentions().catch(() => undefined);
    if (view === "tasks") void refreshTasks().catch(() => undefined);
  }

  function closeActivity() {
    setActivityView(undefined);
    activityTriggerRef.current?.focus();
  }

  function markMentionsRead() {
    setReadSeqs((current) => {
      const next = { ...current };
      for (const message of mentionMessages) {
        if (message.seq > (next[message.roomId] ?? 0)) {
          next[message.roomId] = message.seq;
          localStorage.setItem(readSeqStorageKey(message.roomId), String(message.seq));
        }
      }
      return next;
    });
  }

  function openMessage(message: ChatMessage) {
    if (message.roomId === currentRoomId) {
      jumpToMessage(message.id);
      return;
    }
    setCrossRoomJumpId(message.id);
    switchRoom(message.roomId);
  }

  // 切到目标房间并拿到快照后再定位；不在最近加载的记录里时给出提示
  useEffect(() => {
    if (!crossRoomJumpId || messages.length === 0) return;
    setCrossRoomJumpId(undefined);
    if (messages.some((message) => message.id === crossRoomJumpId)) {
      jumpToMessage(crossRoomJumpId);
    } else {
      setError(t("这条消息较早，不在最近加载的记录里。"));
    }
  }, [crossRoomJumpId, messages]);

  // 全局快捷键：⌘K 搜索、⌘P 跳转、⌘J 下一个要处理的、? 或 ⌘/ 快捷键帮助（定义见 shortcuts.ts）
  const lastAttentionIdRef = useRef<string | undefined>(undefined);
  const [gotoNotice, setGotoNotice] = useState<string>();
  function jumpToNextAttention() {
    const items = attentionRef.current?.items ?? [];
    const next = nextAttention(items, lastAttentionIdRef.current);
    if (!next) {
      setGotoNotice(t("现在没有要你处理的任务。"));
      return;
    }
    lastAttentionIdRef.current = next.invocation.id;
    setGotoNotice(
      t("要处理的第 {0}/{1} 条 · @{2} · {3}", {
        0: items.indexOf(next) + 1,
        1: items.length,
        2: next.invocation.agentName,
        3: attentionLabels[next.kind],
      }),
    );
    attentionRef.current?.open(next.invocation);
  }
  useEffect(() => {
    if (!gotoNotice) return;
    const timer = window.setTimeout(() => setGotoNotice(undefined), 2_500);
    return () => window.clearTimeout(timer);
  }, [gotoNotice]);
  const shortcutActionsRef = useRef<Record<ShortcutId, () => void> | undefined>(undefined);
  shortcutActionsRef.current = {
    search: () => {
      setGotoOpen(false);
      setActivityView((current) => (current === "search" ? undefined : "search"));
    },
    goto: () => {
      setActivityView(undefined);
      setGotoOpen((open) => !open);
    },
    "next-attention": () => {
      setGotoOpen(false);
      jumpToNextAttention();
    },
    help: () => setShortcutsOpen((open) => !open),
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const id = matchShortcut(event);
      if (!id) return;
      // 单键 ? 不打断别的弹窗（它们自己处理按键）
      if (event.key === "?" && document.querySelector("dialog[open], [aria-modal='true']")) return;
      event.preventDefault();
      shortcutActionsRef.current?.[id]();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const roomNameOf = (roomId: string) => rooms.find((room) => room.id === roomId)?.name ?? roomId;
  const attention = useAttention({
    username,
    isOwner,
    currentRoomId,
    activeInvocations,
    preferences: { delivery: attentionDelivery, sound: attentionSound },
    roomName: roomNameOf,
    onOpen: ({ roomId, messageId }) => {
      if (roomId === currentRoomId) {
        jumpToMessage(messageId);
        return;
      }
      setCrossRoomJumpId(messageId);
      switchRoom(roomId);
    },
  });
  attentionRef.current = attention;

  // 标签页图标的小圆点和标题前缀：需要你处理 > 有任务在跑（你派的或当前房间的） > 做完未看。
  // 和侧栏标记一样是被动显示，不受「任务提醒」开关影响
  useFaviconBadge({
    attention: attention.items.filter((item) => item.kind !== "unseen").length,
    running: [...activeInvocations.values()].filter(
      (invocation) =>
        isInFlight(invocation) &&
        (invocation.roomId === currentRoomId || concernsMe(invocation, { username, isOwner })),
    ).length,
    unseen: [...attention.unseenByRoom.values()].reduce((sum, count) => sum + count, 0),
  });

  // 首次引导的「连 IM」一步：看这个房间有没有连上飞书或微信
  const showOnboarding = onboardingWanted && isOwner && Boolean(username);
  useEffect(() => {
    if (!showOnboarding || !authToken || imDialogOpen) return;
    let cancelled = false;
    listImConnections(base, authToken, currentRoomId)
      .then((connections) => {
        if (!cancelled) setImConnected(connections.length > 0);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [authToken, base, currentRoomId, imDialogOpen, showOnboarding]);

  const loadWhiteboardHistory = useCallback(async () => {
    const epoch = whiteboardEpochRef.current;
    const changes = new Map(whiteboardChangesRef.current);
    const response = await fetch(
      `${base}/api/rooms/${encodeURIComponent(currentRoomId)}/whiteboard?view=all`,
      {
        headers: { Authorization: `Bearer ${authToken}` },
      },
    );
    if (!response.ok) throw new Error(t("无法加载白板历史。"));
    const payload = (await response.json()) as { entries: WhiteboardEntry[] };
    setWhiteboard((current) => {
      if (whiteboardEpochRef.current !== epoch) return current;
      const next = new Map<string, WhiteboardEntry>();
      for (const [entryId, entry] of current) {
        if (changes.get(entryId) !== whiteboardChangesRef.current.get(entryId))
          next.set(entryId, entry);
      }
      for (const entry of payload.entries) {
        if (
          entry.roomId === currentRoomId &&
          changes.get(entry.id) === whiteboardChangesRef.current.get(entry.id)
        )
          next.set(entry.id, entry);
      }
      return next;
    });
  }, [base, authToken, currentRoomId]);

  if (!username) {
    return (
      <LoginDialog
        onJoin={(nextUsername) => {
          localStorage.setItem(storedUsernameKey, nextUsername);
          setUsername(nextUsername);
          if (messageNotifications !== "off") void ensureNotificationPermission();
        }}
      />
    );
  }

  const online = participants.filter((participant) => participant.status !== "offline");
  // 这里之前有提前返回（登录页等），不能再用 hook：直接算，数据量很小
  const onlineAgentNames = new Set(
    online
      .filter((participant) => participant.type === "agent")
      .map((participant) => participant.username.toLocaleLowerCase()),
  );
  const pendingScheduleCount = [...schedules.values()].filter(isPendingSchedule).length;

  const offline = participants.filter((participant) => participant.status === "offline");

  async function ensureNotificationPermission(): Promise<boolean> {
    if (!("Notification" in window)) {
      setNotificationPermission("unsupported");
      return false;
    }
    const permission =
      Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
    setNotificationPermission(permission);
    return permission === "granted";
  }

  function dismissNotificationPrompt() {
    setNotificationPromptDismissed(true);
    localStorage.setItem(storedNotificationPromptDismissedKey, "true");
  }

  async function updateMessageNotifications(mode: MessageNotificationMode) {
    const next = mode !== "off" && !(await ensureNotificationPermission()) ? "off" : mode;
    setMessageNotifications(next);
    localStorage.setItem(storedMessageNotificationsKey, next);
  }

  async function updateAttentionDelivery(next: AttentionDelivery) {
    // 选系统通知时顺便请求授权；没授权也照样生效，退回页面内提示
    if (next === "system") await ensureNotificationPermission();
    setAttentionDelivery(next);
    localStorage.setItem(storedAttentionDeliveryKey, next);
  }

  function closeOnboarding() {
    finishOnboarding(localStorage);
    setOnboardingWanted(false);
  }

  const onboardingSteps: OnboardingStep[] = [
    {
      id: "agent",
      title: t("接入一个 Agent"),
      description: t("选 Claude、Codex 等运行时，在这台电脑上一键启动，或复制命令到别的电脑运行。"),
      action: t("接入 Agent"),
      done: participants.some((participant) => participant.type === "agent"),
      onAction: (trigger) => {
        setOnboardingOpen(false);
        openAgentDialog(trigger);
      },
    },
    {
      id: "notifications",
      title: t("打开通知"),
      description: t("Agent 等你回答、失败或做完时，切到别的页面也能收到提醒。"),
      action: t("允许通知"),
      done: notificationPermission === "granted",
      ...(notificationPermission === "unsupported" || notificationPermission === "denied"
        ? {
            unavailable:
              notificationPermission === "unsupported"
                ? t("当前浏览器不支持系统通知，页面内照样会提醒。")
                : t("通知被浏览器阻止了，可以在站点权限里重新允许；页面内照样会提醒。"),
          }
        : {}),
      onAction: () => void ensureNotificationPermission(),
    },
    {
      id: "im",
      title: t("连上飞书或微信"),
      description: t("扫码后，在手机上就能给房间发消息、收结果、回答提问。"),
      action: t("连接 IM"),
      done: imConnected,
      onAction: () => {
        setOnboardingOpen(false);
        setImDialogOpen(true);
      },
    },
  ];

  async function updatePresenceNotifications(next: boolean) {
    const enabled = next && (await ensureNotificationPermission());
    setPresenceNotifications(enabled);
    localStorage.setItem(storedPresenceNotificationsKey, String(enabled));
  }

  const draftTooLong = draft.trim().length > MAX_MESSAGE_LENGTH;

  // 有附件在上传或上传失败时不能发：失败的要先重试或移除，避免悄悄丢掉
  const attachmentsBlocking = attachmentQueue.uploading || attachmentQueue.failed;
  // 草稿里 @ 到的、正在这个房间执行任务、支持引导的 Agent：可以直接「引导」
  const steerTargets = (() => {
    const named = new Set(
      [...draft.matchAll(/@([\p{L}\p{N}_.-]+)/gu)].map((match) => match[1]!.toLocaleLowerCase()),
    );
    if (named.size === 0) return [];
    const running = new Set(
      [...invocations.values()]
        .filter((item) => item.status === "running" && item.roomId === currentRoomId)
        .map((item) => item.agentId),
    );
    return participants
      .filter(
        (participant) =>
          participant.type === "agent" &&
          named.has(participant.username.toLocaleLowerCase()) &&
          running.has(participant.id) &&
          ["claude", "codex", "opencode", "omp"].includes(participant.provider ?? ""),
      )
      .map((participant) => participant.username);
  })();
  const canSend =
    (Boolean(draft.trim()) || attachmentQueue.readyIds.length > 0) &&
    !draftTooLong &&
    !attachmentsBlocking;

  function sendMessage(steer = false) {
    const content = draft.trim();
    const socket = socketRef.current;
    const attachmentIds = attachmentQueue.readyIds;
    if (!content && attachmentIds.length === 0) return;
    if (content.length > MAX_MESSAGE_LENGTH || attachmentsBlocking) return;
    if (socket?.readyState !== WebSocket.OPEN) return;
    // 回答提问时带上回复关系：服务端据此把答案交回提问的 Agent，不必再 @ 它
    const replyTo = answering && answering.roomId === currentRoomId ? answering.id : undefined;
    socket.send(
      JSON.stringify({
        type: "message.send",
        clientMessageId: createClientMessageId(),
        content,
        ...(attachmentIds.length ? { attachmentIds } : {}),
        ...(replyTo ? { replyToMessageId: replyTo } : {}),
        ...(steer ? { steer: true } : {}),
      }),
    );
    attachmentQueue.clear();
    setAttachmentNotice(undefined);
    setDraft("");
    setComposerPreview(false);
    // 发完长内容自动收回，免得输入框一直占着半屏
    setComposerExpanded(false);
    setMentionContext(undefined);
    setAnswering(undefined);
  }

  function submitChoice(question: ChatMessage, selected: string[], other?: string) {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN || pendingAnswers.has(question.id)) return;
    const clientMessageId = createClientMessageId();
    setPendingAnswers((current) => new Map(current).set(question.id, clientMessageId));
    socket.send(
      JSON.stringify({
        type: "question.answer",
        clientMessageId,
        questionMessageId: question.id,
        selected,
        ...(other ? { other } : {}),
      }),
    );
  }

  function answerQuestion(question: ChatMessage) {
    setAnswering(question);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }

  /** 紧贴文字的 @（abc@）名字开头对不上任何在线成员就不弹，打邮箱时不打扰 */
  function visibleMention(context: MentionContext | undefined) {
    if (!context?.attached) return context;
    return filterMentionParticipants(participants, context.query, username, 1, [], true).length
      ? context
      : undefined;
  }

  function updateMentionContext(value: string, cursor: number | null) {
    const nextContext = visibleMention(findMentionContext(value, cursor ?? value.length));
    // 纯文本输入框：用背后排版一致的高亮层量出 @ 所在的横坐标，候选面板跟着它
    const anchorX = nextContext
      ? highlightOffsetX(highlightRef.current, nextContext.start)
      : undefined;
    setMentionContext(
      nextContext && anchorX !== undefined ? { ...nextContext, anchorX } : nextContext,
    );
    setActiveMentionIndex(0);
  }

  function showHistoryEntry(text: string) {
    browsingHistoryRef.current = text || undefined;
    setDraft(text);
    setMentionContext(undefined);
    window.requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(text.length, text.length);
    });
  }

  /** 输入框的按键：发送、选 @ 成员、翻历史。返回 true 表示已处理，调用方阻止默认行为 */
  function handleComposerKey(event: KeyboardEvent, caret: ComposerKeyInfo): boolean {
    if (event.isComposing || event.keyCode === 229) return false;
    if (event.key === "Enter" && !event.shiftKey && (event.metaKey || event.ctrlKey)) {
      sendMessage();
      return true;
    }
    if (mentionContext && event.key === "ArrowDown") {
      setActiveMentionIndex((index) =>
        mentionSuggestions.length ? (index + 1) % mentionSuggestions.length : 0,
      );
      return true;
    }
    if (mentionContext && event.key === "ArrowUp") {
      setActiveMentionIndex((index) =>
        mentionSuggestions.length
          ? (index - 1 + mentionSuggestions.length) % mentionSuggestions.length
          : 0,
      );
      return true;
    }
    if (mentionContext && event.key === "Escape") {
      setMentionContext(undefined);
      return true;
    }
    if (
      mentionContext &&
      mentionSuggestions[activeMentionIndex] &&
      (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))
    ) {
      chooseMention(mentionSuggestions[activeMentionIndex]);
      return true;
    }
    // 代码块里 Enter 是换行，要发送用组合键
    if (sendShortcut === "enter" && event.key === "Enter" && !event.shiftKey && !caret.inCode) {
      sendMessage();
      return true;
    }
    if (event.key === "Escape" && draft && draft === browsingHistoryRef.current) {
      showHistoryEntry("");
      return true;
    }
    if (
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      const next = stepComposerHistory({
        history: composerHistory(messages, username),
        draft,
        browsing: browsingHistoryRef.current,
        direction: event.key === "ArrowUp" ? "older" : "newer",
        selectionStart: caret.selectionStart,
        selectionEnd: caret.selectionEnd,
      });
      if (next !== undefined) {
        showHistoryEntry(next);
        return true;
      }
    }
    return false;
  }

  function chooseMention(participant: Participant) {
    if (!mentionContext) return;
    if (textareaRef.current?.applyMention) {
      textareaRef.current.applyMention(participant.username);
      setMentionContext(undefined);
      setActiveMentionIndex(0);
      return;
    }
    const next = applyMention(draft, mentionContext, participant.username);
    setDraft(next.value);
    setMentionContext(undefined);
    setActiveMentionIndex(0);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  }

  function appendMention(usernameToMention: string) {
    // 已经 @ 过就不再重复追加，只把焦点放回输入框
    if (draftMentions(draft, usernameToMention)) {
      setMentionContext(undefined);
      window.requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    const separator = draft && !draft.endsWith(" ") ? " " : "";
    const nextValue = `${draft}${separator}@${usernameToMention} `;
    setDraft(nextValue);
    setMentionContext(undefined);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextValue.length, nextValue.length);
    });
  }

  async function copyMessageContent(message: ChatMessage) {
    try {
      await copyTextToClipboard(message.content);
      setCopiedMessageId(message.id);
      window.setTimeout(
        () => setCopiedMessageId((current) => (current === message.id ? undefined : current)),
        1500,
      );
    } catch {
      setError(t("浏览器未允许自动复制，请选中消息文本后手动复制。"));
    }
  }

  async function copySeqReference(message: ChatMessage) {
    const key = `seq:${message.id}`;
    try {
      await copyTextToClipboard(`#${message.seq}`);
      setCopiedMessageId(key);
      window.setTimeout(
        () => setCopiedMessageId((current) => (current === key ? undefined : current)),
        1500,
      );
    } catch {
      setError(t("浏览器未允许自动复制，请手动输入序号。"));
    }
  }

  /** stop：一起停掉这条消息派出、还没结束的任务（服务端处理，只停直接派出的，不连带下游） */
  function recallMessage(messageId: string, stop = false) {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) {
      setError(t("当前未连接到 Hive Server，无法撤回。"));
      return;
    }
    socket.send(JSON.stringify({ type: "message.delete", messageId, ...(stop ? { stop } : {}) }));
    setRecallCandidateId(undefined);
  }

  function sendClientEvent(payload: Record<string, unknown>, failure: string): void {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) {
      setError(t("当前未连接到 Hive Server，{0}", { 0: failure }));
      return;
    }
    socket.send(JSON.stringify(payload));
  }

  function retryInvocation(invocation: Invocation, model?: string) {
    sendClientEvent(
      { type: "invocation.retry", invocationId: invocation.id, ...(model ? { model } : {}) },
      t("无法重试。"),
    );
  }

  // 走 HTTP：「Agent 任务」面板里的调用可能属于其它房间，WebSocket 只作用于当前房间
  function dismissInvocations(list: Invocation[]) {
    if (!authToken || list.length === 0) return;
    void fetch(`${base}/api/invocations/dismiss`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ invocationIds: list.map((item) => item.id), by: username }),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`(${response.status})`);
      })
      .catch((reason: unknown) =>
        setError(
          t("无法忽略：{0}", { 0: reason instanceof Error ? reason.message : String(reason) }),
        ),
      );
  }

  function cancelInvocation(invocation: Invocation) {
    sendClientEvent({ type: "invocation.cancel", invocationId: invocation.id }, t("无法停止。"));
  }

  function steerInvocation(invocation: Invocation) {
    sendClientEvent({ type: "invocation.steer", invocationId: invocation.id }, t("无法插入。"));
  }

  function preemptInvocation(invocation: Invocation) {
    const confirmed = window.confirm(
      t(
        "停下 @{0} 正在执行的任务，改做这条？\n\n正在执行的那一轮会被中断，结果可能是「已停止」或「结果未知」，做到一半的改动不会自动撤回、也不会自动重跑。",
        { 0: invocation.agentName },
      ),
    );
    if (!confirmed) return;
    sendClientEvent({ type: "invocation.preempt", invocationId: invocation.id }, t("无法停下。"));
  }

  function extendAgentBudget() {
    sendClientEvent(
      { type: "budget.extend", turns: BUDGET_EXTEND_TURNS },
      t("无法继续 Agent 对话。"),
    );
  }

  function cancelSchedule(schedule: Schedule) {
    sendClientEvent({ type: "schedule.cancel", scheduleId: schedule.id }, t("无法取消定时任务。"));
  }

  function removeWhiteboardEntry(entry: WhiteboardEntry) {
    if (!window.confirm(t("永久删除这条历史事项？此操作无法恢复。"))) return;
    sendClientEvent(
      { type: "whiteboard.remove", entryId: entry.id, updatedAt: entry.updatedAt },
      t("无法移除白板条目。"),
    );
  }

  async function changeWhiteboardArchive(entries: WhiteboardEntry[], archive: boolean) {
    const epoch = whiteboardEpochRef.current;
    const changes = new Map(whiteboardChangesRef.current);
    const response = await fetch(
      `${base}/api/rooms/${encodeURIComponent(currentRoomId)}/whiteboard/${archive ? "archive" : "restore"}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ entries: entries.map(({ id, updatedAt }) => ({ id, updatedAt })) }),
      },
    );
    if (!response.ok) {
      const failure: unknown = await response.json().catch(() => ({}));
      throw new Error(serverError(failure) ?? t("白板操作失败，请刷新后重试。"));
    }
    const payload = (await response.json()) as { entries: WhiteboardEntry[] };
    if (whiteboardEpochRef.current !== epoch) return;
    const changedDuringRequest = new Set<string>();
    for (const entry of payload.entries) {
      if (changes.get(entry.id) !== whiteboardChangesRef.current.get(entry.id))
        changedDuringRequest.add(entry.id);
      whiteboardChangesRef.current.set(
        entry.id,
        (whiteboardChangesRef.current.get(entry.id) ?? 0) + 1,
      );
    }
    setWhiteboard((current) => {
      if (whiteboardEpochRef.current !== epoch) return current;
      return payload.entries.reduce(
        (next, entry) =>
          changedDuringRequest.has(entry.id) && !next.has(entry.id)
            ? next
            : upsertWhiteboardEntry(next, entry),
        current,
      );
    });
  }

  function jumpToMessage(messageId: string) {
    const index = messages.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    if (currentTopic && index < currentTopic.index) setExpandedTopicId(currentTopic.id);
    const needed = messages.length - index;
    if (needed > visibleLimit) setVisibleLimit(needed + 10);
    setPendingJumpId(messageId);
  }

  function toggleMessageSelected(messageId: string) {
    setSelectedMessageIds((previous) => {
      const next = new Set(previous);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }

  function toggleSelectAllMessages() {
    setSelectedMessageIds((previous) =>
      previous.size === messages.length
        ? new Set()
        : new Set(messages.map((message) => message.id)),
    );
  }

  function exitShareMode() {
    setShareMode(false);
    setSelectedMessageIds(new Set());
    setShareFeedback(undefined);
  }

  async function copyShareMarkdown() {
    try {
      await copyTextToClipboard(buildShareMarkdown(selectedMessages, currentRoomName));
      setShareFeedback(t("Markdown 已复制到剪贴板"));
    } catch {
      setShareFeedback(t("复制失败：剪贴板不可用"));
    }
  }

  function downloadShareMarkdown() {
    downloadFile(
      shareFilename(currentRoomId, "md"),
      new Blob([buildShareMarkdown(selectedMessages, currentRoomName)], {
        type: "text/markdown;charset=utf-8",
      }),
    );
    setShareFeedback(t("已下载 Markdown 文件"));
  }

  async function exportShareImage() {
    const node = shareCardRef.current;
    if (!node) return;
    setShareBusy(true);
    setShareFeedback(undefined);
    try {
      const { toPng } = await import("html-to-image");
      const dataUrl = await toPng(node, { pixelRatio: 2 });
      const anchor = document.createElement("a");
      anchor.href = dataUrl;
      anchor.download = shareFilename(currentRoomId, "png");
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setShareFeedback(t("图片已导出"));
    } catch {
      setShareFeedback(t("图片导出失败，请重试。"));
    } finally {
      setShareBusy(false);
    }
  }

  /**
   * 邀请链接直接指向当前房间的 Web UI：生产环境由 Hive Server 托管页面，用对外地址；
   * 开发环境页面由 Vite 提供，沿用当前页面地址。
   */
  function inviteLink(): string {
    const origin = resolveShareBase({
      development: import.meta.env.DEV,
      location: window.location,
      advertisedUrl: meta?.httpUrl,
    });
    return `${origin}/#${currentRoomId}`;
  }

  async function copyCommand() {
    if (!meta) return;
    setCopyError(undefined);
    try {
      await copyTextToClipboard(selectedAgentCommand);
      setCommandCopied(true);
      setAgentConnected(true);
      window.setTimeout(() => setCommandCopied(false), 1500);
    } catch {
      setCommandCopied(false);
      setCopyError(t("浏览器未允许自动复制，请选中上方命令后手动复制。"));
    }
  }

  async function roomRequest(path: string, method: string, body: unknown): Promise<RoomSummary> {
    if (!meta) throw new Error(t("尚未连接 Hive Server。"));
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
    });
    if (response.status === 409) throw new Error(t("房间 ID 已存在，请换一个。"));
    if (!response.ok) {
      const failure: unknown = await response.json().catch(() => ({}));
      throw new Error(serverError(failure) ?? t("房间操作失败 ({0})", { 0: response.status }));
    }
    const payload = (await response.json()) as { room: RoomSummary };
    return payload.room;
  }

  async function submitCreateRoom() {
    const id = roomDialogId.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      setRoomDialogError(t("房间 ID 只能包含字母、数字、下划线和连字符。"));
      return;
    }
    setRoomDialogBusy(true);
    setRoomDialogError(undefined);
    try {
      const room = await roomRequest("/api/rooms", "POST", {
        id,
        name: roomDialogName.trim() || id,
        createdBy: username,
        ...(roomDialogWorkspace.trim() ? { workspace: roomDialogWorkspace.trim() } : {}),
      });
      upsertRoom(room);
      closeRoomDialog();
      switchRoom(room.id);
    } catch (reason) {
      setRoomDialogError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRoomDialogBusy(false);
    }
  }

  /** 能设为主 Agent 的：当前房间里的 Agent（别的房间的成员这里拿不到） */
  function leadCandidates(room: RoomSummary): string[] {
    if (room.id !== currentRoomId) return [];
    return participants
      .filter((participant) => participant.type === "agent")
      .map((participant) => participant.username)
      .sort((a, b) => a.localeCompare(b));
  }

  async function copyForMenu(text: string) {
    try {
      await copyTextToClipboard(text);
    } catch {
      setError(t("浏览器未允许自动复制。"));
    }
  }

  function markRoomReadNow(room: RoomSummary) {
    localStorage.setItem(readSeqStorageKey(room.id), String(room.latestSeq));
    setReadSeqs((current) => ({ ...current, [room.id]: room.latestSeq }));
  }

  /** 房间右键：打开、复制链接 / ID、标为已读、调整顺序、管理 */
  /** 侧栏里的一个房间：置顶的带图钉、可以拖动排序；其余的按活跃度排，不能拖 */
  function renderRoomItem(room: RoomSummary, index: number, pinned: boolean) {
    const placement = pinned ? roomReorder.itemStyle(room.id, index) : undefined;
    return (
      <div
        key={room.id}
        {...(pinned ? roomReorder.itemProps(room.id) : {})}
        onContextMenu={(event) => openRoomMenu(event, room)}
        style={placement?.style}
        className={`room-item ${pinned ? "pinned" : ""} ${room.id === currentRoomId ? "active" : ""} ${room.archivedAt ? "archived" : ""} ${placement?.dragging ? "dragging" : ""}`}
      >
        {pinned && (
          <span className="room-drag-handle" aria-hidden="true">
            <svg viewBox="0 0 8 14" width="8" height="14">
              <circle cx="2" cy="2" r="1.1" />
              <circle cx="6" cy="2" r="1.1" />
              <circle cx="2" cy="7" r="1.1" />
              <circle cx="6" cy="7" r="1.1" />
              <circle cx="2" cy="12" r="1.1" />
              <circle cx="6" cy="12" r="1.1" />
            </svg>
          </span>
        )}
        <button
          type="button"
          className="room-item-main"
          aria-current={room.id === currentRoomId}
          {...(pinned
            ? {
                "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown",
                title: t("已置顶，拖动可调整顺序（Alt + ↑/↓ 也可以）"),
              }
            : {})}
          onClick={() => switchRoom(room.id)}
        >
          <span className="room-item-label">
            <span className="room-item-name"># {room.name}</span>
            {room.branch && (
              <span
                className="room-item-branch"
                title={t("工作区 {0} 当前分支：{1}", {
                  0: room.workspace ?? "",
                  1: room.branch,
                })}
              >
                <BranchGlyph />
                <span>{room.branch}</span>
              </span>
            )}
          </span>
          {pinned && <PinGlyph />}
          <span className="room-item-meta">
            {room.archivedAt ? t("已归档") : t("{0} 在线", { 0: room.onlineCount })}
          </span>
          {(() => {
            const tasks = roomTaskCounts.get(room.id) ?? { attention: 0, inFlight: 0 };
            const unseenDone = attention.unseenByRoom.get(room.id) ?? 0;
            if (room.archivedAt) return null;
            if (tasks.attention > 0) {
              return (
                <span
                  className="room-task attention"
                  role="img"
                  title={t("{0} 个任务需要处理", { 0: tasks.attention })}
                  aria-label={t("# {0}：{1} 个任务需要处理", {
                    0: room.name,
                    1: tasks.attention,
                  })}
                >
                  {tasks.attention}
                </span>
              );
            }
            if (unseenDone > 0) {
              return (
                <span
                  className="room-task done"
                  role="img"
                  title={t("{0} 个任务做完了，你还没看", { 0: unseenDone })}
                  aria-label={t("# {0}：{1} 个任务做完了，还没看", {
                    0: room.name,
                    1: unseenDone,
                  })}
                >
                  ✓{unseenDone > 1 && unseenDone}
                </span>
              );
            }
            if (tasks.inFlight > 0) {
              return (
                <span
                  className="room-task running"
                  role="img"
                  title={t("{0} 个任务进行中", { 0: tasks.inFlight })}
                  aria-label={t("# {0}：{1} 个任务进行中", {
                    0: room.name,
                    1: tasks.inFlight,
                  })}
                >
                  <span className="room-task-spinner" aria-hidden="true" />
                  {tasks.inFlight > 1 && tasks.inFlight}
                </span>
              );
            }
            return null;
          })()}
          {room.id !== currentRoomId &&
            !room.archivedAt &&
            room.latestSeq > (readSeqs[room.id] ?? 0) && (
              <span className="room-unread" aria-label={t("# {0} 有未读消息", { 0: room.name })} />
            )}
        </button>
        {isOwner && (
          <button
            type="button"
            className="room-item-manage"
            aria-label={t("管理房间 {0}", { 0: room.name })}
            aria-haspopup="dialog"
            onClick={(event) => openRoomDialog({ mode: "manage", room }, event.currentTarget)}
          >
            <Icon name="settings" size={14} />
          </button>
        )}
      </div>
    );
  }

  function openRoomMenu(event: ReactMouseEvent<HTMLElement>, room: RoomSummary) {
    event.preventDefault();
    const row = event.currentTarget;
    const index = pinnedRoomIds.indexOf(room.id);
    const move = (to: number) => savePinnedRooms(moveRoom(pinnedRoomIds, room.id, to));
    const origin = resolveShareBase({
      development: import.meta.env.DEV,
      location: window.location,
      advertisedUrl: meta?.httpUrl,
    });
    setContextMenu({
      ...contextMenuPoint(event),
      title: `# ${room.name}`,
      items: [
        {
          label: t("打开"),
          disabled: room.id === currentRoomId,
          onSelect: () => switchRoom(room.id),
        },
        {
          label: t("标为已读"),
          disabled: room.latestSeq <= (readSeqs[room.id] ?? 0) || room.id === currentRoomId,
          onSelect: () => markRoomReadNow(room),
        },
        "separator",
        { label: t("复制房间链接"), onSelect: () => void copyForMenu(`${origin}/#${room.id}`) },
        { label: t("复制房间 ID"), onSelect: () => void copyForMenu(room.id) },
        ...(isOwner
          ? [
              "separator" as const,
              index < 0
                ? {
                    label: t("置顶"),
                    onSelect: () => savePinnedRooms([room.id, ...pinnedRoomIds]),
                  }
                : {
                    label: t("取消置顶"),
                    onSelect: () => savePinnedRooms(pinnedRoomIds.filter((id) => id !== room.id)),
                  },
              // 只有置顶区里能手动排顺序
              ...(index < 0
                ? []
                : [
                    { label: t("移到最前"), disabled: index <= 0, onSelect: () => move(0) },
                    {
                      label: t("上移"),
                      hint: "Alt+↑",
                      disabled: index <= 0,
                      onSelect: () => move(index - 1),
                    },
                    {
                      label: t("下移"),
                      hint: "Alt+↓",
                      disabled: index >= pinnedRoomIds.length - 1,
                      onSelect: () => move(index + 1),
                    },
                  ]),
              "separator" as const,
              {
                label: t("管理房间…"),
                onSelect: () => {
                  const trigger = row.querySelector<HTMLButtonElement>(".room-item-main");
                  if (trigger) openRoomDialog({ mode: "manage", room }, trigger);
                },
              },
            ]
          : []),
      ],
    });
  }

  /**
   * 在终端里接着本机 Agent 在当前房间的会话：本机直接弹出终端；在别的设备上把命令复制下来。
   * 打不开时（正在执行、只限本机）错误里带着命令的，也复制下来方便手动运行。
   */
  async function openAgentTerminal(agent: LocalAgent) {
    try {
      if (local.mode === "device") {
        const command = await local.sessionCommand(agent.id, currentRoomId);
        if (!command) {
          setError(t("{0} 在这个房间还没有可以接着的会话。", { 0: agent.name }));
          return;
        }
        await copyTextToClipboard(command);
        setGotoNotice(t("已复制命令，在 Server 所在电脑的终端里运行：{0}", { 0: command }));
        return;
      }
      try {
        await local.openTerminal(agent.id, currentRoomId);
      } catch (reason) {
        // 正在执行：提醒一次，确认了照样打开
        if ((reason as { code?: string }).code !== "AGENT_BUSY") throw reason;
        if (!window.confirm(t("{0}\n\n仍要打开吗？", { 0: (reason as Error).message }))) return;
        await local.openTerminal(agent.id, currentRoomId, true);
      }
      setGotoNotice(t("已在终端打开 {0} 的会话；用完退出后再在房间里 @ 它。", { 0: agent.name }));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      const command = (reason as { body?: { command?: unknown } }).body?.command;
      if (typeof command === "string") {
        await copyTextToClipboard(command).catch(() => undefined);
        setError(t("{0}（命令已复制：{1}）", { 0: message, 1: command }));
      } else {
        setError(message);
      }
    }
  }

  async function setLeadAgent(name: string | null) {
    try {
      upsertRoom(
        await roomRequest(`/api/rooms/${encodeURIComponent(currentRoomId)}`, "PATCH", {
          leadAgent: name,
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  /**
   * 成员的右键菜单项：成员列表和对话流里的头像、名字共用这一套。
   * 已经不在这个房间的成员（participant 为空）只给复制名字和 @ 它；@ 一个不在场的名字会交给主 Agent。
   */
  function memberMenuItems(participant: Participant | undefined, name: string): ContextMenuItem[] {
    const self = name.toLocaleLowerCase() === username.toLocaleLowerCase();
    if (!participant) {
      return [
        ...(!self ? [{ label: t("@ {0}", { 0: name }), onSelect: () => appendMention(name) }] : []),
        { label: t("复制名字"), onSelect: () => void copyForMenu(name) },
      ];
    }
    const agent = participant.type === "agent" ? localAgentFor(participant.username) : undefined;
    const lead = isLeadAgent(participant);
    const act = (action: "start" | "stop" | "restart") =>
      void local.act(agent!.id, action).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    const live = agent && agent.status !== "stopped" && agent.status !== "crashed";
    return [
      ...(!self
        ? [
            {
              label: t("@ {0}", { 0: participant.username }),
              onSelect: () => appendMention(participant.username),
            },
          ]
        : []),
      { label: t("复制名字"), onSelect: () => void copyForMenu(participant.username) },
      ...(participant.type === "agent"
        ? [
            "separator" as const,
            { label: t("查看 Agent 任务"), onSelect: () => openActivity("tasks") },
            ...(isOwner
              ? [
                  lead
                    ? { label: t("取消主 Agent"), onSelect: () => void setLeadAgent(null) }
                    : {
                        label: t("设为本房间的主 Agent"),
                        onSelect: () => void setLeadAgent(participant.username),
                      },
                ]
              : []),
            ...(agent
              ? [
                  "separator" as const,
                  { label: t("设置…"), onSelect: () => setSettingsAgentId(agent.id) },
                  {
                    label: local.mode === "device" ? t("复制会话命令") : t("在终端打开会话"),
                    onSelect: () => void openAgentTerminal(agent),
                  },
                  ...(live
                    ? [
                        {
                          label: t("重启"),
                          disabled: !local.canManage,
                          onSelect: () => act("restart"),
                        },
                        {
                          label: t("停止"),
                          danger: true,
                          disabled: !local.canManage,
                          onSelect: () => act("stop"),
                        },
                      ]
                    : [
                        {
                          label: t("启动"),
                          disabled: !local.canManage,
                          onSelect: () => act("start"),
                        },
                      ]),
                ]
              : []),
          ]
        : []),
    ];
  }

  /** 成员右键：@ 它、复制名字；Agent 还能设为主 Agent、看任务、打开设置、重启 / 停止 / 启动 */
  function openMemberMenu(event: ReactMouseEvent<HTMLElement>, participant: Participant) {
    event.preventDefault();
    setContextMenu({
      ...contextMenuPoint(event),
      title: participant.username,
      items: memberMenuItems(participant, participant.username),
    });
  }

  /** 对话流里右击头像或名字：和成员列表同一套菜单，按发送者现在在不在房间算 */
  function openSenderMenu(
    event: ReactMouseEvent<HTMLElement>,
    sender: { id?: string; name: string },
  ) {
    event.preventDefault();
    event.stopPropagation();
    const participant =
      participants.find((item) => item.id === sender.id) ??
      participants.find(
        (item) => item.username.toLocaleLowerCase() === sender.name.toLocaleLowerCase(),
      );
    setContextMenu({
      ...contextMenuPoint(event),
      title: participant?.username ?? sender.name,
      items: memberMenuItems(participant, participant?.username ?? sender.name),
    });
  }

  async function submitRenameRoom(room: RoomSummary) {
    const name = roomDialogName.trim();
    if (!name) {
      setRoomDialogError(t("显示名称不能为空。"));
      return;
    }
    setRoomDialogBusy(true);
    setRoomDialogError(undefined);
    try {
      const workspace = roomDialogWorkspace.trim();
      const updated = await roomRequest(`/api/rooms/${encodeURIComponent(room.id)}`, "PATCH", {
        name,
        ...(workspace !== (room.workspace ?? "") ? { workspace: workspace || null } : {}),
        ...(roomDialogLead !== (room.leadAgent ?? "") ? { leadAgent: roomDialogLead || null } : {}),
      });
      upsertRoom(updated);
      closeRoomDialog();
    } catch (reason) {
      setRoomDialogError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRoomDialogBusy(false);
    }
  }

  function startNewTopic() {
    sendClientEvent({ type: "topic.start" }, t("无法开启新话题。"));
  }

  async function clearRoom(room: RoomSummary) {
    setRoomDialogBusy(true);
    setRoomDialogError(undefined);
    try {
      if (clearWhiteboard) {
        const response = await fetch(
          `${base}/api/rooms/${encodeURIComponent(room.id)}/whiteboard`,
          { headers: { Authorization: `Bearer ${authToken}` } },
        );
        if (!response.ok) {
          const failure: unknown = await response.json().catch(() => ({}));
          throw new Error(serverError(failure) ?? t("无法加载白板历史。"));
        }
        const payload = (await response.json()) as { entries: WhiteboardEntry[] };
        await local.clearRoom(room.id, username, {
          whiteboard: "archive",
          entries: payload.entries.map(({ id, updatedAt }) => ({ id, updatedAt })),
        });
      } else {
        await local.clearRoom(room.id, username, { whiteboard: "keep" });
      }
      closeRoomDialog();
    } catch (reason) {
      setRoomDialogError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRoomDialogBusy(false);
    }
  }

  async function setRoomArchived(room: RoomSummary, archived: boolean) {
    setRoomDialogBusy(true);
    setRoomDialogError(undefined);
    try {
      const updated = await roomRequest(`/api/rooms/${encodeURIComponent(room.id)}`, "PATCH", {
        archived,
      });
      upsertRoom(updated);
      closeRoomDialog();
      if (archived && room.id === currentRoomId) switchRoom("general");
    } catch (reason) {
      setRoomDialogError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRoomDialogBusy(false);
    }
  }

  const composerPlaceholder = currentLeadAgent
    ? t("发送消息，不 @ 时交给主 Agent {0}…", { 0: currentLeadAgent })
    : t("发送消息，输入 @ 选择成员…");
  const plainComposerInput = (
    <>
      <div
        className="composer-highlight"
        ref={highlightRef}
        aria-hidden="true"
        hidden={composerPreview}
      >
        {highlightDraft(draft).map((segment, index) =>
          segment.kind === "mention" ? (
            <mark key={index}>{segment.text}</mark>
          ) : segment.kind ? (
            <span key={index} className={`md-${segment.kind}`}>
              {segment.text}
            </span>
          ) : (
            segment.text
          ),
        )}
        {/* 末尾换行需要占位，否则高亮层比输入框少一行 */}
        {"\u200b"}
      </div>
      <textarea
        ref={attachComposer}
        rows={1}
        hidden={composerPreview}
        value={draft}
        onScroll={(event) => {
          if (highlightRef.current) {
            highlightRef.current.scrollTop = event.currentTarget.scrollTop;
          }
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          if (!composingRef.current) {
            updateMentionContext(event.target.value, event.target.selectionStart);
          }
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          updateMentionContext(event.currentTarget.value, event.currentTarget.selectionStart);
        }}
        onSelect={(event) => {
          // 翻到的旧消息以 @某人 结尾时不弹成员列表，否则方向键会被列表接走
          if (!composingRef.current && event.currentTarget.value !== browsingHistoryRef.current) {
            updateMentionContext(event.currentTarget.value, event.currentTarget.selectionStart);
          }
        }}
        onPaste={(event) => {
          // 只接收浏览器交来的文件（截图、复制的图片）；粘贴的路径文本仍按文字处理，不去读本地文件
          const files = [...event.clipboardData.files];
          if (files.length === 0) return;
          event.preventDefault();
          addAttachments(files);
        }}
        onKeyDown={(event) => {
          // ⌘/Ctrl+Shift+E：切到预览
          if (
            (event.metaKey || event.ctrlKey) &&
            event.shiftKey &&
            event.key.toLowerCase() === "e" &&
            draft.trim()
          ) {
            event.preventDefault();
            setComposerPreview(true);
            return;
          }
          if (composingRef.current) return;
          const textarea = event.currentTarget;
          if (
            handleComposerKey(event.nativeEvent, {
              selectionStart: textarea.selectionStart,
              selectionEnd: textarea.selectionEnd,
              inCode: false,
            })
          ) {
            event.preventDefault();
          }
        }}
        placeholder={composerPlaceholder}
        aria-label={t("消息")}
        aria-autocomplete="list"
        aria-controls={mentionContext ? "mention-suggestions" : undefined}
        aria-expanded={Boolean(mentionContext)}
        aria-activedescendant={
          mentionContext && mentionSuggestions[activeMentionIndex]
            ? `mention-option-${mentionSuggestions[activeMentionIndex].id}`
            : undefined
        }
      />
    </>
  );

  return (
    <main className="app-shell">
      <a className="skip-link" href="#main-content">
        {t("跳到消息区")}
      </a>
      <HostApprovalsBanner local={local} />
      <HostApprovalWaiting local={local} />

      {mobilePanel && (
        <button
          className="panel-scrim"
          type="button"
          aria-label={t("关闭侧栏")}
          onClick={() => closeMobilePanel()}
        />
      )}

      <section
        className={`workspace ${membersCollapsed ? "members-collapsed" : ""} ${roomsCollapsed ? "rooms-collapsed" : ""}`}
        style={
          {
            "--sidebar-width": `${panelWidths.rooms}px`,
            "--panel-width": `${panelWidths.members}px`,
          } as CSSProperties
        }
      >
        <aside
          className={`rooms-panel panel ${mobilePanel === "rooms" ? "mobile-open" : ""}`}
          aria-label={t("房间列表")}
        >
          <PanelResizer panel="rooms" width={panelWidths.rooms} onResize={resizePanel} />
          <div className="sidebar-header">
            <div className="brand">
              <HiveLogo compact />
              <strong>SuperHive</strong>
            </div>
            <div
              className={`connection ${connectionState}`}
              role="status"
              aria-live="polite"
              title={
                connectionState === "online"
                  ? t("Hive 已在线")
                  : connectionState === "connecting"
                    ? t("正在连接")
                    : t("连接已中断")
              }
            >
              <span aria-hidden="true" />
              <span className="connection-label">
                {connectionState === "online"
                  ? t("Hive 已在线")
                  : connectionState === "connecting"
                    ? t("正在连接")
                    : t("连接已中断")}
              </span>
            </div>
            <button
              ref={roomsCloseRef}
              className="panel-close"
              type="button"
              aria-label={t("关闭房间列表")}
              onClick={() => closeMobilePanel()}
            >
              <Icon name="close" />
            </button>
          </div>
          <nav className="sidebar-actions" aria-label={t("快捷操作")}>
            {isOwner && (
              <button
                className="sidebar-action room-create"
                type="button"
                aria-label={t("新建房间")}
                aria-haspopup="dialog"
                onClick={(event) => openRoomDialog({ mode: "create" }, event.currentTarget)}
              >
                <Icon name="plus" size={16} />
                <span>{t("新建房间")}</span>
              </button>
            )}
            <button
              type="button"
              className={`sidebar-action ${activityView === "search" ? "active" : ""}`}
              aria-label={t("搜索消息")}
              aria-haspopup="dialog"
              onClick={(event) => openActivity("search", event.currentTarget)}
            >
              <Icon name="search" size={16} />
              <span>{t("搜索")}</span>
              <kbd className="sidebar-shortcut" aria-hidden="true">
                {modifierKeyLabel === "Cmd" ? "⌘K" : "Ctrl K"}
              </kbd>
            </button>
            <button
              type="button"
              className={`sidebar-action ${activityView === "mentions" ? "active" : ""}`}
              aria-label={
                unreadMentionCount > 0
                  ? t("提及我，{0} 条未读", { 0: unreadMentionCount })
                  : t("提及我")
              }
              aria-haspopup="dialog"
              onClick={(event) => openActivity("mentions", event.currentTarget)}
            >
              <Icon name="at" size={16} />
              <span>{t("提及我")}</span>
              {unreadMentionCount > 0 && (
                <span className="sidebar-badge accent" aria-hidden="true">
                  {unreadMentionCount > 99 ? "99+" : unreadMentionCount}
                </span>
              )}
            </button>
            <button
              type="button"
              className={`sidebar-action ${activityView === "tasks" ? "active" : ""}`}
              aria-label={t("Agent 任务{0}{1}", {
                0: taskCounts.inFlight ? t("，{0} 个进行中", { 0: taskCounts.inFlight }) : "",
                1: taskCounts.attention ? t("，{0} 个需要处理", { 0: taskCounts.attention }) : "",
              })}
              aria-haspopup="dialog"
              onClick={(event) => openActivity("tasks", event.currentTarget)}
            >
              <Icon name="activity" size={16} />
              <span>{t("Agent 任务")}</span>
              {taskCounts.inFlight > 0 && (
                <span className="sidebar-badge running" aria-hidden="true">
                  {taskCounts.inFlight}
                </span>
              )}
              {taskCounts.attention > 0 && (
                <span className="sidebar-badge warning" aria-hidden="true">
                  {taskCounts.attention}
                </span>
              )}
            </button>
            {isOwner && (
              <button
                type="button"
                className="sidebar-action"
                aria-haspopup="dialog"
                title={t("扫码接入飞书或微信，在手机上给房间发消息")}
                onClick={() => setImDialogOpen(true)}
              >
                <Icon name="message" size={16} />
                <span>{t("连接 IM")}</span>
              </button>
            )}
          </nav>
          {attentionGroup && (
            <AttentionRoomGroup
              items={attention.items}
              roomName={roomNameOf}
              onOpen={attention.open}
            />
          )}
          <div className="sidebar-section-label">
            <span>{t("房间列表")}</span>
            <span className="panel-meta">{activeRoomCount}</span>
          </div>
          {/* 置顶区和其余房间一起滚动：置顶多了也不会把下面挤得只剩一小块 */}
          <div className="room-scroll" ref={roomReorder.scrollRef}>
            {sidebarRooms.pinned.length > 0 && (
              <div
                className={`room-list pinned ${roomReorder.dragging ? "reordering" : ""}`}
                ref={roomReorder.listRef}
                role="group"
                aria-label={t("已置顶")}
              >
                {sidebarRooms.pinned.map((room, index) => renderRoomItem(room, index, true))}
              </div>
            )}
            <div
              className="room-list"
              onPointerEnter={freezeRoomList}
              onPointerLeave={(event) => thawRoomList(event.currentTarget)}
              onFocus={freezeRoomList}
              onBlur={(event) => {
                const list = event.currentTarget;
                // 焦点还在列表里（用 Tab 换到下一个房间）就继续保持
                if (!list.contains(event.relatedTarget as Node | null)) {
                  window.setTimeout(() => thawRoomList(list));
                }
              }}
            >
              {sidebarRooms.others.map((room, index) => renderRoomItem(room, index, false))}
            </div>
          </div>
          <button
            type="button"
            className="room-archived-toggle"
            onClick={() => setShowArchivedRooms((current) => !current)}
          >
            {showArchivedRooms ? t("隐藏已归档房间") : t("显示已归档房间")}
          </button>
          <div
            className="sidebar-user"
            ref={userMenuRef}
            onMouseEnter={() => {
              // 鼠标设备悬停头像即展开菜单；触屏仍通过点击切换
              if (!window.matchMedia?.("(hover: hover)").matches) return;
              window.clearTimeout(userMenuHoverTimer.current);
              setUserMenuOpen(true);
            }}
            onMouseLeave={() => {
              if (!window.matchMedia?.("(hover: hover)").matches) return;
              window.clearTimeout(userMenuHoverTimer.current);
              userMenuHoverTimer.current = window.setTimeout(() => setUserMenuOpen(false), 180);
            }}
          >
            {userMenuOpen && (
              <div className="user-menu" role="menu" aria-label={t("用户菜单")}>
                <div className="user-menu-theme">
                  <span>{t("主题")}</span>
                  <ThemeSwitcher
                    value={themePreference}
                    onChange={(value) => {
                      setThemePreference(value);
                      localStorage.setItem(storedThemeKey, value);
                    }}
                  />
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setUserMenuOpen(false);
                    setMobilePanel(undefined);
                    setSettingsOpen(true);
                  }}
                >
                  <Icon name="settings" size={15} />
                  <span>{t("设置")}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="user-menu-logout"
                  onClick={() => {
                    setUserMenuOpen(false);
                    localStorage.removeItem(storedUsernameKey);
                    setUsername("");
                  }}
                >
                  <Icon name="logout" size={15} />
                  <span>{t("退出")}</span>
                </button>
              </div>
            )}
            <button
              ref={settingsTriggerRef}
              type="button"
              className="sidebar-user-chip"
              aria-label={t("用户菜单")}
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
              onClick={() => setUserMenuOpen((current) => !current)}
            >
              <span className="identity-avatar" style={avatarHueStyle(username)} aria-hidden="true">
                {username.slice(0, 1).toUpperCase()}
              </span>
              <span className="identity-copy">
                <strong>{username}</strong>
                <small>{t("当前身份")}</small>
              </span>
              <Icon name="more" size={16} />
            </button>
          </div>
        </aside>

        <section className="chat-panel panel" id="main-content" tabIndex={-1}>
          <header className="chat-header">
            <button
              type="button"
              className="header-button rooms-toggle"
              aria-label={roomsCollapsed ? t("显示房间列表") : t("隐藏房间列表")}
              aria-pressed={!roomsCollapsed}
              title={roomsCollapsed ? t("显示房间列表") : t("隐藏房间列表")}
              onClick={() =>
                setRoomsCollapsed((current) => {
                  localStorage.setItem(storedRoomsCollapsedKey, String(!current));
                  return !current;
                })
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
                    {currentRoom?.branch && (
                      <span className="chat-title-branch" title={t("当前分支")}>
                        <BranchGlyph />
                        {currentRoom.branch}
                      </span>
                    )}
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
                      {local.keepAwake.status === "active"
                        ? t("☾ 保持在线")
                        : t("! 保持在线未生效")}
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
                aria-label={membersCollapsed ? t("显示成员与白板") : t("隐藏成员与白板")}
                aria-pressed={!membersCollapsed}
                title={membersCollapsed ? t("显示成员与白板") : t("隐藏成员与白板")}
                onClick={() =>
                  setMembersCollapsed((current) => {
                    localStorage.setItem(storedMembersCollapsedKey, String(!current));
                    return !current;
                  })
                }
              >
                <Icon name="panel-right" size={17} />
              </button>
            </div>
          </header>
          {(error ||
            showNotificationPrompt ||
            pausedInvocations.length > 0 ||
            worktreeNotices.has(currentRoomId)) && (
            <div className="chat-notices">
              {isOwner && local.enabled && worktreeNotices.has(currentRoomId) && (
                <div className="notification-prompt worktree-batch" role="status">
                  <span>
                    {t("{0} 个 worktree 已合入，可清理。", {
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
          <div
            ref={(element) => {
              messageListRef.current = element;
              setShadowHost((current) => (current === element ? current : element));
            }}
            className="message-list"
            role="log"
            aria-label={t("聊天室消息")}
            aria-live="polite"
            onScroll={handleMessageListScroll}
          >
            <ShadowContent host={shadowHost}>
              <div className="message-shadow-inner">
                {messagesLoaded && messages.length === 0 && (
                  <div className="empty-state">
                    <HiveLogo />
                    <h2>{t("今天在 #{0} 协作什么？", { 0: currentRoomName })}</h2>
                    <p>
                      {t("发出第一条消息，或输入")} <code>@agent-name</code>{" "}
                      {t("邀请一个 Agent 参与。")}
                    </p>
                    <button type="button" onClick={() => textareaRef.current?.focus()}>
                      {t("开始一条消息")}
                      <Icon name="arrow-right" size={16} />
                    </button>
                  </div>
                )}
                <div
                  className="message-scroll-content"
                  ref={(element) => {
                    messageScrollContentRef.current = element;
                    setScrollContentElement((current) => (current === element ? current : element));
                  }}
                >
                  {hiddenCount > 0 ? (
                    <button
                      type="button"
                      className="load-earlier"
                      onClick={() => {
                        captureScrollAnchor();
                        setVisibleLimit((current) => current + 100);
                      }}
                    >
                      {t("显示更早的 {0} 条消息（共隐藏 {1} 条）", {
                        0: Math.min(hiddenCount, 100),
                        1: hiddenCount,
                      })}
                    </button>
                  ) : (
                    earlierTopicCount > 0 &&
                    currentTopic && (
                      <button
                        type="button"
                        className="load-earlier"
                        onClick={() => {
                          captureScrollAnchor();
                          setExpandedTopicId(currentTopic.id);
                        }}
                      >
                        {t("显示更早的话题（{0} 条消息）", { 0: earlierTopicCount })}
                      </button>
                    )
                  )}
                  {timeline.map(({ message, newDay, grouped }) => (
                    <Fragment key={message.id}>
                      {newDay && (
                        <div className="date-divider" role="separator">
                          <span>{dateDividerLabel(message.createdAt)}</span>
                        </div>
                      )}
                      {(() => {
                        // 这条是某次调用的回复：上方收着这一轮的过程（只在内存里，刷新后没有）
                        const source = message.deletedAt
                          ? undefined
                          : invocationByReply.get(message.id);
                        const steps = source ? traces.get(source.id) : undefined;
                        return source && steps?.length ? (
                          <TraceRecap
                            invocation={source}
                            steps={steps}
                            replyText={message.content}
                          />
                        ) : null;
                      })()}
                      {message.kind === "topic" ? (
                        <div
                          className="topic-divider"
                          role="separator"
                          data-message-id={message.id}
                        >
                          <span>
                            {message.content} · {formatMessageTime(message.createdAt)}
                          </span>
                          <small>{t("之前的消息不再作为 Agent 的上下文")}</small>
                        </div>
                      ) : (
                        <article
                          className={`message ${message.senderType} ${
                            message.senderType === "human" &&
                            message.senderName.toLocaleLowerCase() === username.toLocaleLowerCase()
                              ? "own"
                              : ""
                          } ${grouped ? "grouped" : ""} ${
                            shareMode && !message.deletedAt ? "selectable" : ""
                          } ${selectedMessageIds.has(message.id) ? "selected" : ""} ${
                            message.deletedAt ? "deleted" : ""
                          } ${highlightedMessageId === message.id ? "highlighted" : ""} ${
                            message.kind === "question" ? "question" : ""
                          } ${message.kind === "progress" ? "progress" : ""} ${
                            isMachine(message) ? "machine" : ""
                          }`}
                          data-message-id={message.id}
                          style={
                            message.senderType === "human"
                              ? avatarHueStyle(message.senderName)
                              : undefined
                          }
                          onClick={
                            shareMode && !message.deletedAt
                              ? () => toggleMessageSelected(message.id)
                              : undefined
                          }
                        >
                          {grouped ? (
                            <span className="hover-time" aria-hidden="true">
                              {formatMessageTime(message.createdAt)}
                            </span>
                          ) : (
                            <span
                              className={`avatar ${message.senderType}`}
                              aria-hidden="true"
                              onContextMenu={(event) =>
                                openSenderMenu(event, {
                                  id: message.senderId,
                                  name: message.senderName,
                                })
                              }
                            >
                              <AvatarGlyph
                                type={message.senderType}
                                name={message.senderName}
                                provider={agentProviderByName.get(
                                  message.senderName.toLocaleLowerCase(),
                                )}
                              />
                            </span>
                          )}
                          <div className="message-content">
                            {message.kind === "progress" && grouped && (
                              <span
                                className="message-progress-tag"
                                title={t("Agent 执行中途发来的进度，最终结论在它之后的回复里")}
                              >
                                {t("进度")}
                              </span>
                            )}
                            {!grouped && (
                              <header>
                                {/* 名字也能右击，键盘聚焦后按菜单键或 Shift+F10 一样能打开 */}
                                <strong
                                  className="message-sender"
                                  tabIndex={0}
                                  aria-haspopup="menu"
                                  onContextMenu={(event) =>
                                    openSenderMenu(event, {
                                      id: message.senderId,
                                      name: message.senderName,
                                    })
                                  }
                                >
                                  {message.senderName}
                                </strong>
                                {message.senderType === "agent" && <b>Agent</b>}
                                {message.kind === "progress" && (
                                  <span
                                    className="message-progress-tag"
                                    title={t("Agent 执行中途发来的进度，最终结论在它之后的回复里")}
                                  >
                                    {t("进度")}
                                  </span>
                                )}
                                {message.via && (
                                  <span className="message-via">
                                    {t("来自{0}", { 0: IM_CHANNEL_LABELS[message.via.channel] })}
                                  </span>
                                )}
                                <time dateTime={message.createdAt}>
                                  {formatMessageTime(message.createdAt)}
                                </time>
                                <button
                                  type="button"
                                  className="message-seq"
                                  title={t("复制序号引用（可用于在聊天中引用这条消息）")}
                                  aria-label={t("复制消息序号 #{0}", { 0: message.seq })}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void copySeqReference(message);
                                  }}
                                >
                                  {copiedMessageId === `seq:${message.id}`
                                    ? t("已复制")
                                    : `#${message.seq}`}
                                </button>
                              </header>
                            )}
                            {message.deletedAt ? (
                              <p className="message-recalled">
                                {message.senderName.toLocaleLowerCase() ===
                                username.toLocaleLowerCase()
                                  ? t("你撤回了一条消息")
                                  : t("{0} 撤回了一条消息", { 0: message.senderName })}
                              </p>
                            ) : isMachine(message) && !openMachineIds.has(message.id) ? (
                              (() => {
                                const preview = machinePreview(message);
                                return (
                                  <button
                                    type="button"
                                    className="message-machine-card"
                                    title={t("Agent 之间的往来，点开看全文")}
                                    aria-expanded={false}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setOpenMachineIds((current) =>
                                        new Set(current).add(message.id),
                                      );
                                    }}
                                  >
                                    <span className="message-machine-label">
                                      <span>
                                        {splitMentions(preview.label).map((part, index) =>
                                          part.mention ? (
                                            <mark key={index}>{part.text}</mark>
                                          ) : (
                                            part.text
                                          ),
                                        )}
                                      </span>
                                      <small>{t("展开")}</small>
                                    </span>
                                    {preview.text && (
                                      <span className="message-machine-text">
                                        {splitMentions(preview.text).map((part, index) =>
                                          part.mention ? (
                                            <mark key={index}>{part.text}</mark>
                                          ) : (
                                            part.text
                                          ),
                                        )}
                                      </span>
                                    )}
                                  </button>
                                );
                              })()
                            ) : (
                              message.content && (
                                <div className="message-body">
                                  {isMachine(message) && (
                                    <button
                                      type="button"
                                      className="message-machine-collapse"
                                      aria-expanded={true}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setOpenMachineIds((current) => {
                                          const next = new Set(current);
                                          next.delete(message.id);
                                          return next;
                                        });
                                      }}
                                    >
                                      {t("收起")}
                                    </button>
                                  )}
                                  <CollapsibleMessage
                                    content={message.content}
                                    forceExpanded={shareMode}
                                    onToggle={releaseBottomPin}
                                  >
                                    <Suspense
                                      fallback={
                                        <p className="message-body-fallback">{message.content}</p>
                                      }
                                    >
                                      <MessageMarkdown content={message.content} />
                                    </Suspense>
                                  </CollapsibleMessage>
                                </div>
                              )
                            )}
                            {!message.deletedAt && message.attachments?.length ? (
                              <MessageAttachments
                                attachments={message.attachments}
                                base={base}
                                token={authToken}
                              />
                            ) : null}
                            {message.question && !message.deletedAt && (
                              <QuestionOptions
                                spec={message.question}
                                waiting={
                                  message.approval
                                    ? pendingApprovals.has(message.id)
                                    : Boolean(
                                        waitingInvocationForQuestion(message, invocations.values()),
                                      )
                                }
                                allowOther={!message.approval}
                                pending={
                                  pendingAnswers.has(message.id) && !choiceAnswers.has(message.id)
                                }
                                {...(choiceAnswers.get(message.id)
                                  ? { answer: choiceAnswers.get(message.id)! }
                                  : {})}
                                onSubmit={(selected, other) =>
                                  submitChoice(message, selected, other)
                                }
                              />
                            )}
                            {!shareMode &&
                              !message.question &&
                              waitingInvocationForQuestion(message, invocations.values()) && (
                                <button
                                  type="button"
                                  className="question-answer"
                                  aria-label={t("回答 {0} 的提问", { 0: message.senderName })}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    answerQuestion(message);
                                  }}
                                >
                                  {answering?.id === message.id ? t("正在回答…") : t("回答")}
                                </button>
                              )}
                            {invocationsByMessage.has(message.id) && (
                              <InvocationChips
                                connectionState={connectionState}
                                invocations={invocationsByMessage.get(message.id) ?? []}
                                allInvocations={invocations}
                                participants={participants}
                                canJumpTo={(messageId) => loadedMessageIds.has(messageId)}
                                onJump={jumpToMessage}
                                onRetry={(invocation) => retryInvocation(invocation)}
                                onRetryWithModel={isOwner ? setRetryModelFor : undefined}
                                onCancel={cancelInvocation}
                                onDismiss={(invocation) => dismissInvocations([invocation])}
                                onExtend={extendAgentBudget}
                                onSteer={steerInvocation}
                                onPreempt={preemptInvocation}
                                onOpenTerminal={
                                  isOwner
                                    ? (invocation) => {
                                        const agent = localAgentFor(invocation.agentName);
                                        return agent
                                          ? () => void openAgentTerminal(agent)
                                          : undefined;
                                      }
                                    : undefined
                                }
                                isOwner={isOwner}
                                traces={traces}
                              />
                            )}
                            {(invocationsByMessage.get(message.id) ?? [])
                              .filter(
                                (invocation) =>
                                  !invocation.replyMessageId &&
                                  !showsLiveCard(invocation) &&
                                  invocation.status !== "queued" &&
                                  Boolean(traces.get(invocation.id)?.length),
                              )
                              .map((invocation) => (
                                <TraceRecap
                                  key={`recap-${invocation.id}`}
                                  invocation={invocation}
                                  steps={traces.get(invocation.id)!}
                                />
                              ))}
                          </div>
                          {message.deletedAt ? null : shareMode ? (
                            <span
                              className={`select-indicator ${
                                selectedMessageIds.has(message.id) ? "on" : ""
                              }`}
                              role="checkbox"
                              aria-checked={selectedMessageIds.has(message.id)}
                              aria-label={t("选择 {0} 的消息", { 0: message.senderName })}
                            >
                              {selectedMessageIds.has(message.id) && (
                                <Icon name="check" size={12} />
                              )}
                            </span>
                          ) : (
                            <div className="message-actions">
                              {grouped && (
                                <button
                                  type="button"
                                  className="message-action seq"
                                  title={t("复制序号引用")}
                                  aria-label={t("复制消息序号 #{0}", { 0: message.seq })}
                                  onClick={() => void copySeqReference(message)}
                                >
                                  {copiedMessageId === `seq:${message.id}`
                                    ? "✓"
                                    : `#${message.seq}`}
                                </button>
                              )}
                              <button
                                type="button"
                                className="message-action"
                                aria-label={t("复制消息原文")}
                                title={t("复制消息")}
                                onClick={() => void copyMessageContent(message)}
                              >
                                <Icon
                                  name={copiedMessageId === message.id ? "check" : "copy"}
                                  size={13}
                                />
                              </button>
                              {message.senderName.toLocaleLowerCase() !==
                              username.toLocaleLowerCase() ? (
                                <button
                                  type="button"
                                  className="message-action"
                                  aria-label={t("在输入框中提及 {0}", { 0: message.senderName })}
                                  title={`@${message.senderName}`}
                                  onClick={() => appendMention(message.senderName)}
                                >
                                  @
                                </button>
                              ) : recallCandidateId === message.id ? (
                                (() => {
                                  // 这条消息派出、还没结束的任务：撤回时默认一起停掉
                                  const open = (invocationsByMessage.get(message.id) ?? []).filter(
                                    (invocation) =>
                                      ["queued", "running", "waiting_human", "blocked"].includes(
                                        invocation.status,
                                      ),
                                  );
                                  // 只有已经开始做的才有「只撤回、让它做完」可选；排队中的撤回后本来就不会再执行
                                  const started = open.some(
                                    (invocation) =>
                                      invocation.status === "running" ||
                                      invocation.status === "waiting_human",
                                  );
                                  const noteId = `recall-note-${message.id}`;
                                  return (
                                    <span
                                      className={`message-recall-confirm ${open.length ? "with-tasks" : ""}`}
                                      role="group"
                                      aria-label={t("确认撤回")}
                                      {...(open.length ? { "aria-describedby": noteId } : {})}
                                    >
                                      <span className="message-recall-question">
                                        {open.length
                                          ? t("撤回并停止 {0} 的任务？", {
                                              0: [
                                                ...new Set(
                                                  open.map(
                                                    (invocation) => `@${invocation.agentName}`,
                                                  ),
                                                ),
                                              ].join("、"),
                                            })
                                          : t("撤回这条消息？")}
                                      </span>
                                      {open.length > 0 && (
                                        <small id={noteId} className="message-recall-note">
                                          {t(
                                            "只停这条消息直接派出的任务，它们再派出去的子任务不受影响；已经改的文件、跑过的命令不会撤销。",
                                          )}
                                        </small>
                                      )}
                                      <span className="message-recall-actions">
                                        <button
                                          type="button"
                                          onClick={() => setRecallCandidateId(undefined)}
                                        >
                                          {t("取消")}
                                        </button>
                                        {started && (
                                          <button
                                            type="button"
                                            title={t("消息撤回，正在做的照常做完，只是不再回复")}
                                            onClick={() => recallMessage(message.id)}
                                          >
                                            {t("只撤回")}
                                          </button>
                                        )}
                                        <button
                                          type="button"
                                          className="danger"
                                          onClick={() => recallMessage(message.id, open.length > 0)}
                                        >
                                          {open.length ? t("撤回并停止") : t("撤回")}
                                        </button>
                                      </span>
                                    </span>
                                  );
                                })()
                              ) : (
                                <button
                                  type="button"
                                  className="message-action danger"
                                  aria-label={t("撤回这条消息")}
                                  title={t("撤回")}
                                  onClick={() => setRecallCandidateId(message.id)}
                                >
                                  <Icon name="undo" size={13} />
                                </button>
                              )}
                            </div>
                          )}
                        </article>
                      )}
                    </Fragment>
                  ))}
                  {(() => {
                    // 正在干活的 Agent：每人一张「思考中」卡片，出现在回复将来出现的位置；同时超过 3 张时只展开最新的
                    const live = [...invocations.values()]
                      .filter(
                        (invocation) =>
                          invocation.roomId === currentRoomId && showsLiveCard(invocation),
                      )
                      .sort((a, b) =>
                        (a.startedAt ?? a.createdAt).localeCompare(b.startedAt ?? b.createdAt),
                      );
                    const cards = groupLiveCards(live);
                    const seqOf = new Map(messages.map((message) => [message.id, message.seq]));
                    const messageById = new Map(messages.map((message) => [message.id, message]));
                    return cards.map(({ invocation, batch }, index) => (
                      <ThinkingCard
                        key={`card-${invocation.id}`}
                        invocation={invocation}
                        steps={
                          traces.get(invocation.id) ??
                          batch.map((item) => traces.get(item.id)).find(Boolean)
                        }
                        batchSeqs={batch
                          .map((item) => seqOf.get(item.messageId))
                          .filter((seq): seq is number => seq !== undefined)
                          .sort((a, b) => a - b)}
                        traceAllowed={!guest || guest.showTrace !== false}
                        onAvatarContextMenu={(event) =>
                          openSenderMenu(event, {
                            id: invocation.agentId,
                            name: invocation.agentName,
                          })
                        }
                        defaultCollapsed={cards.length > 3 && index < cards.length - 1}
                        {...(() => {
                          // 卡片上写明在处理哪条消息；合批时引用最早的一条
                          const first = [...batch]
                            .map((item) => messageById.get(item.messageId))
                            .filter((message): message is ChatMessage => Boolean(message))
                            .sort((a, b) => a.seq - b.seq)[0];
                          if (!first) return {};
                          return {
                            trigger: {
                              seq: first.seq,
                              preview: plainPreview(first.content).slice(0, 120),
                            },
                            onJumpToTrigger: () => jumpToMessage(first.id),
                          };
                        })()}
                        avatar={
                          <AvatarGlyph
                            type="agent"
                            name={invocation.agentName}
                            provider={agentProviderByName.get(
                              invocation.agentName.toLocaleLowerCase(),
                            )}
                          />
                        }
                      />
                    ));
                  })()}
                  {(() => {
                    // 谁在干活：已经有卡片的不再重复列出，只剩排队、等你回答这些没在跑的
                    const rows = agentActivity(
                      participants,
                      invocations.values(),
                      currentRoomId,
                    ).filter((row) => !row.invocation || !showsLiveCard(row.invocation));
                    if (!rows.length) return null;
                    return (
                      <div className="typing" role="status" aria-live="polite">
                        <span aria-hidden="true" />
                        <span aria-hidden="true" />
                        <span aria-hidden="true" />
                        <ul className="typing-agents">
                          {rows.map((row) => {
                            const target = row.invocation?.messageId;
                            const canJump = Boolean(target && loadedMessageIds.has(target));
                            return (
                              <li key={row.participant.id}>
                                <button
                                  type="button"
                                  className={`typing-agent ${row.state}`}
                                  disabled={!canJump}
                                  title={
                                    canJump
                                      ? t("{0}，点击跳到它正在处理的消息", {
                                          0: row.participant.username,
                                        })
                                      : row.participant.username
                                  }
                                  onClick={() => target && jumpToMessage(target)}
                                >
                                  <span className="mention-avatar agent" aria-hidden="true">
                                    <AvatarGlyph
                                      type="agent"
                                      name={row.participant.username}
                                      provider={row.participant.provider}
                                    />
                                  </span>
                                  <strong>{row.participant.username}</strong>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                        {/* 详细进展看气泡下的状态，这里只说谁在干活 */}
                        <span>{t("正在处理")}</span>
                      </div>
                    );
                  })()}
                  <div ref={messagesEndRef} />
                </div>
              </div>
            </ShadowContent>
          </div>
          {shareMode && (
            <div className="share-bar" role="toolbar" aria-label={t("分享选中的消息")}>
              <span className="share-count" role="status">
                {t("已选 {0} 条", { 0: selectedMessages.length })}
              </span>
              <button type="button" onClick={toggleSelectAllMessages}>
                {messages.length > 0 && selectedMessageIds.size === messages.length
                  ? t("清空")
                  : t("全选")}
              </button>
              <button
                type="button"
                disabled={selectedMessages.length === 0 || shareBusy}
                onClick={() => void copyShareMarkdown()}
              >
                {t("复制 Markdown")}
              </button>
              <button
                type="button"
                disabled={selectedMessages.length === 0 || shareBusy}
                onClick={downloadShareMarkdown}
              >
                {t("下载 .md")}
              </button>
              <button
                type="button"
                disabled={selectedMessages.length === 0 || shareBusy}
                onClick={() => void exportShareImage()}
              >
                {shareBusy ? t("导出中…") : t("导出图片")}
              </button>
              {shareFeedback && (
                <span className="share-feedback" role="status">
                  {shareFeedback}
                </span>
              )}
              <button type="button" className="share-exit" onClick={exitShareMode}>
                {t("退出")}
              </button>
            </div>
          )}
          {shareMode && selectedMessages.length > 0 && (
            <div className="share-card-stage" aria-hidden="true">
              <div ref={shareCardRef} className="share-card">
                <header className="share-card-header">
                  <strong># {currentRoomName}</strong>
                  <span>{t("SUPERHIVE · 对话分享")}</span>
                </header>
                {selectedMessages.map((message) => (
                  <div
                    key={message.id}
                    className={`share-card-message ${message.senderType}`}
                    style={
                      message.senderType === "human"
                        ? avatarHueStyle(message.senderName)
                        : undefined
                    }
                  >
                    <span className={`share-card-avatar ${message.senderType}`}>
                      <AvatarGlyph
                        type={message.senderType}
                        name={message.senderName}
                        provider={agentProviderByName.get(message.senderName.toLocaleLowerCase())}
                      />
                    </span>
                    <div className="share-card-body">
                      <header>
                        <strong>{message.senderName}</strong>
                        {message.senderType === "agent" && <b>Agent</b>}
                        <time dateTime={message.createdAt}>
                          {formatShareTimestamp(message.createdAt)}
                        </time>
                        <span className="share-card-seq">#{message.seq}</span>
                      </header>
                      <div className="message-body">
                        <Suspense
                          fallback={<p className="message-body-fallback">{message.content}</p>}
                        >
                          <MessageMarkdown content={message.content} />
                        </Suspense>
                      </div>
                    </div>
                  </div>
                ))}
                <footer className="share-card-footer">
                  <span>
                    {t("导出于 {0}", { 0: formatShareTimestamp(new Date().toISOString()) })}
                  </span>
                  <span>SuperHive</span>
                </footer>
              </div>
            </div>
          )}
          <div className="composer">
            {showJumpToBottom && !mentionContext && (
              <button
                type="button"
                className="jump-to-bottom"
                aria-label={t("滚动到底部")}
                title={t("回到最新消息")}
                onClick={jumpToLatest}
              >
                <Icon name="arrow-down" size={16} />
              </button>
            )}
            {pendingNewMessages > 0 && !mentionContext && (
              <button type="button" className="jump-pill" onClick={jumpToLatest}>
                {t("↓ {0} 条新消息", { 0: pendingNewMessages })}
              </button>
            )}
            {mentionContext && (
              <div
                ref={mentionMenuRef}
                className="mention-menu"
                id="mention-suggestions"
                role="listbox"
              >
                <div className="mention-menu-heading">
                  <span>{t("提及成员")}</span>
                  <small>{t("{0} 个匹配", { 0: mentionSuggestions.length })}</small>
                </div>
                {mentionSuggestions.length > 0 ? (
                  <div className="mention-options">
                    {mentionSuggestions.map((participant, index) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={index === activeMentionIndex}
                        id={`mention-option-${participant.id}`}
                        className={`mention-option ${index === activeMentionIndex ? "active" : ""}`}
                        key={participant.id}
                        onMouseMove={(event) => {
                          // 键盘翻动使列表滚到静止的鼠标下时，浏览器也会补发鼠标事件，不能让它抢走选中项
                          if (event.movementX || event.movementY) setActiveMentionIndex(index);
                        }}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => chooseMention(participant)}
                      >
                        <span
                          className={`mention-avatar ${participant.type}`}
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
                        <span className="mention-member-copy">
                          <strong>@{participant.username}</strong>
                          <small>
                            {participant.type === "agent" ? "Agent" : t("用户")} ·{" "}
                            {participantStatusLabel(participant.status)}
                          </small>
                        </span>
                        <span
                          className={`status-dot ${participant.status}`}
                          aria-label={participantStatusLabel(participant.status)}
                        />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="mention-empty">{t("没有找到匹配的成员")}</div>
                )}
                <div className="mention-menu-footer">
                  <span>
                    <kbd>↑↓</kbd> {t("选择")}
                  </span>
                  <span>
                    <kbd>Enter</kbd> {t("或")} <kbd>Tab</kbd> {t("补全")}
                  </span>
                  <span>
                    <kbd>Esc</kbd> {t("关闭")}
                  </span>
                </div>
              </div>
            )}
            {answering && answering.roomId === currentRoomId && (
              <div className="composer-answering" role="status">
                <strong>{t("回答 @{0} 的提问", { 0: answering.senderName })}</strong>
                <span>{answering.content.replace(/\s+/g, " ")}</span>
                <button
                  type="button"
                  aria-label={t("取消回答")}
                  title={t("取消回答，改为普通消息")}
                  onClick={() => setAnswering(undefined)}
                >
                  ×
                </button>
              </div>
            )}
            <div
              className={`composer-box${dragActive ? " drag-active" : ""}`}
              onDragEnter={(event) => {
                if (event.dataTransfer.types.includes("Files")) setDragActive(true);
              }}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes("Files")) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setDragActive(false);
                }
              }}
              onDrop={(event) => {
                if (!event.dataTransfer.files.length) return;
                event.preventDefault();
                setDragActive(false);
                addAttachments([...event.dataTransfer.files]);
              }}
            >
              <ComposerAttachments
                items={attachmentQueue.items}
                onRemove={attachmentQueue.remove}
                onRetry={attachmentQueue.retry}
              />
              <div className="composer-input">
                {composerPreview && (
                  <div
                    className="composer-preview"
                    role="region"
                    aria-label={t("Markdown 预览")}
                    tabIndex={0}
                    ref={(element) => element?.focus({ preventScroll: true })}
                    style={{ maxHeight: `${composerMaxHeight(composerExpanded)}px` }}
                    onKeyDown={(event) => {
                      const toggle =
                        (event.metaKey || event.ctrlKey) &&
                        event.shiftKey &&
                        event.key.toLowerCase() === "e";
                      if (event.key !== "Escape" && !toggle) return;
                      event.preventDefault();
                      event.stopPropagation();
                      setComposerPreview(false);
                      window.requestAnimationFrame(() => textareaRef.current?.focus());
                    }}
                    onClick={() => {
                      setComposerPreview(false);
                      window.requestAnimationFrame(() => textareaRef.current?.focus());
                    }}
                    title={t("点一下回到编辑")}
                  >
                    {draft.trim() ? (
                      <div className="message-body">
                        <MessageMarkdown content={draft} />
                      </div>
                    ) : (
                      <p className="composer-preview-empty">{t("还没有内容")}</p>
                    )}
                  </div>
                )}
                {richComposer ? (
                  <Suspense fallback={plainComposerInput}>
                    <RichComposer
                      value={draft}
                      onChange={(value) => setDraft(value)}
                      onMentionContext={(value, context) => {
                        // 翻到的旧消息以 @某人 结尾时不弹成员列表，否则方向键会被列表接走
                        if (value && value === browsingHistoryRef.current) return;
                        setMentionContext(visibleMention(context));
                        setActiveMentionIndex(0);
                      }}
                      onKeyDown={handleComposerKey}
                      onPasteFiles={addAttachments}
                      handleRef={attachComposer}
                      placeholder={composerPlaceholder}
                      expanded={composerExpanded}
                      newlineOnEnter={sendShortcut === "modifier-enter"}
                      ariaLabel={t("消息")}
                      ariaExpanded={Boolean(mentionContext)}
                      ariaControls={mentionContext ? "mention-suggestions" : undefined}
                      ariaActiveDescendant={
                        mentionContext && mentionSuggestions[activeMentionIndex]
                          ? `mention-option-${mentionSuggestions[activeMentionIndex].id}`
                          : undefined
                      }
                    />
                  </Suspense>
                ) : (
                  plainComposerInput
                )}
              </div>
              <div className="composer-footer">
                <button
                  type="button"
                  className="composer-attach"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label={t("添加附件")}
                  title={t("添加图片或文件（也可以粘贴截图、拖入文件）")}
                >
                  <PaperclipIcon />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => {
                    addAttachments([...(event.target.files ?? [])]);
                    event.target.value = "";
                  }}
                />
                {(attachmentNotice || attachmentQueue.failed) && (
                  <span className="composer-notice" role="status">
                    {attachmentNotice ?? t("有附件上传失败，请重试或移除后再发送")}
                  </span>
                )}
                {!richComposer && (draft.trim() || composerPreview) && (
                  <button
                    type="button"
                    className={`composer-tool ${composerPreview ? "active" : ""}`}
                    aria-pressed={composerPreview}
                    onClick={() => {
                      setComposerPreview((value) => !value);
                      if (composerPreview) {
                        window.requestAnimationFrame(() => textareaRef.current?.focus());
                      }
                    }}
                    title={
                      composerPreview
                        ? t("回到编辑（{0}）", { 0: `${modifierKeyLabel}+Shift+E` })
                        : t("预览 Markdown 效果（{0}）", { 0: `${modifierKeyLabel}+Shift+E` })
                    }
                  >
                    {composerPreview ? t("编辑") : t("预览")}
                  </button>
                )}
                <button
                  type="button"
                  className={`composer-tool composer-expand ${composerExpanded ? "active" : ""}`}
                  aria-pressed={composerExpanded}
                  aria-label={composerExpanded ? t("收起输入框") : t("展开输入框")}
                  title={
                    composerExpanded
                      ? t("收起输入框，回到普通高度")
                      : t("把输入框拉高到约半屏，写长内容更方便；发送后自动收回")
                  }
                  onClick={() => {
                    setComposerExpanded((value) => !value);
                    window.requestAnimationFrame(() => textareaRef.current?.focus());
                  }}
                >
                  <Icon name={composerExpanded ? "minimize" : "maximize"} size={15} />
                  <span>{composerExpanded ? t("收起") : t("展开")}</span>
                </button>
                <span className="composer-hint">
                  {/* 按当前发送方式显示：⌘↵ 发送 · ↵ 换行，或 ↵ 发送 · ⇧↵ 换行 */}
                  {t("{0} 发送 · {1} 换行")
                    .split(/(\{[01]\})/)
                    .map((part, index) => {
                      const keys =
                        sendShortcut === "modifier-enter"
                          ? { "{0}": ["Mod", "Enter"], "{1}": ["Enter"] }
                          : { "{0}": ["Enter"], "{1}": ["Shift", "Enter"] };
                      return part === "{0}" || part === "{1}" ? (
                        <KeyCombo key={index} keys={keys[part]} />
                      ) : (
                        part
                      );
                    })}
                </span>
                <div className="composer-actions">
                  {draftTooLong ? (
                    <span className="char-count danger" role="alert">
                      {t("超出 {0} 字，无法发送", {
                        0: (draft.trim().length - MAX_MESSAGE_LENGTH).toLocaleString(),
                      })}
                    </span>
                  ) : (
                    draft.length > MAX_MESSAGE_LENGTH * MESSAGE_LENGTH_WARNING_RATIO && (
                      <span className="char-count">
                        {draft.length.toLocaleString()}/{MAX_MESSAGE_LENGTH.toLocaleString()}
                      </span>
                    )
                  )}
                  {steerTargets.length > 0 && (
                    <button
                      type="button"
                      className="composer-steer"
                      onClick={() => sendMessage(true)}
                      disabled={!canSend || connectionState !== "online"}
                      title={t("{0} 正在执行任务：发出后直接用来引导它当前的任务，不排队", {
                        0: steerTargets.map((name) => `@${name}`).join(t("、")),
                      })}
                    >
                      {t("引导")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="composer-send"
                    onClick={() => sendMessage()}
                    disabled={!canSend || connectionState !== "online"}
                    title={t("发送")}
                  >
                    <span className="sr-only">{t("发送")}</span>
                    <Icon name="arrow-up" size={18} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <aside
          className={`members-panel panel ${mobilePanel === "members" ? "mobile-open" : ""}`}
          aria-label={t("成员列表")}
        >
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
                title={t("白板")}
                aria-selected={sidePanelTab === "whiteboard"}
                aria-controls="side-panel-whiteboard"
                tabIndex={sidePanelTab === "whiteboard" ? 0 : -1}
                className={sidePanelTab === "whiteboard" ? "active" : ""}
                onClick={() => setSidePanelTab("whiteboard")}
              >
                <Icon name="board" size={15} />
                <span className="side-tab-label">{t("白板")}</span>
                {whiteboardCurrentCount > 0 && (
                  <span
                    className={`side-tab-count ${whiteboardBlockedCount > 0 ? "warning" : ""}`}
                    aria-label={
                      whiteboardBlockedCount > 0
                        ? t("{0} 条，其中 {1} 条阻塞", {
                            0: whiteboardCurrentCount,
                            1: whiteboardBlockedCount,
                          })
                        : t("{0} 条", { 0: whiteboardCurrentCount })
                    }
                  >
                    {whiteboardCurrentCount}
                  </span>
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
              <WhiteboardPanel
                key={currentRoomId}
                entries={whiteboard}
                canManage={isOwner}
                onRemove={removeWhiteboardEntry}
                onArchive={changeWhiteboardArchive}
                loadHistory={loadWhiteboardHistory}
                historyEpoch={whiteboardEpochRef.current}
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
        </aside>
      </section>

      {activityView && (
        <ActivityPanel
          view={activityView}
          rooms={rooms}
          mentions={mentionMessages}
          readSeqs={readSeqs}
          invocations={[...activeInvocations.values()]}
          invocationMessages={invocationMessages}
          isAgentOnline={(invocation) =>
            invocation.roomId === currentRoomId
              ? participants.some(
                  (participant) =>
                    participant.username === invocation.agentName &&
                    participant.status !== "offline",
                )
              : onlineInvocationIds.has(invocation.id)
          }
          participants={participants}
          search={searchMessages}
          onOpenMessage={openMessage}
          onMarkMentionsRead={markMentionsRead}
          onDismiss={dismissInvocations}
          usageRoomId={currentRoomId}
          loadUsage={loadUsage}
          onStartTopic={() => {
            if (
              window.confirm(
                t(
                  "开启新话题后，房间里的 Agent 都会丢弃之前的会话、从新会话开始；历史消息保留。继续吗？",
                ),
              )
            ) {
              startNewTopic();
              closeActivity();
            }
          }}
          onClose={closeActivity}
        />
      )}

      {gotoOpen && (
        <GoToPalette
          items={buildGoToItems({
            rooms,
            currentRoomId,
            participants,
            invocations: activeInvocations.values(),
            attention: attention.items,
            messages: invocationMessages,
            statusLabel: (invocation) =>
              invocationStatusLabel(
                invocation,
                invocation.roomId === currentRoomId
                  ? participants.some(
                      (participant) =>
                        participant.id === invocation.agentId && participant.status !== "offline",
                    )
                  : onlineInvocationIds.has(invocation.id),
              ),
          })}
          onSelect={(item) => {
            if (item.kind === "room") switchRoom(item.room.id);
            else if (item.kind === "task") attention.open(item.invocation);
            else if (item.task) attention.open(item.task);
            else appendMention(item.participant.username);
          }}
          onNextAttention={jumpToNextAttention}
          onClose={() => setGotoOpen(false)}
        />
      )}
      {shortcutsOpen && <ShortcutsHelp onClose={() => setShortcutsOpen(false)} />}
      {contextMenu && <ContextMenu menu={contextMenu} onClose={closeContextMenu} />}
      {gotoNotice && (
        <div className="goto-toast" role="status">
          {gotoNotice}
        </div>
      )}

      {inviteDialogOpen && isOwner && authToken && (
        <InviteDialog
          base={base}
          adminToken={authToken}
          roomId={currentRoomId}
          linkFor={(token) => `${inviteLink()}?invite=${token}`}
          onClose={() => setInviteDialogOpen(false)}
        />
      )}
      {retryModelFor && (
        <RetryModelDialog
          key={retryModelFor.id}
          agentName={retryModelFor.agentName}
          currentModel={retryModelAgent?.model}
          load={
            retryModelAgent ? (refresh) => local.models(retryModelAgent.id, refresh) : undefined
          }
          onRetry={(model) => {
            retryInvocation(retryModelFor, model);
            setRetryModelFor(undefined);
          }}
          onClose={() => setRetryModelFor(undefined)}
        />
      )}
      {settingsAgent && (
        <AgentSettingsDialog
          key={settingsAgent.id}
          agent={settingsAgent}
          local={local}
          onOpenTerminal={() => void openAgentTerminal(settingsAgent)}
          onClose={() => setSettingsAgentId(undefined)}
        />
      )}
      {imDialogOpen && isOwner && authToken && (
        <ImDialog
          base={base}
          adminToken={authToken}
          roomId={currentRoomId}
          ownerName={username}
          rooms={rooms
            .filter((room) => !room.archivedAt)
            .map((room) => ({ id: room.id, name: room.name }))}
          onClose={() => setImDialogOpen(false)}
        />
      )}
      {guestAgentDialogOpen && guest && (
        <GuestAgentDialog
          base={base}
          guestToken={guest.token}
          expiresAt={
            participants.find(
              (participant) =>
                participant.username.toLocaleLowerCase() === guest.username.toLocaleLowerCase(),
            )?.access?.expiresAt ?? guest.expiresAt
          }
          onClose={() => setGuestAgentDialogOpen(false)}
        />
      )}

      {agentDialogOpen && (
        <div className="agent-dialog-layer">
          <button
            className="agent-dialog-scrim"
            type="button"
            aria-label={t("关闭 Agent 接入弹窗")}
            onClick={closeAgentDialog}
          />
          <div
            ref={agentDialogRef}
            className="agent-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-dialog-title"
            aria-describedby="agent-dialog-description"
          >
            <header className="agent-dialog-header">
              <div>
                <h2 id="agent-dialog-title">{t("把 Agent 接入 Hive")}</h2>
                <p id="agent-dialog-description">
                  {local.enabled
                    ? local.mode === "device"
                      ? t(
                          "三步完成：选择 Agent、设置权限，然后一键在 {0} 上启动（也可以复制命令）。",
                          { 0: local.hostLabel ?? t("Server 所在电脑") },
                        )
                      : t(
                          "三步完成：选择 Agent、设置本机权限，然后一键在本机启动（也可以复制命令）。",
                        )
                    : t("三步完成：选择 Agent、设置本机权限，然后把命令复制到终端运行。")}
                </p>
              </div>
              <button
                ref={agentDialogCloseRef}
                className="agent-dialog-close"
                type="button"
                aria-label={t("关闭")}
                onClick={closeAgentDialog}
              >
                <Icon name="close" />
              </button>
            </header>

            <ol className="agent-steps" aria-label={t("接入步骤")}>
              {agentSetupSteps.map(({ step, label: baseLabel }) => {
                const label = step === 3 && local.enabled ? t("启动 Agent") : baseLabel;
                const state =
                  step === agentStep ? "current" : step < agentStep ? "done" : "upcoming";
                return (
                  <li
                    key={step}
                    className={state}
                    aria-current={state === "current" ? "step" : undefined}
                  >
                    {state === "done" ? (
                      <button
                        type="button"
                        aria-label={t("返回第 {0} 步：{1}", { 0: step, 1: label })}
                        onClick={() => goToAgentStep(step)}
                      >
                        <span className="agent-step-index" aria-hidden="true">
                          <Icon name="check" size={12} />
                        </span>
                        <span>{label}</span>
                      </button>
                    ) : (
                      <span>
                        <span className="agent-step-index" aria-hidden="true">
                          {step}
                        </span>
                        <span>{label}</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>

            <div className="agent-dialog-body">
              <div className="agent-step-heading">
                <h3 id="agent-step-title" ref={agentStepHeadingRef} tabIndex={-1}>
                  {agentStep === 1
                    ? t("选择要接入的 Agent")
                    : agentStep === 2
                      ? t("允许 {0} 在本机做什么？", { 0: agentProviderLabel(agentProvider) })
                      : local.enabled
                        ? local.mode === "device"
                          ? t("在 {0} 上启动", { 0: local.hostLabel ?? t("Server 所在电脑") })
                          : t("在本机启动")
                        : t("复制命令，到终端运行")}
                </h3>
                {agentStep === 1 && (
                  <p>{t("选好后点「下一步」；接入命令会按所选 Agent 的运行环境自动调整。")}</p>
                )}
                {agentStep === 2 && (
                  <p>
                    {t("权限只在 Agent 所在电脑生效，Hive Server 始终只转发消息。默认工作区档。")}
                  </p>
                )}
                {agentStep === 3 && (
                  <p>
                    {t("将以")}{" "}
                    <code>{agentNameFor(username, agentProvider, takenAgentNames)}</code>{" "}
                    {t("身份加入 · 权限：")}
                    <strong className={`agent-access-label ${agentAccess}`}>
                      {agentAccessOptions.find((option) => option.id === agentAccess)?.label}
                    </strong>
                  </p>
                )}
              </div>

              {agentStep === 1 && (
                <div
                  className="provider-selector"
                  role="radiogroup"
                  aria-labelledby="agent-step-title"
                  onKeyDown={(event) =>
                    moveRadioSelection(
                      event,
                      selectableAgentProviders.indexOf(agentProvider),
                      (index) => {
                        setAgentProvider(selectableAgentProviders[index]!);
                        setAgentProviderChosen(true);
                      },
                    )
                  }
                >
                  {selectableAgentProviders.map((provider) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={agentProviderChosen && agentProvider === provider}
                      tabIndex={
                        agentProvider === provider ||
                        (!agentProviderChosen && provider === selectableAgentProviders[0])
                          ? 0
                          : -1
                      }
                      className={[
                        agentProviderChosen && agentProvider === provider ? "active" : "",
                        providerInfo(local, provider)?.installed === false ? "unavailable" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      // 只选中，不自动跳步：选好后由人点「下一步」，可以先比较、改主意
                      onClick={() => {
                        setAgentProvider(provider);
                        setAgentProviderChosen(true);
                      }}
                      key={provider}
                    >
                      <span className="provider-monogram" aria-hidden="true">
                        <ProviderLogo provider={provider} />
                      </span>
                      <span className="provider-copy">
                        <strong>{agentProviderLabel(provider)}</strong>
                        <small>
                          {(() => {
                            const info = providerInfo(local, provider);
                            if (!info) return agentProviderDescriptions[provider];
                            return info.installed
                              ? `${agentProviderDescriptions[provider]}${info.version ? ` · ${info.version}` : ""}`
                              : t("本机未安装");
                          })()}
                        </small>
                      </span>
                      <span className="provider-check" aria-hidden="true">
                        <Icon name="check" size={15} />
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {agentStep === 2 && (
                <>
                  <div>
                    <div
                      className="access-selector"
                      role="radiogroup"
                      aria-labelledby="agent-step-title"
                      onKeyDown={(event) =>
                        moveRadioSelection(
                          event,
                          agentAccessOptions.findIndex((option) => option.id === agentAccess),
                          (index) => chooseAgentAccess(agentAccessOptions[index]!.id),
                        )
                      }
                    >
                      {agentAccessOptions.map((option) => (
                        <button
                          type="button"
                          role="radio"
                          ref={option.id === "full" ? fullAccessOptionRef : undefined}
                          aria-checked={agentAccess === option.id}
                          aria-expanded={
                            option.id === "full" ? fullAccessConfirmationOpen : undefined
                          }
                          tabIndex={agentAccess === option.id ? 0 : -1}
                          className={`${option.id} ${agentAccess === option.id ? "active" : ""}`}
                          // 只选中，不自动跳步；完全访问要先在选项旁的气泡里确认风险
                          onClick={() => chooseAgentAccess(option.id)}
                          key={option.id}
                        >
                          <span className="access-indicator" aria-hidden="true">
                            <i />
                          </span>
                          <strong>{option.label}</strong>
                          <small>{option.description}</small>
                        </button>
                      ))}
                    </div>
                    {fullAccessConfirmationOpen && agentAccess !== "full" && (
                      <ConfirmPopover
                        ariaLabel={t("确认开启完全访问")}
                        title={t("确认移除本机安全边界？")}
                        message={t(
                          "{0} 将可以执行当前系统用户有权进行的操作；房间消息可能触发文件、命令或网络操作。",
                          { 0: agentProviderLabel(agentProvider) },
                        )}
                        confirmLabel={t("我了解风险，开启完全访问")}
                        cancelLabel={t("取消")}
                        anchorRef={fullAccessOptionRef}
                        danger
                        onConfirm={confirmFullAccess}
                        onCancel={closeFullAccessConfirmation}
                      />
                    )}
                  </div>
                  {agentProvider === "openclaw" && (
                    <p className="openclaw-access-note">
                      {t(
                        "OpenClaw 的实际权限还需在其 Agent / Gateway 中设置；Hive 不会自动改写全局策略。",
                      )}
                    </p>
                  )}
                  {agentProvider === "omp" && agentAccess === "workspace" && (
                    <p className="openclaw-access-note">
                      {t(
                        "omp 不会把文件写入限制在当前目录内；需要目录隔离时请选择 OpenCode、Codex 或 Claude Code。",
                      )}
                    </p>
                  )}
                </>
              )}

              {agentStep === 3 &&
                (() => {
                  // 复制命令这一整段：本机模式下折叠为"或复制命令"，否则直接展示
                  const commandSection = (
                    <>
                      <div className="command">
                        <div className="command-heading">
                          <span className="terminal-dots" aria-hidden="true">
                            <i />
                            <i />
                            <i />
                          </span>
                          <small>{t("终端")}</small>
                        </div>
                        <code>{selectedAgentCommand}</code>
                        <button type="button" disabled={!meta} onClick={() => void copyCommand()}>
                          <Icon name={commandCopied ? "check" : "copy"} size={16} />
                          <span>{commandCopied ? t("已复制到剪贴板") : t("复制命令")}</span>
                        </button>
                      </div>
                      {copyError && (
                        <p className="command-copy-error" role="alert">
                          {copyError}
                        </p>
                      )}
                      {meta?.agentCommand && !meta.agentCommand.startsWith("npx") && (
                        <p className="command-dev-note">
                          {t(
                            "开发模式命令：请在 superhive 仓库根目录的终端运行，使用的是当前仓库代码， 而非已发布的 npm 包。",
                          )}
                        </p>
                      )}
                      <ol className="agent-next-steps" aria-label={t("接入后的操作")}>
                        <li>
                          {t(
                            "在 {0} 所在电脑的终端运行这条命令，Agent 会加入所有房间并保持每个房间的独立上下文。",
                            { 0: agentProviderLabel(agentProvider) },
                          )}
                        </li>
                        <li>
                          {t("在消息中输入")}{" "}
                          <code>@{agentNameFor(username, agentProvider, takenAgentNames)}</code>{" "}
                          {t("即可让它响应；没被 @ 时它只会旁听。")}
                        </li>
                        <li>
                          {t("终端按")} <kbd>Ctrl + C</kbd>{" "}
                          {t("即可让它离线。只想加入单个房间可在命令后追加")}{" "}
                          <code>{t("--room 房间ID")}</code>
                          {t("。")}
                        </li>
                      </ol>
                    </>
                  );
                  return local.enabled ? (
                    <>
                      <HostManageNotice local={local} compact />
                      <LocalLaunch
                        local={local}
                        provider={agentProvider}
                        access={agentAccess}
                        defaultName={agentNameFor(username, agentProvider, takenAgentNames)}
                        takenNames={takenAgentNames}
                        providerLabel={agentProviderLabel(agentProvider)}
                        onLaunched={() => setAgentConnected(true)}
                      >
                        {commandSection}
                      </LocalLaunch>
                    </>
                  ) : (
                    commandSection
                  );
                })()}
            </div>

            <footer className="agent-dialog-footer">
              {agentStep === 3 && (
                <div className="agent-dialog-links">
                  <details className="connection-details">
                    <summary>{t("查看连接信息")}</summary>
                    <dl>
                      <div>
                        <dt>{t("服务地址")}</dt>
                        <dd>
                          <code>{meta?.httpUrl ?? base}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Hive MCP</dt>
                        <dd>
                          <code>{meta?.mcpUrl ?? `${base}/mcp`}</code>
                        </dd>
                      </div>
                    </dl>
                  </details>
                  <a
                    className="agent-doc"
                    href={`${base}/agent.md`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("行为与安全规则")} <Icon name="external" size={15} />
                  </a>
                </div>
              )}
              <div className="agent-dialog-nav">
                {agentStep > 1 && (
                  <button
                    type="button"
                    onClick={() => goToAgentStep((agentStep - 1) as AgentSetupStep)}
                  >
                    {t("上一步")}
                  </button>
                )}
                {agentStep < 3 ? (
                  <button
                    type="button"
                    className="primary"
                    disabled={agentStep === 1 && !agentProviderChosen}
                    title={
                      agentStep === 1 && !agentProviderChosen ? t("先选一个 Agent") : undefined
                    }
                    onClick={() => goToAgentStep((agentStep + 1) as AgentSetupStep)}
                  >
                    <span>{t("下一步")}</span>
                    <Icon name="arrow-right" size={16} />
                  </button>
                ) : (
                  agentConnected && (
                    <button type="button" className="primary" onClick={closeAgentDialog}>
                      {t("完成")}
                    </button>
                  )
                )}
              </div>
            </footer>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="settings-dialog-layer">
          <button
            className="settings-dialog-scrim"
            type="button"
            aria-label={t("关闭设置")}
            onClick={closeSettings}
          />
          <div
            ref={settingsDialogRef}
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-dialog-title"
          >
            <header className="settings-dialog-header">
              <div>
                <h2 id="settings-dialog-title">{t("偏好设置")}</h2>
              </div>
              <button
                ref={settingsCloseRef}
                type="button"
                aria-label={t("关闭设置")}
                onClick={closeSettings}
              >
                <Icon name="close" />
              </button>
            </header>
            <div className="settings-dialog-layout">
              <nav className="settings-tabs" aria-label={t("设置分类")} role="tablist">
                {visibleSettingsTabs.map((tab, index) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={settingsTab === tab.id}
                    aria-controls={`settings-panel-${tab.id}`}
                    tabIndex={settingsTab === tab.id ? 0 : -1}
                    className={settingsTab === tab.id ? "active" : ""}
                    onClick={() => setSettingsTab(tab.id)}
                    onKeyDown={(event) => {
                      if (
                        !["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)
                      ) {
                        return;
                      }
                      event.preventDefault();
                      const direction =
                        event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
                      const nextIndex =
                        (index + direction + visibleSettingsTabs.length) %
                        visibleSettingsTabs.length;
                      setSettingsTab(visibleSettingsTabs[nextIndex]!.id);
                      window.requestAnimationFrame(() => {
                        const tabs =
                          settingsDialogRef.current?.querySelectorAll<HTMLButtonElement>(
                            '[role="tab"]',
                          );
                        tabs?.[nextIndex]?.focus();
                      });
                    }}
                    key={tab.id}
                  >
                    <strong>
                      {tab.id === "computer" && local.mode === "device"
                        ? t("Server 所在电脑")
                        : tab.label}
                    </strong>
                    <small>{tab.description}</small>
                  </button>
                ))}
              </nav>

              <div className="settings-dialog-content">
                {settingsTab === "chat" && (
                  <section id="settings-panel-chat" role="tabpanel" aria-label={t("聊天与输入")}>
                    <div className="settings-panel-heading">
                      <h3>{t("聊天与输入")}</h3>
                      <p>{t("控制消息如何编辑、发送和显示。")}</p>
                    </div>

                    <div className="settings-group">
                      <div className="settings-section-heading">
                        <div>
                          <h4>{t("发送消息")}</h4>
                          <p>{t("选择在输入框中发送消息的快捷键。")}</p>
                        </div>
                      </div>
                      <div
                        className="shortcut-selector"
                        role="radiogroup"
                        aria-label={t("发送快捷键")}
                      >
                        <button
                          type="button"
                          role="radio"
                          aria-checked={sendShortcut === "modifier-enter"}
                          className={sendShortcut === "modifier-enter" ? "active" : ""}
                          onClick={() => {
                            setSendShortcut("modifier-enter");
                            localStorage.setItem(storedSendShortcutKey, "modifier-enter");
                          }}
                        >
                          <span>
                            <strong>{t("组合键发送")}</strong>
                            <small>{t("推荐，Enter 可以安心换行")}</small>
                          </span>
                          <KeyCombo keys={["Mod", "Enter"]} />
                          <i aria-hidden="true">
                            <Icon name="check" size={14} />
                          </i>
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={sendShortcut === "enter"}
                          className={sendShortcut === "enter" ? "active" : ""}
                          onClick={() => {
                            setSendShortcut("enter");
                            localStorage.setItem(storedSendShortcutKey, "enter");
                          }}
                        >
                          <span>
                            <strong>{t("Enter 发送")}</strong>
                            <small>
                              {t("{0} 换行")
                                .split(/(\{0\})/)
                                .map((part, index) =>
                                  part === "{0}" ? (
                                    <KeyCombo key={index} keys={["Shift", "Enter"]} />
                                  ) : (
                                    part
                                  ),
                                )}
                            </small>
                          </span>
                          <KeyCombo keys={["Enter"]} />
                          <i aria-hidden="true">
                            <Icon name="check" size={14} />
                          </i>
                        </button>
                      </div>
                    </div>

                    <div className="settings-group divided">
                      <SettingsSwitch
                        checked={autoSaveDraft}
                        label={t("自动保存草稿")}
                        description={t("刷新或重新打开页面后恢复未发送内容")}
                        onChange={(checked) => {
                          setAutoSaveDraft(checked);
                          localStorage.setItem(storedAutoSaveDraftKey, String(checked));
                          if (!checked && username) {
                            localStorage.removeItem(draftStorageKey(username, currentRoomId));
                          } else if (checked && username && draft) {
                            localStorage.setItem(draftStorageKey(username, currentRoomId), draft);
                          }
                        }}
                      />
                      <SettingsSwitch
                        checked={richComposer}
                        label={t("输入框直接显示格式")}
                        description={t(
                          "像飞书一样边写边显示标题、列表、加粗、代码；关掉则是纯文本 Markdown，可手动预览",
                        )}
                        onChange={(checked) => {
                          setRichComposer(checked);
                          setComposerPreview(false);
                          localStorage.setItem(storedRichComposerKey, String(checked));
                        }}
                      />
                      <div className="settings-inline-row">
                        <span>
                          <strong>{t("时间格式")}</strong>
                          <small>{t("消息时间戳的显示方式")}</small>
                        </span>
                        <div
                          className="compact-choice"
                          role="radiogroup"
                          aria-label={t("时间格式")}
                        >
                          {(["system", "24h", "12h"] as const).map((value) => (
                            <button
                              type="button"
                              role="radio"
                              aria-checked={timeFormat === value}
                              className={timeFormat === value ? "active" : ""}
                              onClick={() => {
                                setTimeFormat(value);
                                localStorage.setItem(storedTimeFormatKey, value);
                              }}
                              key={value}
                            >
                              {value === "system"
                                ? t("系统")
                                : value === "24h"
                                  ? t("24 小时")
                                  : t("12 小时")}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </section>
                )}

                {settingsTab === "notifications" && (
                  <section id="settings-panel-notifications" role="tabpanel" aria-label={t("通知")}>
                    <div className="settings-panel-heading">
                      <h3>{t("通知")}</h3>
                      <p>{t("只在你需要关注时发出清晰信号。")}</p>
                    </div>
                    {notificationPermission !== "granted" &&
                      notificationPermission !== "default" && (
                        <div className="notification-permission-note" role="status">
                          <Icon name="shield" size={16} />
                          <span>
                            {notificationPermission === "unsupported"
                              ? t("当前浏览器不支持系统通知。")
                              : t("系统通知已被浏览器阻止，请在站点权限中重新允许。")}
                          </span>
                        </div>
                      )}
                    {notificationPermission === "default" && messageNotifications !== "off" && (
                      <div className="notification-permission-note" role="status">
                        <Icon name="bell" size={16} />
                        <span>{t("浏览器尚未授权通知，当前选项要等授权后才会生效。")}</span>
                        <button type="button" onClick={() => void ensureNotificationPermission()}>
                          {t("立即授权")}
                        </button>
                      </div>
                    )}
                    <div className="settings-group">
                      <div className="settings-section-heading">
                        <div>
                          <h4>{t("消息通知")}</h4>
                          <p>{t("页面不在前台时，通过系统通知提醒我。")}</p>
                        </div>
                      </div>
                      <div
                        className="shortcut-selector notification-modes"
                        role="radiogroup"
                        aria-label={t("消息通知")}
                      >
                        {messageNotificationOptions.map((option) => (
                          <button
                            type="button"
                            role="radio"
                            aria-checked={messageNotifications === option.id}
                            disabled={
                              notificationPermission === "unsupported" && option.id !== "off"
                            }
                            className={messageNotifications === option.id ? "active" : ""}
                            onClick={() => void updateMessageNotifications(option.id)}
                            key={option.id}
                          >
                            <span>
                              <strong>{option.label}</strong>
                              <small>{option.description}</small>
                            </span>
                            <i aria-hidden="true">
                              <Icon name="check" size={14} />
                            </i>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="settings-group divided">
                      <div className="settings-section-heading">
                        <div>
                          <h4>{t("任务提醒")}</h4>
                          <p>
                            {t(
                              "你发起的任务等你回答、失败、结果未知或做完了，以及等你放行的任务，不管在哪个房间都提醒；正看着那个房间时不打扰。",
                            )}
                          </p>
                        </div>
                      </div>
                      <div
                        className="shortcut-selector notification-modes"
                        role="radiogroup"
                        aria-label={t("任务提醒")}
                      >
                        {attentionDeliveryOptions.map((option) => (
                          <button
                            type="button"
                            role="radio"
                            aria-checked={attentionDelivery === option.id}
                            className={attentionDelivery === option.id ? "active" : ""}
                            onClick={() => void updateAttentionDelivery(option.id)}
                            key={option.id}
                          >
                            <span>
                              <strong>{option.label}</strong>
                              <small>{option.description}</small>
                            </span>
                            <i aria-hidden="true">
                              <Icon name="check" size={14} />
                            </i>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="settings-group divided settings-switch-list">
                      <SettingsSwitch
                        checked={attentionSound}
                        disabled={attentionDelivery === "off"}
                        label={t("任务提醒提示音")}
                        description={t("需要你处理时响两声，做完时响一声")}
                        onChange={(checked) => {
                          setAttentionSound(checked);
                          localStorage.setItem(storedAttentionSoundKey, String(checked));
                          if (checked) playAttentionTone("question");
                        }}
                      />
                      <SettingsSwitch
                        checked={attentionGroup}
                        label={t("侧栏显示「需要你处理」")}
                        description={t(
                          "在房间列表上方列出待处理的任务，点一下直接跳过去；不影响房间顺序",
                        )}
                        onChange={(checked) => {
                          setAttentionGroup(checked);
                          localStorage.setItem(storedAttentionGroupKey, String(checked));
                        }}
                      />
                      <SettingsSwitch
                        checked={notificationSound}
                        label={t("新消息提示音")}
                        description={t("收到其他成员的新消息时播放轻提示音")}
                        onChange={(checked) => {
                          setNotificationSound(checked);
                          localStorage.setItem(storedNotificationSoundKey, String(checked));
                          if (checked) playNotificationTone();
                        }}
                      />
                      <SettingsSwitch
                        checked={presenceNotifications}
                        disabled={notificationPermission === "unsupported"}
                        label={t("Agent 上下线")}
                        description={t("页面不在前台时，提醒 Agent 离线或重新上线")}
                        onChange={(checked) => void updatePresenceNotifications(checked)}
                      />
                    </div>
                    <p className="settings-local-note">
                      {t("浏览器通知只在页面不处于前台时显示；提示音设置独立生效。")}
                    </p>
                  </section>
                )}

                {settingsTab === "computer" && (
                  <section id="settings-panel-computer" role="tabpanel" aria-label={t("这台电脑")}>
                    <div className="settings-panel-heading">
                      <h3>
                        {local.mode === "device"
                          ? t("Server 所在电脑（{0}）", { 0: local.hostLabel ?? "" })
                          : t("这台电脑")}
                      </h3>
                      <p>
                        {local.mode === "device"
                          ? t("运行 Hive Server 的那台电脑的设置，对所有房间生效。")
                          : t("运行 Hive Server 的这台电脑的设置，对所有房间生效。")}
                      </p>
                    </div>
                    <HostManageNotice local={local} />
                    <KeepAwakeSettingsGroup local={local} />
                    <OwnerDevicesGroup local={local} />
                  </section>
                )}
                {settingsTab === "runtimes" && local.mode === "local" && (
                  <AgentRuntimesPanel local={local} />
                )}
                {settingsTab === "appearance" && (
                  <section id="settings-panel-appearance" role="tabpanel" aria-label={t("外观")}>
                    <div className="settings-panel-heading">
                      <h3>{t("外观")}</h3>
                      <p>{t("调整界面气氛与信息密度，不影响其他成员。")}</p>
                    </div>

                    <div className="settings-group">
                      <div className="settings-section-heading">
                        <div>
                          <h4>{t("界面主题")}</h4>
                          <p>{t("系统主题变化时可以自动跟随。")}</p>
                        </div>
                      </div>
                      <div
                        className="visual-choice-grid"
                        role="radiogroup"
                        aria-label={t("界面主题")}
                      >
                        {(["system", "dark", "light"] as const).map((value) => (
                          <button
                            type="button"
                            role="radio"
                            aria-checked={themePreference === value}
                            className={`${value} ${themePreference === value ? "active" : ""}`}
                            onClick={() => {
                              setThemePreference(value);
                              localStorage.setItem(storedThemeKey, value);
                            }}
                            key={value}
                          >
                            <i aria-hidden="true">
                              <span />
                            </i>
                            <strong>
                              {value === "system"
                                ? t("跟随系统")
                                : value === "dark"
                                  ? t("深色")
                                  : t("浅色")}
                            </strong>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="settings-group divided settings-switch-list">
                      <div className="settings-inline-row">
                        <span>
                          <strong>{t("界面语言")}</strong>
                          <small>{t("只影响你自己看到的界面，聊天内容不翻译")}</small>
                        </span>
                        <div
                          className="compact-choice"
                          role="radiogroup"
                          aria-label={t("界面语言")}
                        >
                          {LOCALE_OPTIONS.map((option) => (
                            <button
                              type="button"
                              role="radio"
                              aria-checked={localePreference === option.value}
                              className={localePreference === option.value ? "active" : ""}
                              onClick={() => setLocalePreference(option.value)}
                              key={option.value}
                            >
                              {option.value === "system" ? t(option.label) : option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="settings-inline-row">
                        <span>
                          <strong>{t("界面密度")}</strong>
                          <small>{t("控制成员和消息之间的留白")}</small>
                        </span>
                        <div
                          className="compact-choice"
                          role="radiogroup"
                          aria-label={t("界面密度")}
                        >
                          {(["comfortable", "compact"] as const).map((value) => (
                            <button
                              type="button"
                              role="radio"
                              aria-checked={interfaceDensity === value}
                              className={interfaceDensity === value ? "active" : ""}
                              onClick={() => {
                                setInterfaceDensity(value);
                                localStorage.setItem(storedDensityKey, value);
                              }}
                              key={value}
                            >
                              {value === "comfortable" ? t("舒适") : t("紧凑")}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="settings-inline-row">
                        <span>
                          <strong>{t("消息区宽度")}</strong>
                          <small>{t("宽屏下消息和输入框能用多宽；手机上不受影响")}</small>
                        </span>
                        <div
                          className="compact-choice"
                          role="radiogroup"
                          aria-label={t("消息区宽度")}
                        >
                          {(["standard", "wide", "full"] as const).map((value) => (
                            <button
                              type="button"
                              role="radio"
                              aria-checked={threadWidth === value}
                              className={threadWidth === value ? "active" : ""}
                              onClick={() => {
                                setThreadWidth(value);
                                localStorage.setItem(storedThreadWidthKey, value);
                              }}
                              key={value}
                            >
                              {value === "standard"
                                ? t("标准宽度")
                                : value === "wide"
                                  ? t("加宽")
                                  : t("铺满")}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="settings-inline-row">
                        <span>
                          <strong>{t("消息字号")}</strong>
                          <small>{t("只调整消息正文和输入文字")}</small>
                        </span>
                        <div
                          className="compact-choice"
                          role="radiogroup"
                          aria-label={t("消息字号")}
                        >
                          {(["small", "standard", "large"] as const).map((value) => (
                            <button
                              type="button"
                              role="radio"
                              aria-checked={messageSize === value}
                              className={messageSize === value ? "active" : ""}
                              onClick={() => {
                                setMessageSize(value);
                                localStorage.setItem(storedMessageSizeKey, value);
                              }}
                              key={value}
                            >
                              {value === "small"
                                ? t("小")
                                : value === "standard"
                                  ? t("标准")
                                  : t("大")}
                            </button>
                          ))}
                        </div>
                      </div>
                      <SettingsSwitch
                        checked={reduceMotion}
                        label={t("减少动态效果")}
                        description={t("关闭浮层、状态和界面的过渡动画")}
                        onChange={(checked) => {
                          setReduceMotion(checked);
                          localStorage.setItem(storedReduceMotionKey, String(checked));
                        }}
                      />
                    </div>
                  </section>
                )}

                <p className="settings-local-note settings-persistence-note">
                  {t("所有偏好即时生效，并且只保存在当前浏览器中。")}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {roomDialog && (
        <div className="room-dialog-layer">
          <button
            className="room-dialog-scrim"
            type="button"
            aria-label={t("关闭房间弹窗")}
            onClick={closeRoomDialog}
          />
          <div
            ref={roomDialogRef}
            className="room-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="room-dialog-title"
          >
            <header className="room-dialog-header">
              <div>
                <h2 id="room-dialog-title">
                  {roomDialog.mode === "create"
                    ? t("新建房间")
                    : t("房间设置 · # {0}", { 0: roomDialog.room.id })}
                </h2>
              </div>
              <button
                ref={roomDialogCloseRef}
                type="button"
                aria-label={t("关闭")}
                onClick={closeRoomDialog}
              >
                <Icon name="close" />
              </button>
            </header>
            <form
              className="room-dialog-body"
              onSubmit={(event) => {
                event.preventDefault();
                if (roomDialog.mode === "create") void submitCreateRoom();
                else void submitRenameRoom(roomDialog.room);
              }}
            >
              {roomDialog.mode === "create" && (
                <label className="room-field">
                  <span>{t("房间 ID")}</span>
                  <input
                    value={roomDialogId}
                    onChange={(event) => setRoomDialogId(event.target.value)}
                    maxLength={64}
                    placeholder={t("例如 frontend")}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <small>
                    {t("仅字母、数字、下划线与连字符；创建后不可修改，Agent 用它加入。")}
                  </small>
                </label>
              )}
              <label className="room-field">
                <span>
                  {t("显示名称{0}", { 0: roomDialog.mode === "create" ? t("（可选）") : "" })}
                </span>
                <input
                  value={roomDialogName}
                  onChange={(event) => setRoomDialogName(event.target.value)}
                  maxLength={64}
                  placeholder={roomDialog.mode === "create" ? t("默认与房间 ID 相同") : ""}
                />
                <small>{t("仅影响界面展示，可随时修改。")}</small>
              </label>
              {isOwner && (
                <label className="room-field">
                  <span>{t("工作区（可选）")}</span>
                  <div className="local-launch-cwd-row">
                    <input
                      value={roomDialogWorkspace}
                      onChange={(event) => setRoomDialogWorkspace(event.target.value)}
                      maxLength={4096}
                      placeholder={t("例如 ~/Coding/my-project，留空用各 Agent 自己的目录")}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    {local.enabled && (
                      <button
                        type="button"
                        aria-expanded={roomWorkspacePicking}
                        onClick={() => setRoomWorkspacePicking((current) => !current)}
                      >
                        {t("选择…")}
                      </button>
                    )}
                  </div>
                  <small>
                    {local.mode === "device"
                      ? t(
                          "Server 所在电脑（{0}）上的目录。在网页上启动的本机 Agent 会在这个房间改到这里工作；用命令行手动接入的 Agent 只跟随它启动目录及其上一级（或 --allow-root 追加的目录）。修改后 Agent 等手上的任务做完再切换，并开始新会话。",
                          { 0: local.hostLabel ?? "" },
                        )
                      : t(
                          "这台电脑上的目录。在网页上启动的本机 Agent 会在这个房间改到这里工作；用命令行手动接入的 Agent 只跟随它启动目录及其上一级（或 --allow-root 追加的目录）。修改后 Agent 等手上的任务做完再切换，并开始新会话。",
                        )}
                  </small>
                </label>
              )}
              {isOwner && roomDialog.mode === "manage" && (
                <label className="room-field">
                  <span>{t("主 Agent（可选）")}</span>
                  <Select
                    value={roomDialogLead}
                    onChange={setRoomDialogLead}
                    options={[
                      { value: "", label: t("不设置") },
                      ...(roomDialogLead &&
                      !leadCandidates(roomDialog.room).includes(roomDialogLead)
                        ? [{ value: roomDialogLead, label: roomDialogLead }]
                        : []),
                      ...leadCandidates(roomDialog.room).map((name) => ({
                        value: name,
                        label: name,
                        icon: (
                          <span className="avatar agent select-avatar" aria-hidden="true">
                            <AvatarGlyph
                              type="agent"
                              name={name}
                              provider={agentProviderByName.get(name.toLocaleLowerCase())}
                            />
                          </span>
                        ),
                      })),
                    ]}
                  />
                  {roomDialogLead &&
                    roomDialog.room.id === currentRoomId &&
                    !leadCandidates(roomDialog.room).includes(roomDialogLead) && (
                      <small className="room-field-warning" role="alert">
                        {t("主 Agent {0} 已不在这个房间，不带 @ 的消息现在没人接，请重新选择。", {
                          0: roomDialogLead,
                        })}
                      </small>
                    )}
                  <small>
                    {roomDialog.room.id === currentRoomId
                      ? t(
                          "人发的、没有 @ 任何人的消息交给它接话，由它决定自己做还是用 hive_invoke 分派给其他 Agent；带 @ 的消息照常只发给被 @ 的成员。",
                        )
                      : t("进入这个房间后才能从它的 Agent 里选择。")}
                  </small>
                </label>
              )}
              {isOwner && roomWorkspacePicking && local.enabled && (
                <DirectoryPicker
                  load={local.directories}
                  value={roomDialogWorkspace}
                  onPick={(picked) => {
                    setRoomDialogWorkspace(picked);
                    setRoomWorkspacePicking(false);
                  }}
                  onClose={() => setRoomWorkspacePicking(false)}
                />
              )}
              {isOwner &&
                local.enabled &&
                roomDialog.mode === "manage" &&
                roomDialog.room.workspace && (
                  <WorktreePanel key={roomDialog.room.id} roomId={roomDialog.room.id} api={local} />
                )}
              {roomDialogError && (
                <p className="room-dialog-error" role="alert">
                  {roomDialogError}
                </p>
              )}
              {roomDialog.mode === "manage" &&
                archiveConfirmOpen &&
                !roomDialog.room.archivedAt && (
                  <div className="room-archive-confirmation" role="alert">
                    <div>
                      <strong>{t("确认归档该房间？")}</strong>
                      <p>{t("归档后成员无法再加入，历史消息保留；随时可以恢复。")}</p>
                    </div>
                    <div className="room-archive-actions">
                      <button type="button" onClick={() => setArchiveConfirmOpen(false)}>
                        {t("取消")}
                      </button>
                      <button
                        type="button"
                        disabled={roomDialogBusy}
                        onClick={() => void setRoomArchived(roomDialog.room, true)}
                      >
                        {t("确认归档")}
                      </button>
                    </div>
                  </div>
                )}
              {roomDialog.mode === "manage" && clearConfirmOpen && (
                <div className="room-archive-confirmation" role="alert">
                  <div>
                    <strong>{t("确认清空 # {0}？", { 0: roomDialog.room.name })}</strong>
                    <p>
                      {t(
                        "将删除这个房间的全部消息和 Agent 调用记录，无法恢复；房间里的 Agent 会从新会话开始。",
                      )}
                    </p>
                    <label>
                      <input
                        type="checkbox"
                        checked={clearWhiteboard}
                        disabled={roomDialogBusy}
                        onChange={(event) => setClearWhiteboard(event.target.checked)}
                      />
                      {t("同时归档当前白板（历史可恢复）")}
                    </label>
                    <p>
                      {clearWhiteboard
                        ? t(
                            "进行中和阻塞的事项也会一起归档；仍占用工作区的事项会阻止清空，请先清理对应 worktree。",
                          )
                        : t("仅清空聊天与调用记录，保留白板，不解除工作区占用。")}
                    </p>
                  </div>
                  <div className="room-archive-actions">
                    <button type="button" onClick={() => setClearConfirmOpen(false)}>
                      {t("取消")}
                    </button>
                    <button
                      type="button"
                      disabled={roomDialogBusy}
                      onClick={() => void clearRoom(roomDialog.room)}
                    >
                      {t("确认清空")}
                    </button>
                  </div>
                </div>
              )}
              <footer className="room-dialog-footer">
                {roomDialog.mode === "manage" && local.enabled && !roomDialog.room.archivedAt && (
                  <button
                    type="button"
                    className="room-archive"
                    disabled={roomDialogBusy || !local.canManage}
                    title={
                      local.canManage
                        ? t("仅房主可用，不可恢复")
                        : t("这台设备只能查看。要清空，先申请管理权。")
                    }
                    onClick={() => {
                      setArchiveConfirmOpen(false);
                      setClearWhiteboard(true);
                      setClearConfirmOpen(true);
                    }}
                  >
                    {t("清空房间")}
                  </button>
                )}
                {roomDialog.mode === "manage" &&
                  (roomDialog.room.archivedAt ? (
                    <button
                      type="button"
                      className="room-restore"
                      disabled={roomDialogBusy}
                      onClick={() => void setRoomArchived(roomDialog.room, false)}
                    >
                      {t("恢复房间")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="room-archive"
                      disabled={roomDialogBusy || roomDialog.room.id === "general"}
                      title={roomDialog.room.id === "general" ? t("默认房间不能归档") : undefined}
                      onClick={() => {
                        setClearConfirmOpen(false);
                        setArchiveConfirmOpen(true);
                      }}
                    >
                      {t("归档房间")}
                    </button>
                  ))}
                <button type="submit" disabled={roomDialogBusy}>
                  {roomDialog.mode === "create" ? t("创建房间") : t("保存")}
                </button>
              </footer>
            </form>
          </div>
        </div>
      )}
      <AttentionToasts
        toasts={attention.toasts}
        roomName={roomNameOf}
        onOpen={attention.open}
        onDismiss={attention.dismissToast}
        onDismissAll={attention.dismissAllToasts}
      />
      {showOnboarding && onboardingOpen && (
        <OnboardingGuide steps={onboardingSteps} onClose={closeOnboarding} />
      )}
      {showOnboarding && !onboardingOpen && !agentDialogOpen && !imDialogOpen && (
        <button type="button" className="onboarding-resume" onClick={() => setOnboardingOpen(true)}>
          {t("继续上手引导（{0}/{1}）", {
            0: onboardingSteps.filter((step) => step.done).length,
            1: onboardingSteps.length,
          })}
        </button>
      )}
    </main>
  );
}
