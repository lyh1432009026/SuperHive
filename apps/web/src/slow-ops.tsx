import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { SlowOperation, SlowOperationsResponse } from "@superhive/protocol";
import { t } from "./i18n";
import "./styles/slow-ops.css";

/** 同名操作在这么长时间内连着出现，列表里合成一行、提示不重复弹 */
export const SLOW_OPS_MERGE_WINDOW_MS = 60_000;
/** 提示多久后自己收起（鼠标停在上面或键盘焦点在里面时不收） */
const TOAST_DURATION_MS = 10_000;
const READ_STORAGE_KEY = "superhive.slow-ops-read-at";

/** 毫秒数给人看：不到 1 秒按毫秒，否则按秒保留一位 */
export function formatDuration(ms: number): string {
  return ms < 1000
    ? t("{0} 毫秒", { 0: Math.round(ms) })
    : t("{0} 秒", { 0: ms < 10_000 ? Number((ms / 1000).toFixed(1)) : Math.round(ms / 1000) });
}

function kindLabel(kind: SlowOperation["kind"]): string {
  switch (kind) {
    case "lock":
      return t("锁");
    case "git":
      return "git";
    case "request":
      return t("请求");
    default:
      return t("操作");
  }
}

/** 发生时间：今天的只显示时分秒，更早的带上日期 */
function formatTime(iso: string, now: Date): string {
  const at = new Date(iso);
  return at.toDateString() === now.toDateString()
    ? at.toLocaleTimeString()
    : at.toLocaleString(undefined, {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
}

/** 仓库只显示最后一级目录名，悬停看全路径 */
function repoLabel(repo: string): string {
  return repo.split(/[\\/]/).filter(Boolean).at(-1) ?? repo;
}

const totalMs = (item: SlowOperation) => item.durationMs + (item.waitMs ?? 0);
const keyOf = (item: SlowOperation) => `${item.kind} ${item.name}`;

export type SlowOpGroup = {
  key: string;
  /** 最近的一次：时间、来源、仓库按它显示 */
  latest: SlowOperation;
  /** 最慢的一次：耗时按它显示 */
  slowest: SlowOperation;
  count: number;
  /** 最早一次的时间，判断是否已读用 */
  oldestAt: string;
};

/**
 * 同类同名、前后相隔不超过 windowMs 的慢操作合成一组（例如一次排队里连着十几个 git status）。
 * operations 是新的在前，返回的组也是新的在前。
 */
export function groupSlowOps(
  operations: readonly SlowOperation[],
  windowMs = SLOW_OPS_MERGE_WINDOW_MS,
): SlowOpGroup[] {
  const groups: SlowOpGroup[] = [];
  const open = new Map<string, SlowOpGroup>();
  for (const item of operations) {
    const key = keyOf(item);
    const group = open.get(key);
    if (group && Date.parse(group.oldestAt) - Date.parse(item.at) <= windowMs) {
      group.count++;
      group.oldestAt = item.at;
      if (totalMs(item) > totalMs(group.slowest)) group.slowest = item;
      continue;
    }
    const created = { key, latest: item, slowest: item, count: 1, oldestAt: item.at };
    groups.push(created);
    open.set(key, created);
  }
  return groups;
}

export type SlowOpsToast = { key: string; operation: SlowOperation; count: number };

export type SlowOpsState = {
  /** 收到过全集才算可用：只有这台电脑上的房主页面会收到 */
  enabled: boolean;
  operations: SlowOperation[];
  settings: Omit<SlowOperationsResponse, "operations"> | undefined;
  /** 上次「标为已读」时最新一条的时间；没标过是 undefined */
  readAt: string | undefined;
  unread: number;
  open: boolean;
  toast: SlowOpsToast | undefined;
  /** WebSocket 连上（含重连）时的全集 */
  receiveSnapshot(snapshot: SlowOperationsResponse): void;
  /** WebSocket 推来的新一条 */
  receive(operation: SlowOperation): void;
  markRead(): void;
  setOpen(open: boolean): void;
  dismissToast(): void;
};

function loadReadAt(): string | undefined {
  try {
    return localStorage.getItem(READ_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function newestFirst(items: Iterable<SlowOperation>, capacity: number): SlowOperation[] {
  const byId = new Map<string, SlowOperation>();
  for (const item of items) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, capacity);
}

/**
 * 本机房主页面上的慢操作，全靠 WebSocket：连上时服务端给一份全集（receiveSnapshot），
 * 之后逐条推（receive），不轮询。带 alert 的（特别慢、等锁太久）弹一次提示；
 * 同名的在合并窗口内只累计次数，不重复弹。
 */
export function useSlowOps(): SlowOpsState {
  const [operations, setOperations] = useState<SlowOperation[]>([]);
  const [settings, setSettings] = useState<SlowOpsState["settings"]>();
  const [readAt, setReadAt] = useState(loadReadAt);
  const [open, setOpenState] = useState(false);
  const [toast, setToast] = useState<SlowOpsToast>();
  const lastAlerted = useRef(new Map<string, number>());
  const openRef = useRef(open);
  openRef.current = open;
  const capacity = settings?.capacity ?? 200;

  const receiveSnapshot = useCallback(
    ({ operations: snapshot, ...rest }: SlowOperationsResponse) => {
      setSettings(rest);
      // 同一条连接上全集先于逐条推送到达，直接替换即可；Server 重启后全集变短也以它为准
      setOperations(newestFirst(snapshot, rest.capacity));
    },
    [],
  );

  const receive = useCallback(
    (operation: SlowOperation) => {
      setOperations((current) => newestFirst([operation, ...current], capacity));
      if (!operation.alert || openRef.current) return;
      const key = keyOf(operation);
      const at = Date.parse(operation.at);
      const previous = lastAlerted.current.get(key);
      lastAlerted.current.set(key, at);
      if (previous !== undefined && at - previous <= SLOW_OPS_MERGE_WINDOW_MS) {
        // 同一个还在提示：只把次数加上去，换成最新这次
        setToast((current) =>
          current?.key === key ? { key, operation, count: current.count + 1 } : current,
        );
        return;
      }
      setToast({ key, operation, count: 1 });
    },
    [capacity],
  );

  const markRead = useCallback(() => {
    const newest = operations[0]?.at;
    if (!newest) return;
    setReadAt(newest);
    try {
      localStorage.setItem(READ_STORAGE_KEY, newest);
    } catch {
      // 存不了只影响刷新后是否还记得已读
    }
  }, [operations]);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    if (next) setToast(undefined);
  }, []);
  const dismissToast = useCallback(() => setToast(undefined), []);

  const unread = useMemo(() => {
    const cutoff = readAt ? Date.parse(readAt) : -Infinity;
    return operations.filter((item) => Date.parse(item.at) > cutoff).length;
  }, [operations, readAt]);

  return {
    enabled: settings !== undefined,
    operations,
    settings,
    readAt,
    unread,
    open,
    toast,
    receiveSnapshot,
    receive,
    markRead,
    setOpen,
    dismissToast,
  };
}

/** 慢操作列表：同名的合成一行，耗时按最慢的一次，其余按最近的一次 */
export function SlowOpsList({
  operations,
  readAt,
  label,
}: {
  operations: readonly SlowOperation[];
  readAt?: string | undefined;
  label: string;
}) {
  const groups = useMemo(() => groupSlowOps(operations), [operations]);
  const cutoff = readAt ? Date.parse(readAt) : -Infinity;
  const now = new Date();
  return (
    <ul className="slow-ops" aria-label={label}>
      {groups.map(({ key, latest, slowest, count }) => {
        const unread = Date.parse(latest.at) > cutoff;
        const failed = latest.failed || slowest.failed;
        return (
          <li
            key={`${key} ${latest.id}`}
            className={[failed ? "failed" : "", unread ? "unread" : ""].filter(Boolean).join(" ")}
          >
            <span className={`slow-op-kind ${latest.kind}`}>{kindLabel(latest.kind)}</span>
            <span className="slow-op-main">
              <span className="slow-op-name">
                <strong title={latest.name}>{latest.name}</strong>
                {count > 1 && (
                  <span
                    className="slow-op-count"
                    title={t("1 分钟内连着出现了 {0} 次", { 0: count })}
                  >
                    ×{count}
                  </span>
                )}
                {unread && <span className="sr-only">{t("（未读）")}</span>}
              </span>
              <small>
                {[
                  formatTime(latest.at, now),
                  latest.source ? t("来自 {0}", { 0: latest.source }) : undefined,
                  latest.roomId ? `#${latest.roomId}` : undefined,
                  latest.status !== undefined ? String(latest.status) : undefined,
                  failed ? t("出错") : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                {latest.repo && (
                  <>
                    {" · "}
                    <span title={latest.repo}>{repoLabel(latest.repo)}</span>
                  </>
                )}
              </small>
            </span>
            <span className="slow-op-time">
              <strong>
                {count > 1
                  ? t("最长 {0}", { 0: formatDuration(slowest.durationMs) })
                  : formatDuration(slowest.durationMs)}
              </strong>
              {slowest.waitMs !== undefined && (
                <small>{t("等锁 {0}", { 0: formatDuration(slowest.waitMs) })}</small>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function GaugeGlyph() {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.5 17.5a8.5 8.5 0 1 1 15 0" />
      <path d="m12 13 3.5-4" />
      <circle cx="12" cy="13" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

type Anchor = { top: number; right: number };

/** 面板和提示都挂在「性能」按钮下方、右边对齐；窗口变化时跟着走 */
function useAnchor(ref: RefObject<HTMLElement | null>, active: boolean): Anchor | undefined {
  const [anchor, setAnchor] = useState<Anchor>();
  useLayoutEffect(() => {
    if (!active) return;
    const update = () => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;
      setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [ref, active]);
  return active ? anchor : undefined;
}

function thresholdNote(settings: NonNullable<SlowOpsState["settings"]>): string {
  return t(
    "记录超过 {0}（请求 {1}）的操作；合计超过 {2} 或等锁超过 {3} 时弹提示。只保存在 Server 内存里，最多 {4} 条，重启后清空。",
    {
      0: formatDuration(settings.thresholdMs),
      1: formatDuration(settings.requestThresholdMs),
      2: formatDuration(settings.alertMs),
      3: formatDuration(settings.lockWaitAlertMs),
      4: settings.capacity,
    },
  );
}

function toastTitle(toast: SlowOpsToast): string {
  const { operation } = toast;
  const base =
    operation.waitMs !== undefined && operation.waitMs >= operation.durationMs
      ? t("{0} 等锁 {1}", { 0: operation.name, 1: formatDuration(operation.waitMs) })
      : t("{0} 用了 {1}", { 0: operation.name, 1: formatDuration(totalMs(operation)) });
  return toast.count > 1 ? `${base} ×${toast.count}` : base;
}

/**
 * 顶栏右上角的「性能」：有没看过的慢操作时用警示色亮起并带数量；点开是最近慢操作的弹层，
 * 可以标为已读。特别慢的一条会在按钮下方弹一次轻提示，点它打开弹层。只在本机房主页面显示。
 */
export function SlowOpsIndicator({ state }: { state: SlowOpsState }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { open, setOpen, toast, dismissToast, unread } = state;
  const panelAnchor = useAnchor(buttonRef, open);
  const toastAnchor = useAnchor(buttonRef, Boolean(toast) && !open);
  const [toastHeld, setToastHeld] = useState(false);

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus({ preventScroll: true });
  }, [setOpen]);

  useEffect(() => {
    if (!open) return;
    headingRef.current?.focus({ preventScroll: true });
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (panelRef.current?.contains(target) || buttonRef.current?.contains(target)))
        return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [open, setOpen]);

  useEffect(() => {
    if (!toast || toastHeld) return;
    const timer = window.setTimeout(dismissToast, TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [toast, toastHeld, dismissToast]);

  if (!state.enabled) return null;
  const label = unread ? t("性能：{0} 条未读慢操作", { 0: unread }) : t("性能：最近慢操作");

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`header-button perf-toggle${unread ? " has-unread" : ""}${open ? " active" : ""}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen(!open)}
      >
        <GaugeGlyph />
        <span className="perf-toggle-label">{t("性能")}</span>
        {unread > 0 && (
          <span className="header-count perf-count" aria-hidden="true">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="slow-ops-popover"
            role="dialog"
            aria-labelledby="slow-ops-popover-title"
            style={{
              top: panelAnchor?.top ?? 0,
              right: panelAnchor?.right ?? 0,
              visibility: panelAnchor ? "visible" : "hidden",
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              close();
            }}
          >
            <header className="slow-ops-popover-header">
              <h2 id="slow-ops-popover-title" ref={headingRef} tabIndex={-1}>
                {t("最近慢操作")}
                {unread > 0 && (
                  <span className="slow-ops-unread">{t("{0} 条未读", { 0: unread })}</span>
                )}
              </h2>
              <div className="slow-ops-popover-actions">
                <button type="button" disabled={unread === 0} onClick={state.markRead}>
                  {t("标为已读")}
                </button>
                <button
                  type="button"
                  className="slow-ops-popover-close"
                  aria-label={t("关闭")}
                  onClick={close}
                >
                  ×
                </button>
              </div>
            </header>
            {state.settings && <p className="slow-ops-note">{thresholdNote(state.settings)}</p>}
            {state.operations.length ? (
              <SlowOpsList
                operations={state.operations}
                readAt={state.readAt}
                label={t("最近慢操作")}
              />
            ) : (
              <p className="slow-ops-empty">{t("最近没有慢操作。")}</p>
            )}
          </div>,
          document.body,
        )}
      {toast &&
        !open &&
        createPortal(
          <div
            className="slow-ops-toast attention-toast"
            role="status"
            style={{
              top: toastAnchor?.top ?? 0,
              right: toastAnchor?.right ?? 0,
              visibility: toastAnchor ? "visible" : "hidden",
            }}
            onPointerEnter={() => setToastHeld(true)}
            onPointerLeave={() => setToastHeld(false)}
            onFocus={() => setToastHeld(true)}
            onBlur={() => setToastHeld(false)}
          >
            <button
              type="button"
              className="attention-toast-open"
              title={t("查看最近慢操作")}
              onClick={() => setOpen(true)}
            >
              <span className="attention-toast-icon" aria-hidden="true">
                <GaugeGlyph />
              </span>
              <span className="attention-toast-text">
                <strong>{t("Server 有操作特别慢")}</strong>
                <span>{toastTitle(toast)}</span>
              </span>
            </button>
            <button
              type="button"
              className="attention-toast-close"
              aria-label={t("关闭提醒")}
              onClick={dismissToast}
            >
              ×
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

/** 「这台电脑」设置页：只留一个入口，打开顶栏的弹层 */
export function SlowOpsSettingsEntry({
  state,
  onOpen,
}: {
  state: SlowOpsState;
  onOpen: () => void;
}) {
  return (
    <div className="settings-group">
      <div className="settings-section-heading slow-ops-heading">
        <div>
          <h4>{t("最近慢操作")}</h4>
          <p>
            {t(
              "Server 上的任务目录锁、git 命令、重查询和请求超过阈值时，顶栏右上角的「性能」会亮起；特别慢的会弹一次提示。",
            )}
          </p>
        </div>
        <button type="button" className="settings-action" onClick={onOpen}>
          {state.unread ? t("查看（{0} 条未读）", { 0: state.unread }) : t("查看")}
        </button>
      </div>
    </div>
  );
}
