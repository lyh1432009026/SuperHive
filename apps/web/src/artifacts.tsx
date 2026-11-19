import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  Artifact,
  ArtifactCategory,
  ArtifactCounts,
  ArtifactFilter,
  ArtifactItem,
  ArtifactsResponse,
} from "@superhive/protocol";
import {
  FilePreview,
  Lightbox,
  downloadAttachment,
  formatBytes,
  previewKind,
  useAttachmentUrl,
} from "./attachments";
import { localized, t } from "./i18n";
import { formatRelativeTime } from "./whiteboard";

/**
 * 房间「产物」面板：汇总房间里随消息发出的图片和文件。
 * - 「全部」上面一排最新的图片，下面是文件列表；「图片」是缩略图网格；其余是文件列表。
 * - 同一个人发的同名文件合成一项，显示最新版，展开能看历史版本。
 * - 看图用消息里同一个看图器，可以在面板里的图片之间左右切换；文件用同一个预览窗口。
 * - 新附件、撤回由 App 在收到消息事件时把 epoch 加一，面板就地刷新，已经展开的、翻到的位置保留。
 */

const PAGE_SIZE = 40;
/** 「全部」里图片那一排最多放几张 */
const IMAGE_STRIP_SIZE = 8;
/** 刷新时最多一次重新取回这么多项（服务端单页上限） */
const MAX_REFRESH = 200;

const FILE_CATEGORIES: ArtifactCategory[] = [
  "document",
  "code",
  "data",
  "archive",
  "media",
  "other",
];

const FILTER_LABELS: Record<ArtifactFilter, string> = localized(() => ({
  all: t("全部"),
  image: t("图片"),
  file: t("文件"),
  document: t("文档"),
  code: t("代码"),
  data: t("数据"),
  archive: t("压缩包"),
  media: t("音视频"),
  other: t("其他"),
}));

/** 文件图标上的短标签：一眼分得清文档、代码、压缩包 */
const CATEGORY_BADGES: Record<ArtifactCategory, string> = {
  image: "IMG",
  document: "DOC",
  code: "</>",
  data: "{ }",
  archive: "ZIP",
  media: "▶",
  other: "···",
};

function fileBadge(item: ArtifactItem): string {
  const extension = /\.([a-z0-9]{1,5})$/i.exec(item.name)?.[1]?.toUpperCase();
  if (item.category === "document" || item.category === "archive") {
    return extension ?? CATEGORY_BADGES[item.category];
  }
  return CATEGORY_BADGES[item.category];
}

type ListState = {
  artifacts: Artifact[];
  nextCursor?: string;
  status: "loading" | "ready" | "error";
  error?: string;
  /** 正在往下翻页 */
  more: boolean;
};

const emptyList: ListState = { artifacts: [], status: "loading", more: false };

async function fetchArtifacts(
  base: string,
  token: string,
  roomId: string,
  params: { type: ArtifactFilter; q?: string; cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<ArtifactsResponse> {
  const search = new URLSearchParams({ type: params.type, limit: String(params.limit) });
  if (params.q) search.set("q", params.q);
  if (params.cursor) search.set("cursor", params.cursor);
  const response = await fetch(
    `${base}/api/rooms/${encodeURIComponent(roomId)}/attachments?${search}`,
    { headers: { Authorization: `Bearer ${token}` }, signal },
  );
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? t("没有权限查看这个房间的产物")
        : t("产物加载失败（{0}）", { 0: response.status }),
    );
  }
  return (await response.json()) as ArtifactsResponse;
}

/**
 * 某个筛选条件下的分页列表。epoch 变了（有新附件或撤回）就按已经翻到的数量重新取一次，
 * 不清空界面，避免闪烁和滚动跳回顶部。
 */
