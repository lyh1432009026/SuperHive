import { useEffect, useId, useState, type ReactNode } from "react";
import type { WhiteboardEntry, WhiteboardSlot } from "@superhive/protocol";
import { getLocale, localized, t } from "./i18n";

/** 阻塞最需要人关注，排在最前；里程碑是历史记录，放最后 */
export const whiteboardSlots: Array<{ slot: WhiteboardSlot; label: string }> = localized(() => [
  { slot: "blocked", label: t("阻塞") },
  { slot: "in_progress", label: t("进行中的工作") },
  { slot: "ready", label: t("已就绪") },
  { slot: "milestone", label: t("里程碑") },
]);

export function upsertWhiteboardEntry(
  current: ReadonlyMap<string, WhiteboardEntry>,
  entry: WhiteboardEntry,
): Map<string, WhiteboardEntry> {
  const existing = current.get(entry.id);
  if (existing && existing.updatedAt > entry.updatedAt)
    return current as Map<string, WhiteboardEntry>;
  const next = new Map(current);
  next.set(entry.id, entry);
  return next;
}

export function formatRelativeTime(iso: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return t("刚刚");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("{0} 分钟前", { 0: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("{0} 小时前", { 0: hours });
  const days = Math.round(hours / 24);
  if (days < 30) return t("{0} 天前", { 0: days });
  return new Date(iso).toLocaleDateString(getLocale(), { month: "short", day: "numeric" });
}

function shortCommit(commit: string): string {
  return /^[0-9a-f]{12,}$/i.test(commit) ? commit.slice(0, 7) : commit;
}

function ToolbarIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function FilterIcon() {
  return (
    <ToolbarIcon>
      <path d="M4 6h16M7 12h10M10 18h4" />
    </ToolbarIcon>
  );
}

function ChevronIcon() {
  return (
    <ToolbarIcon>
      <path d="m7 10 5 5 5-5" />
    </ToolbarIcon>
  );
}

function RefreshIcon() {
  return (
    <ToolbarIcon>
      <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
    </ToolbarIcon>
  );
}

function SelectAllIcon() {
  return (
    <ToolbarIcon>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </ToolbarIcon>
  );
}

function CloseIcon() {
  return (
    <ToolbarIcon>
      <path d="m6 6 12 12M18 6 6 18" />
    </ToolbarIcon>
  );
}

export function WhiteboardPanel({
  entries,
  onRemove,
  canManage,
  onArchive,
  loadHistory,
  historyEpoch = 0,
}: {
  entries: ReadonlyMap<string, WhiteboardEntry>;
  onRemove: (entry: WhiteboardEntry) => void;
  canManage: boolean;
  onArchive: (entries: WhiteboardEntry[], archive: boolean) => Promise<void>;
  loadHistory: () => Promise<void>;
  historyEpoch?: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [view, setView] = useState<"current" | "archived">("current");
  const [slotFilter, setSlotFilter] = useState<WhiteboardSlot | "all">("all");
  const [selected, setSelected] = useState(new Map<string, WhiteboardEntry>());
  const [busy, setBusy] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState<string>();
  const hintId = useId();
  const hint = t("仍占用工作区的事项不可归档；每次最多选择 200 条。");
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setSelected((current) => {
      const next = new Map(
        [...current].filter(
          ([entryId, entry]) => entries.get(entryId)?.updatedAt === entry.updatedAt,
        ),
      );
      return next.size === current.size ? current : next;
    });
  }, [entries]);

  useEffect(() => {
    setHistoryLoaded(false);
  }, [historyEpoch]);

  useEffect(() => {
    if (view !== "archived") {
      setHistoryLoading(false);
      return;
    }
    if (historyLoaded) return;
    let active = true;
    setHistoryLoading(true);
    setError(undefined);
    loadHistory()
      .then(
        () => {
          if (active) setHistoryLoaded(true);
        },
        (reason: unknown) => {
          if (active) setError(reason instanceof Error ? reason.message : String(reason));
        },
      )
      .finally(() => {
        if (active) setHistoryLoading(false);
      });
    return () => {
      active = false;
    };
  }, [view, historyLoaded, loadHistory, historyEpoch]);

  const sorted = [...entries.values()]
    .filter((entry) => Boolean(entry.archivedAt) === (view === "archived"))
    .filter((entry) => slotFilter === "all" || entry.slot === slotFilter)
    .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
  const selectable = sorted.filter((entry) => view === "archived" || !entry.archiveProtected);
  const canSelect = (entry: WhiteboardEntry) => selectable.some((item) => item.id === entry.id);
  // 一键全选只挑已经收尾的成果；进行中、阻塞的要房主逐条勾，免得把还在推进的活一起归档
  const bulkSelectable = selectable.filter(
    (entry) => view === "archived" || (entry.slot !== "in_progress" && entry.slot !== "blocked"),
  );

  async function changeArchive(items: WhiteboardEntry[]) {
    const archive = view === "current";
    if (
      archive &&
      !window.confirm(
        t("归档所选 {0} 条事项？请保留待 review 或仍用于当前协作的成果。归档后可从历史恢复。", {
          0: items.length,
        }),
      )
    )
      return;
    setBusy(true);
    setError(undefined);
    try {
      await onArchive(items, archive);
      setSelected(new Map());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="whiteboard">
      <div className="whiteboard-toolbar">
        <div className="whiteboard-toolbar-row">
          <div
            className="whiteboard-views"
            role="group"
            aria-label={t("白板视图")}
            data-view={view}
          >
            <button
              type="button"
              disabled={busy}
              aria-pressed={view === "current"}
              onClick={() => {
                setView("current");
                setSelected(new Map());
              }}
            >
              {t("当前事项")}
            </button>
            <button
              type="button"
              disabled={busy}
              aria-pressed={view === "archived"}
              onClick={() => {
                setView("archived");
                setSelected(new Map());
              }}
            >
              {t("历史归档")}
            </button>
          </div>
          {view === "archived" && (
            <button
              type="button"
              className="whiteboard-icon-button"
              aria-label={t("刷新历史")}
              title={t("刷新历史")}
              aria-busy={historyLoading}
              disabled={historyLoading}
              onClick={() => {
                setHistoryLoading(true);
                setError(undefined);
                loadHistory()
                  .then(
                    () => setHistoryLoaded(true),
                    (reason: unknown) =>
                      setError(reason instanceof Error ? reason.message : String(reason)),
                  )
                  .finally(() => setHistoryLoading(false));
              }}
            >
              <RefreshIcon />
            </button>
          )}
        </div>
        <div className="whiteboard-toolbar-row">
          <label className="whiteboard-filter" data-active={slotFilter !== "all" || undefined}>
            <span className="sr-only">{t("状态筛选")}</span>
            {slotFilter === "all" ? (
              <FilterIcon />
            ) : (
              <span className={`whiteboard-slot-dot ${slotFilter}`} aria-hidden="true" />
            )}
            <select
              value={slotFilter}
              title={t("状态筛选")}
              onChange={(event) => {
                setSlotFilter(event.target.value as WhiteboardSlot | "all");
                setSelected(new Map());
              }}
            >
              <option value="all">{t("全部状态")}</option>
              {whiteboardSlots.map(({ slot, label }) => (
                <option key={slot} value={slot}>
                  {label}
                </option>
              ))}
            </select>
            <ChevronIcon />
          </label>
          {canManage && sorted.length > 0 && (
            <button
              type="button"
              className="whiteboard-bulk-pick"
              title={view === "current" ? hint : undefined}
              aria-describedby={view === "current" ? hintId : undefined}
              disabled={busy || !bulkSelectable.length}
              onClick={() =>
                setSelected(new Map(bulkSelectable.slice(0, 200).map((entry) => [entry.id, entry])))
              }
            >
              <SelectAllIcon />
              <span>{view === "current" ? t("选择可归档事项") : t("选择历史事项")}</span>
            </button>
          )}
        </div>
        {canManage && view === "current" && (
          <p id={hintId} className="sr-only">
            {hint}
          </p>
        )}
        {canManage && selected.size > 0 && (
          <div className="whiteboard-bulk" role="group" aria-label={t("批量操作")}>
            <button
              type="button"
              className="whiteboard-icon-button"
              aria-label={t("取消选择")}
              title={t("取消选择")}
              disabled={busy}
              onClick={() => setSelected(new Map())}
            >
              <CloseIcon />
            </button>
            <span className="whiteboard-bulk-count">
              {t("已选择 {0} 条", { 0: selected.size })}
            </span>
            <button
              type="button"
              className="whiteboard-bulk-apply"
              disabled={busy}
              onClick={() => void changeArchive([...selected.values()])}
            >
              {view === "current"
                ? t("归档所选 ({0})", { 0: selected.size })
                : t("恢复所选 ({0})", { 0: selected.size })}
            </button>
          </div>
        )}
        {historyLoading && (
          <p className="whiteboard-status" role="status">
            {t("正在加载白板历史…")}
          </p>
        )}
        {error && (
          <p className="whiteboard-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {sorted.length === 0 && !historyLoading && (
        <div className="whiteboard-empty">
          <strong>
            {view === "archived"
              ? t("没有历史归档")
              : slotFilter !== "all"
                ? t("没有符合筛选的事项")
                : t("白板还是空的")}
          </strong>
          {view === "current" && slotFilter === "all" && (
            <p>
              {t("Agent 会通过")} <code>hive_board_update</code>{" "}
              {t("在这里登记进行中的工作、可交接的成果、阻塞与里程碑，方便所有人对齐进度。")}
            </p>
          )}
        </div>
      )}
      {whiteboardSlots.map(({ slot, label }) => {
        const slotEntries = sorted.filter((entry) => entry.slot === slot);
        if (slotEntries.length === 0) return null;
        const headingId = `whiteboard-slot-${slot}`;
        return (
          <section key={slot} className={`whiteboard-slot ${slot}`} aria-labelledby={headingId}>
            <h3 id={headingId}>
              <span className="whiteboard-slot-dot" aria-hidden="true" />
              {label}
              <span className="whiteboard-slot-count">{slotEntries.length}</span>
            </h3>
            <ul>
              {slotEntries.map((entry) => (
                <li key={entry.id} className="whiteboard-entry">
                  {canManage && (
                    <label className="whiteboard-select">
                      <input
                        type="checkbox"
                        aria-label={t("选择事项：{0}", { 0: entry.key })}
                        checked={selected.has(entry.id)}
                        disabled={
                          busy ||
                          !canSelect(entry) ||
                          (!selected.has(entry.id) && selected.size >= 200)
                        }
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setSelected((current) => {
                            const next = new Map(current);
                            if (checked) next.set(entry.id, entry);
                            else next.delete(entry.id);
                            return next;
                          });
                        }}
                      />
                      <span>{entry.key}</span>
                    </label>
                  )}
                  <p className="whiteboard-summary">{entry.summary}</p>
                  {(entry.repo || entry.branch || entry.commit) && (
                    <p className="whiteboard-ref">
                      {entry.repo && <span title={entry.repo}>{entry.repo}</span>}
                      {entry.branch && (
                        <span title={t("分支 {0}", { 0: entry.branch })}>{entry.branch}</span>
                      )}
                      {entry.commit && (
                        <span title={t("提交 {0}", { 0: entry.commit })}>
                          {shortCommit(entry.commit)}
                        </span>
                      )}
                    </p>
                  )}
                  {entry.unblocks.length > 0 && (
                    <p className="whiteboard-unblocks">
                      {t("解除阻塞：{0}", { 0: entry.unblocks.join(t("、")) })}
                    </p>
                  )}
                  <p className="whiteboard-meta">
                    <span>{entry.authorName}</span>
                    <time
                      dateTime={entry.updatedAt}
                      title={new Date(entry.updatedAt).toLocaleString()}
                    >
                      {formatRelativeTime(entry.updatedAt, now)}
                    </time>
                  </p>
                  {canManage && canSelect(entry) && (
                    <button
                      className="whiteboard-entry-action"
                      type="button"
                      disabled={busy}
                      onClick={() => void changeArchive([entry])}
                    >
                      {view === "current"
                        ? t("归档事项：{0}", { 0: entry.key })
                        : t("恢复事项：{0}", { 0: entry.key })}
                    </button>
                  )}
                  {canManage && view === "archived" && (
                    <button
                      type="button"
                      className="whiteboard-remove"
                      aria-label={t("从白板移除：{0}", { 0: entry.summary })}
                      title={t("从白板移除")}
                      onClick={() => onRemove(entry)}
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        aria-hidden="true"
                      >
                        <path d="m6 6 12 12M18 6 6 18" />
                      </svg>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
