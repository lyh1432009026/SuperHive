import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import type { WorkspaceOverview, WorktreeStatus } from "@superhive/protocol";
import { t } from "./i18n";
import { formatRelativeTime } from "./whiteboard";
import "./styles/worktree-switcher.css";

export function BranchGlyph() {
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

type Tone = "passed" | "warning" | undefined;
type Chip = { label: string; tone?: Tone };

export type SwitcherRow = {
  /** 代码面板里的 source：工作区是 "workspace"，任务线是 worktree 的 id */
  id: string;
  branch: string;
  /** 工作区行写「房间工作区」，任务线写建它的 Agent */
  owner: string;
  current: boolean;
  chips: Chip[];
  /** 最近改动时间；没改过就用创建时间 */
  time?: { iso: string; created: boolean } | undefined;
  missing: boolean;
  removable: boolean;
};

/** 一条任务线的合入、改动、清理情况；和房间设置里的 Worktree 列表同一套判断 */
function worktreeChips(item: WorktreeStatus): Chip[] {
  const chips: Chip[] = [];
  if (item.missing) return [{ label: t("目录已不存在"), tone: "warning" }];
  if (item.worktree.phase === "creating") chips.push({ label: t("正在建立") });
  else if (item.worktree.phase !== "ready") chips.push({ label: t("清理没做完"), tone: "warning" });
  if (item.branchSwitched)
    chips.push({
      label: t("分支被切换为 {0}", { 0: item.branchSwitched.current }),
      tone: "warning",
    });
  // 有没提交的改动时，提交虽然都在目标分支里，目录里的活还没交：不写「已合入」免得以为做完了
  else if (!(item.merged && (item.dirty || item.untracked)))
    chips.push(item.merged ? { label: t("已合入"), tone: "passed" } : { label: t("未合入") });
  if (item.dirty || item.untracked) chips.push({ label: t("有未提交改动"), tone: "warning" });
  if (item.ignored) chips.push({ label: t("有挡住清理的文件"), tone: "warning" });
  if (item.activeInvocationIds.length > 0) chips.push({ label: t("有任务在用") });
  if (item.removable) chips.push({ label: t("可清理"), tone: "passed" });
  return chips;
}

/**
 * 下拉里的行：房间工作区在最上并标「当前」；任务线未合入的在前、已合入的其次、目录没了的最后，
 * 同一档按最近改动排（没改过的按创建时间）
 */
export function switcherRows(
  worktrees: WorktreeStatus[],
  overview: WorkspaceOverview | undefined,
  fallback: { branch: string },
): SwitcherRow[] {
  const sources = new Map((overview?.sources ?? []).map((item) => [item.id, item]));
  const workspace = sources.get("workspace");
  const branch = workspace?.branch ?? fallback.branch;
  const changes = workspace?.changeCount ?? overview?.changeCount;
  const head: SwitcherRow = {
    id: "workspace",
    branch,
    owner: t("房间工作区"),
    current: true,
    chips:
      changes === undefined
        ? []
        : changes > 0
          ? [{ label: t("{0} 个文件未提交", { 0: changes }), tone: "warning" }]
          : [{ label: t("工作区干净") }],
    time: workspace?.activeAt ? { iso: workspace.activeAt, created: false } : undefined,
    missing: false,
    removable: false,
  };
  const rank = (item: WorktreeStatus) =>
    item.missing ? 2 : item.merged && !item.dirty && !item.untracked ? 1 : 0;
  const rows = worktrees.map((item) => {
    const activeAt = sources.get(item.worktree.id)?.activeAt;
    return {
      rank: rank(item),
      row: {
        id: item.worktree.id,
        branch: item.worktree.branch,
        owner: item.worktree.agentName,
        current: false,
        chips: worktreeChips(item),
        time: activeAt
          ? { iso: activeAt, created: false }
          : { iso: item.worktree.createdAt, created: true },
        missing: Boolean(item.missing),
        removable: item.removable,
      } satisfies SwitcherRow,
    };
  });
  rows.sort(
    (a, b) => a.rank - b.rank || (b.row.time?.iso ?? "").localeCompare(a.row.time?.iso ?? ""),
  );
  return [head, ...rows.map((item) => item.row)];
}

type Anchor = { top: number; left: number };

/**
 * 顶栏的「⎇ 分支」：本机房主点开看这个仓库的任务目录（谁的、什么分支、合没合入、多久前改的），
 * 点一行在「代码」面板里打开那条任务线；清理等管理动作留在房间设置的 Worktree 列表里。
 * 每次打开重新拉一次，不在后台轮询。
 */
export function WorktreeSwitcher({
  branch,
  loadWorktrees,
  loadOverview,
  onOpenSource,
  onManage,
}: {
  branch: string;
  loadWorktrees: () => Promise<{ worktrees: WorktreeStatus[] }>;
  loadOverview: () => Promise<WorkspaceOverview>;
  onOpenSource: (source: string) => void;
  /** 打开房间设置里完整的 Worktree 列表；trigger 用来在关掉设置后把焦点还回来 */
  onManage: (trigger: HTMLButtonElement) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor>();
  const [rows, setRows] = useState<SwitcherRow[]>();
  const [error, setError] = useState<string>();
  const version = useRef(0);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!open) return;
    const current = ++version.current;
    setError(undefined);
    void Promise.all([loadWorktrees(), loadOverview().catch(() => undefined)]).then(
      ([inventory, overview]) => {
        if (current !== version.current) return;
        setRows(switcherRows(inventory.worktrees ?? [], overview, { branch }));
      },
      (reason: unknown) => {
        if (current !== version.current) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  }, [open, loadWorktrees, loadOverview, branch]);

  // 换房间时上一个房间的列表作废
  useEffect(() => {
    version.current++;
    setRows(undefined);
    setOpen(false);
  }, [loadWorktrees]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(440, window.innerWidth - 16);
      setAnchor({
        top: rect.bottom + 6,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (panelRef.current?.contains(target) || buttonRef.current?.contains(target)))
        return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [open]);

  // 打开后焦点落在第一行（列表没到之前先落在弹层上，Esc 照样能关）
  useEffect(() => {
    if (!open) return;
    const first = panelRef.current?.querySelector<HTMLButtonElement>(
      ".worktree-switcher-row:not(:disabled)",
    );
    (first ?? panelRef.current)?.focus({ preventScroll: true });
  }, [open, rows]);

  const items = () =>
    Array.from(
      panelRef.current?.querySelectorAll<HTMLButtonElement>(
        ".worktree-switcher-row:not(:disabled), .worktree-switcher-manage",
      ) ?? [],
    );

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const list = items();
    if (!list.length) return;
    event.preventDefault();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? list.length - 1
          : event.key === "ArrowDown"
            ? (index + 1) % list.length
            : (index - 1 + list.length) % list.length;
    list[next]?.focus();
  };

  const now = Date.now();
  const removable = rows?.filter((row) => row.removable).length;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`chat-title-branch worktree-switcher-toggle${open ? " active" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t("当前分支 {0}：点开看这个仓库的任务目录", { 0: branch })}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <BranchGlyph />
        <span className="worktree-switcher-branch">{branch}</span>
        <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
          <path
            d="m4 6 4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="worktree-switcher"
            role="dialog"
            aria-labelledby="worktree-switcher-title"
            tabIndex={-1}
            style={{
              top: anchor?.top ?? 0,
              left: anchor?.left ?? 0,
              visibility: anchor ? "visible" : "hidden",
            }}
            onKeyDown={onKeyDown}
          >
            <header className="worktree-switcher-header">
              <h2 id="worktree-switcher-title">{t("任务目录")}</h2>
              {rows && (
                <span>
                  {removable
                    ? t("{0} 条任务线 · {1} 个可清理", { 0: rows.length - 1, 1: removable })
                    : t("{0} 条任务线", { 0: rows.length - 1 })}
                </span>
              )}
            </header>
            {error ? (
              <p className="worktree-switcher-note" role="alert">
                {t("没能读取任务目录：{0}", { 0: error })}
              </p>
            ) : !rows ? (
              <p className="worktree-switcher-note" role="status">
                {t("正在核对任务目录…")}
              </p>
            ) : (
              <ul className="worktree-switcher-list">
                {rows.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      className={`worktree-switcher-row${row.current ? " current" : ""}`}
                      disabled={row.missing}
                      aria-current={row.current ? "true" : undefined}
                      title={
                        row.missing ? undefined : t("在「代码」面板里打开 {0}", { 0: row.branch })
                      }
                      onClick={() => {
                        close(false);
                        onOpenSource(row.id);
                      }}
                    >
                      <span className="worktree-switcher-line">
                        <code>{row.branch}</code>
                        {row.current && (
                          <span className="worktree-switcher-current">{t("当前")}</span>
                        )}
                        {row.time && (
                          <time
                            dateTime={row.time.iso}
                            title={new Date(row.time.iso).toLocaleString()}
                          >
                            {row.time.created
                              ? t("{0}建立", { 0: formatRelativeTime(row.time.iso, now) })
                              : formatRelativeTime(row.time.iso, now)}
                          </time>
                        )}
                      </span>
                      <span className="worktree-switcher-meta">
                        <span className="worktree-switcher-owner">{row.owner}</span>
                        {row.chips.map((chip) => (
                          <span key={chip.label} className={chip.tone}>
                            {chip.label}
                          </span>
                        ))}
                      </span>
                    </button>
                  </li>
                ))}
                {rows.length === 1 && (
                  <li className="worktree-switcher-note">
                    {t("还没有任务线。Agent 用 hive_worktree_create 开的目录会出现在这里。")}
                  </li>
                )}
              </ul>
            )}
            <footer className="worktree-switcher-footer">
              <button
                type="button"
                className="worktree-switcher-manage"
                onClick={() => {
                  const trigger = buttonRef.current;
                  close(false);
                  if (!trigger) return;
                  onManage(trigger);
                  // 房间设置很长，Worktree 列表在后半段：打开后直接滚到那里
                  window.requestAnimationFrame(() =>
                    window.requestAnimationFrame(() =>
                      document
                        .querySelector(".worktree-panel")
                        ?.scrollIntoView({ block: "start", behavior: "smooth" }),
                    ),
                  );
                }}
              >
                {t("在 Worktree 列表里管理")}
              </button>
            </footer>
          </div>,
          document.body,
        )}
    </>
  );
}