function useArtifactList(options: {
  base: string;
  token: string | undefined;
  roomId: string;
  type: ArtifactFilter;
  q: string;
  limit: number;
  epoch: number;
  onCounts?: (counts: ArtifactCounts) => void;
  enabled?: boolean;
}) {
  const { base, token, roomId, type, q, limit, epoch, onCounts, enabled = true } = options;
  const [state, setState] = useState<ListState>(emptyList);
  const loadedRef = useRef(0);
  loadedRef.current = state.artifacts.length;
  const onCountsRef = useRef(onCounts);
  onCountsRef.current = onCounts;
  const filterKey = `${roomId}\u0000${type}\u0000${q}`;
  const lastFilterRef = useRef(filterKey);

  useEffect(() => {
    if (!token || !enabled) return;
    const sameFilter = lastFilterRef.current === filterKey;
    lastFilterRef.current = filterKey;
    // 换了筛选条件从第一页开始；只是有新事件则把已经翻到的这些一起刷新
    const size = sameFilter ? Math.min(MAX_REFRESH, Math.max(limit, loadedRef.current)) : limit;
    if (!sameFilter) setState(emptyList);
    const controller = new AbortController();
    fetchArtifacts(base, token, roomId, { type, q, limit: size }, controller.signal).then(
      (payload) => {
        onCountsRef.current?.(payload.counts);
        setState({
          artifacts: payload.artifacts,
          nextCursor: payload.nextCursor,
          status: "ready",
          more: false,
        });
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setState((current) => ({
          ...current,
          status: "error",
          error: cause instanceof Error ? cause.message : String(cause),
          more: false,
        }));
      },
    );
    return () => controller.abort();
  }, [base, enabled, epoch, filterKey, limit, q, roomId, token, type]);

  const loadMore = useCallback(() => {
    if (!token || state.more || !state.nextCursor || state.status !== "ready") return;
    const cursor = state.nextCursor;
    setState((current) => ({ ...current, more: true }));
    fetchArtifacts(base, token, roomId, { type, q, cursor, limit }).then(
      (payload) =>
        setState((current) =>
          // 翻页期间换了条件或刷新过：游标已经不是这一份列表的了，丢弃
          current.nextCursor !== cursor
            ? current
            : {
                artifacts: [
                  ...current.artifacts,
                  ...payload.artifacts.filter(
                    (item) => !current.artifacts.some((existing) => existing.id === item.id),
                  ),
                ],
                nextCursor: payload.nextCursor,
                status: "ready",
                more: false,
              },
        ),
      (cause: unknown) =>
        setState((current) => ({
          ...current,
          more: false,
          error: cause instanceof Error ? cause.message : String(cause),
        })),
    );
  }, [base, limit, q, roomId, state.more, state.nextCursor, state.status, token, type]);

  return { ...state, loadMore };
}

/**
 * 入口角标用的产物总数：只取计数（limit=1），房间切换或 epoch 变化时刷新。
 * 面板打开时由面板顺带把最新计数报上来，不必再多查一次。
 */
export function useArtifactCount(options: {
  base: string;
  token: string | undefined;
  roomId: string;
  epoch: number;
  enabled: boolean;
}): { count: number | undefined; setCounts: (counts: ArtifactCounts) => void } {
  const { base, token, roomId, epoch, enabled } = options;
  const [counts, setCounts] = useState<{ roomId: string; counts: ArtifactCounts }>();
  useEffect(() => {
    if (!token || !enabled) return;
    const controller = new AbortController();
    // 一批消息接连到达时只查一次
    const timer = window.setTimeout(() => {
      fetchArtifacts(base, token, roomId, { type: "all", limit: 1 }, controller.signal).then(
        (payload) => setCounts({ roomId, counts: payload.counts }),
        () => undefined,
      );
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [base, enabled, epoch, roomId, token]);
  const report = useCallback(
    (next: ArtifactCounts) => setCounts({ roomId, counts: next }),
    [roomId],
  );
  return { count: counts?.roomId === roomId ? counts.counts.all : undefined, setCounts: report };
}

/** 进入可视区才去取图：房间图片多时不一次全拉下来 */
function useNearViewport<T extends Element>(): [(element: T | null) => void, boolean] {
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  const observerRef = useRef<IntersectionObserver | undefined>(undefined);
  const ref = useCallback(
    (element: T | null) => {
      observerRef.current?.disconnect();
      if (!element || visible || typeof IntersectionObserver === "undefined") return;
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            setVisible(true);
            observer.disconnect();
          }
        },
        { rootMargin: "200px" },
      );
      observer.observe(element);
      observerRef.current = observer;
    },
    [visible],
  );
  useEffect(() => () => observerRef.current?.disconnect(), []);
  return [ref, visible];
}

function Thumbnail({
  item,
  base,
  token,
}: {
  item: ArtifactItem;
  base: string;
  token: string | undefined;
}) {
  const [ref, visible] = useNearViewport<HTMLSpanElement>();
  const { url, error } = useAttachmentUrl(base, token, item.id, visible);
  return (
    <span ref={ref} className={`artifact-thumb${error ? " failed" : ""}`} title={error}>
      {url ? <img src={url} alt="" loading="lazy" decoding="async" /> : null}
    </span>
  );
}

function describe(item: ArtifactItem, now: number): string {
  return [formatBytes(item.size), item.senderName, formatRelativeTime(item.createdAt, now)].join(
    " · ",
  );
}

function LocateIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        d="M4 6h16M4 12h10M4 18h7m9-4-4 4-2-2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        d="M12 4v11m-5-5 5 5 5-5M5 20h14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export type ArtifactsPanelProps = {
  base: string;
  token: string | undefined;
  roomId: string;
  /** 有新附件或撤回时加一，面板据此刷新 */
  epoch: number;
  /** 跳回聊天里的那条消息并高亮 */
  onLocate: (item: ArtifactItem) => void;
  /** 每次取到列表都把最新的各类型数量报上去，给入口角标 */
  onCounts?: (counts: ArtifactCounts) => void;
};

export function ArtifactsPanel({
  base,
  token,
  roomId,
  epoch,
  onLocate,
  onCounts,
}: ArtifactsPanelProps): ReactNode {
  const [filter, setFilter] = useState<ArtifactFilter>("all");
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [counts, setCounts] = useState<ArtifactCounts>();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // 看图器里切换的这一组：网格、「全部」顶上那一排，或某张图的历史版本
  const [lightbox, setLightbox] = useState<
    | { source: "grid" | "strip"; index: number }
    | { source: "versions"; items: Artifact[]; index: number }
  >();
  const [previewing, setPreviewing] = useState<ArtifactItem>();
  const [actionError, setActionError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());

  // 换房间：筛选、搜索、展开都回到初始
  useEffect(() => {
    setFilter("all");
    setInput("");
    setQuery("");
    setExpanded(new Set());
    setLightbox(undefined);
    setPreviewing(undefined);
  }, [roomId]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(input.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [input]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const reportCounts = useCallback(
    (next: ArtifactCounts) => {
      setCounts(next);
      onCounts?.(next);
    },
    [onCounts],
  );

  const showStrip = filter === "all" && !query;
  const strip = useArtifactList({
    base,
    token,
    roomId,
    type: "image",
    q: "",
    limit: IMAGE_STRIP_SIZE,
    epoch,
    enabled: showStrip,
  });
  const listType: ArtifactFilter = filter === "all" && !query ? "file" : filter;
  const list = useArtifactList({
    base,
    token,
    roomId,
    type: listType,
    q: query,
    limit: PAGE_SIZE,
    epoch,
    onCounts: reportCounts,
  });

  // 列表底部进入可视区就接着翻页；没有 IntersectionObserver 时用「加载更多」按钮
  const sentinelRef = useRef<HTMLButtonElement>(null);
  const loadMore = list.loadMore;
  useEffect(() => {
    const target = sentinelRef.current;
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => entries.some((entry) => entry.isIntersecting) && loadMore(),
      { rootMargin: "120px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [loadMore, list.nextCursor]);

  const gridImages = useMemo(
    (): Artifact[] => (listType === "image" ? list.artifacts : []),
    [list.artifacts, listType],
  );

  const lightboxImages: Artifact[] =
    lightbox?.source === "grid"
      ? gridImages
      : lightbox?.source === "strip"
        ? strip.artifacts
        : lightbox?.source === "versions"
          ? lightbox.items
          : [];

  // 网格里看图翻到末尾时接着往下取，可以一直翻完整个房间的图片
  useEffect(() => {
    if (lightbox?.source !== "grid") return;
    if (lightbox.index >= gridImages.length - 2) loadMore();
  }, [gridImages.length, lightbox, loadMore]);

  const closeLightbox = useCallback(() => setLightbox(undefined), []);
  const closePreview = useCallback(() => setPreviewing(undefined), []);

  const download = useCallback(
    (item: ArtifactItem) => {
      if (!token) return;
      setActionError(undefined);
      downloadAttachment(base, token, item).catch((cause: unknown) =>
        setActionError(
          t("{0} 下载失败：{1}", {
            0: item.name,
            1: cause instanceof Error ? cause.message : String(cause),
          }),
        ),
      );
    },
    [base, token],
  );

  const open = useCallback(
    (item: ArtifactItem, images?: ArtifactItem[]) => {
      if (item.kind === "image") {
        const group = images ?? [item];
        setLightbox({ source: "versions", items: group, index: Math.max(0, group.indexOf(item)) });
      } else if (previewKind(item)) {
        setPreviewing(item);
      } else {
        download(item);
      }
    },
    [download],
  );

  const locate = useCallback(
    (item: ArtifactItem) => {
      setLightbox(undefined);
      setPreviewing(undefined);
      onLocate(item);
    },
    [onLocate],
  );

  const toggleExpanded = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const subFilters = FILE_CATEGORIES.filter(
    (category) => (counts?.[category] ?? 0) > 0 || filter === category,
  );
  const fileView = filter !== "all" && filter !== "image";
  const total = counts?.all ?? 0;

  const itemActions = (item: ArtifactItem) => (
    <span className="artifact-actions">
      <button
        type="button"
        className="artifact-action"
        aria-label={t("下载 {0}", { 0: item.name })}
        title={t("下载")}
        onClick={() => download(item)}
      >
        <DownloadIcon />
      </button>
      <button
        type="button"
        className="artifact-action"
        aria-label={t("定位到 {0} 所在的消息", { 0: item.name })}
        title={t("定位到消息")}
        onClick={() => locate(item)}
      >
        <LocateIcon />
      </button>
    </span>
  );

  const fileRow = (item: ArtifactItem, versionOf?: Artifact) => {
    const previewable = item.kind === "image" || previewKind(item) !== undefined;
    return (
      <div className={`artifact-row${versionOf ? " version" : ""}`}>
        <button
          type="button"
          className="artifact-open"
          onClick={() => open(item)}
          aria-label={
            previewable ? t("预览 {0}", { 0: item.name }) : t("下载 {0}", { 0: item.name })
          }
          title={item.name}
        >
          {item.kind === "image" ? (
            <Thumbnail item={item} base={base} token={token} />
          ) : (
            <span className={`artifact-icon ${item.category}`} aria-hidden="true">
              {fileBadge(item)}
            </span>
          )}
          <span className="artifact-copy">
            <strong>{versionOf ? formatRelativeTime(item.createdAt, now) : item.name}</strong>
            <small>{describe(item, now)}</small>
          </span>
        </button>
        {itemActions(item)}
      </div>
    );
  };

  const filterButton = (value: ArtifactFilter, sub = false) => (
    <button
      type="button"
      key={value}
      className={`artifact-filter${sub ? " sub" : ""}`}
      aria-pressed={filter === value}
      onClick={() => setFilter(value)}
    >
      {FILTER_LABELS[value]}
      {counts?.[value] !== undefined && (
        <span className="artifact-filter-count">{counts[value]}</span>
      )}
    </button>
  );

  const emptyText = query
    ? t("没有文件名包含「{0}」的产物", { 0: query })
    : filter === "all"
      ? t("这个房间还没有图片或文件。人上传的、Agent 发出的附件都会汇总在这里。")
      : t("没有「{0}」类的产物", { 0: FILTER_LABELS[filter] });

  const listBody =
    list.status === "loading" && list.artifacts.length === 0 ? (
      <p className="artifact-status" role="status">
        {t("加载中…")}
      </p>
    ) : list.status === "error" && list.artifacts.length === 0 ? (
      <p className="artifact-status danger" role="alert">
        {list.error}
      </p>
    ) : list.artifacts.length === 0 ? (
      showStrip && strip.artifacts.length > 0 ? null : (
        <p className="artifact-status">{emptyText}</p>
      )
    ) : listType === "image" ? (
      <ul className="artifact-grid" aria-label={t("图片")}>
        {gridImages.map((item, index) => (
          <li key={item.id}>
            <button
              type="button"
              className="artifact-grid-item"
              onClick={() => setLightbox({ source: "grid", index })}
              aria-label={t("查看图片 {0}，{1}", { 0: item.name, 1: describe(item, now) })}
              title={`${item.name}\n${describe(item, now)}`}
            >
              <Thumbnail item={item} base={base} token={token} />
              {item.versions && (
                <span className="artifact-version-badge">
                  {t("{0} 版", { 0: item.versions.length + 1 })}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    ) : (
      <ul className="artifact-list" aria-label={showStrip ? t("文件") : FILTER_LABELS[filter]}>
        {(list.artifacts as Artifact[]).map((artifact) => {
          const isOpen = expanded.has(artifact.id);
          return (
            <li key={artifact.id}>
              {fileRow(artifact)}
              {artifact.versions && (
                <>
                  <button
                    type="button"
                    className="artifact-versions-toggle"
                    aria-expanded={isOpen}
                    aria-controls={`artifact-versions-${artifact.id}`}
                    onClick={() => toggleExpanded(artifact.id)}
                  >
                    {isOpen
                      ? t("收起历史版本")
                      : t("另有 {0} 个历史版本", { 0: artifact.versions.length })}
                  </button>
                  {isOpen && (
                    <ul
                      className="artifact-versions"
                      id={`artifact-versions-${artifact.id}`}
                      aria-label={t("{0} 的历史版本", { 0: artifact.name })}
                    >
                      {artifact.versions.map((version) => (
                        <li key={version.id}>{fileRow(version, artifact)}</li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    );

  return (
    <div className="artifacts">
      <div className="artifacts-toolbar">
        <input
          type="search"
          className="artifact-search"
          value={input}
          placeholder={t("搜索文件名")}
          aria-label={t("按文件名搜索产物")}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && input) {
              event.stopPropagation();
              setInput("");
            }
          }}
        />
        <div className="artifact-filters" role="group" aria-label={t("按类型筛选")}>
          {(["all", "image", "file"] as const).map((value) => filterButton(value))}
        </div>
        {fileView && subFilters.length > 1 && (
          <div className="artifact-filters" role="group" aria-label={t("文件类型")}>
            {subFilters.map((value) => filterButton(value, true))}
          </div>
        )}
        {actionError && (
          <p className="artifact-status danger" role="alert">
            {actionError}
          </p>
        )}
      </div>

      {showStrip && strip.artifacts.length > 0 && (
        <section className="artifact-section" aria-label={t("最新图片")}>
          <header>
            <h3>{t("图片")}</h3>
            {(counts?.image ?? 0) > strip.artifacts.length && (
              <button type="button" className="artifact-more" onClick={() => setFilter("image")}>
                {t("全部 {0} 张", { 0: counts?.image ?? 0 })}
              </button>
            )}
          </header>
          <ul className="artifact-grid strip">
            {strip.artifacts.map((item, index) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="artifact-grid-item"
                  onClick={() => setLightbox({ source: "strip", index })}
                  aria-label={t("查看图片 {0}，{1}", { 0: item.name, 1: describe(item, now) })}
                  title={`${item.name}\n${describe(item, now)}`}
                >
                  <Thumbnail item={item} base={base} token={token} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section
        className="artifact-section"
        aria-live="polite"
        aria-busy={list.status === "loading"}
      >
        {showStrip && list.artifacts.length > 0 && (
          <header>
            <h3>{t("文件")}</h3>
          </header>
        )}
        {listBody}
        {list.nextCursor && (
          <button
            ref={sentinelRef}
            type="button"
            className="artifact-load-more"
            disabled={list.more}
            onClick={loadMore}
          >
            {list.more ? t("加载中…") : t("加载更多")}
          </button>
        )}
        {list.status === "error" && list.artifacts.length > 0 && (
          <p className="artifact-status danger" role="alert">
            {list.error}
          </p>
        )}
      </section>

      {total > 0 && !list.nextCursor && list.artifacts.length > 0 && (
        <p className="artifact-footnote">{t("撤回的消息里的附件不会出现在这里。")}</p>
      )}

      {lightbox && lightboxImages[lightbox.index] && (
        <Lightbox
          images={lightboxImages}
          index={lightbox.index}
          base={base}
          token={token}
          onIndex={(index) => setLightbox((current) => current && { ...current, index })}
          onClose={closeLightbox}
          actions={(current) => {
            const item: Artifact | undefined = lightboxImages.find(
              (image) => image.id === current.id,
            );
            if (!item) return null;
            return (
              <>
                {item.versions && lightbox.source !== "versions" && (
                  <button
                    type="button"
                    className="attachment-lightbox-text"
                    title={t("在这几个版本之间切换")}
                    onClick={() =>
                      setLightbox({
                        source: "versions",
                        items: [item, ...item.versions!],
                        index: 0,
                      })
                    }
                  >
                    {t("历史版本（{0}）", { 0: item.versions.length })}
                  </button>
                )}
                <button
                  type="button"
                  className="attachment-lightbox-text"
                  title={t("下载")}
                  onClick={() => download(item)}
                >
                  {t("下载")}
                </button>
                <button
                  type="button"
                  className="attachment-lightbox-text"
                  title={t("定位到消息")}
                  onClick={() => locate(item)}
                >
                  {t("定位到消息")}
                </button>
              </>
            );
          }}
        />
      )}
      {previewing && (
        <FilePreview attachment={previewing} base={base} token={token} onClose={closePreview} />
      )}
    </div>
  );
}
