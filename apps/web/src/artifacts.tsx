import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  Artifact,
  ArtifactCategory,
  ArtifactCounts,
  ArtifactFilter,
  ArtifactItem,
  ArtifactSender,
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
import { getLocale, localized, t } from "./i18n";
import { SheetPanel } from "./sheet-panel";
import { formatRelativeTime } from "./whiteboard";

/**
 * 房间「产物」面板：汇总房间里随消息发出的图片和文件，和「代码」一样是从头部打开的大面板。
 * - 左栏筛选：类型（含文件细分类型）、发送者、时间，加文件名搜索；
 * - 中间：图片是大缩略图网格（可切成列表），文件是表格（名称、类型、大小、发送者、时间、操作）；
 *   「全部」的网格视图上面一块最新图片，下面文件表格；
 * - 右侧详情栏：选中某项时出现，预览、文件信息、历史版本、下载、定位到消息；
 * - 同一个人发的同名文件合成一项，显示最新版，详情栏里能看、能选历史版本；
 * - 看图用消息里同一个看图器，可以在面板里的图片之间左右切换；文件用同一个预览窗口；
 * - 新附件、撤回由 App 在收到消息事件时把 epoch 加一，面板就地刷新，选中的、翻到的位置保留。
 */

const PAGE_SIZE = 40;
/** 「全部」里最新图片那一块最多放几张 */
const IMAGE_STRIP_SIZE = 12;
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

/** 列表的筛选条件：类型、文件名，以及发送者和起始时间（范围，计数跟着变） */
type ListParams = { type: ArtifactFilter; q?: string; sender?: string; since?: string };

async function fetchArtifacts(
  base: string,
  token: string,
  roomId: string,
  params: ListParams & { cursor?: string; limit: number },
  signal?: AbortSignal,
): Promise<ArtifactsResponse> {
  const search = new URLSearchParams({ type: params.type, limit: String(params.limit) });
  if (params.q) search.set("q", params.q);
  if (params.sender) search.set("sender", params.sender);
  if (params.since) search.set("since", params.since);
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
  params: ListParams;
  limit: number;
  epoch: number;
  onPayload?: (payload: ArtifactsResponse) => void;
  enabled?: boolean;
}) {
  const { base, token, roomId, params, limit, epoch, onPayload, enabled = true } = options;
  const { type, q = "", sender = "", since = "" } = params;
  const [state, setState] = useState<ListState>(emptyList);
  const loadedRef = useRef(0);
  loadedRef.current = state.artifacts.length;
  const onPayloadRef = useRef(onPayload);
  onPayloadRef.current = onPayload;
  const filterKey = [roomId, type, q, sender, since].join("\u0000");
  const lastFilterRef = useRef(filterKey);

  useEffect(() => {
    if (!token || !enabled) return;
    const sameFilter = lastFilterRef.current === filterKey;
    lastFilterRef.current = filterKey;
    // 换了筛选条件从第一页开始；只是有新事件则把已经翻到的这些一起刷新
    const size = sameFilter ? Math.min(MAX_REFRESH, Math.max(limit, loadedRef.current)) : limit;
    if (!sameFilter) setState(emptyList);
    const controller = new AbortController();
    fetchArtifacts(
      base,
      token,
      roomId,
      { type, q, sender: sender || undefined, since: since || undefined, limit: size },
      controller.signal,
    ).then(
      (payload) => {
        onPayloadRef.current?.(payload);
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
  }, [base, enabled, epoch, filterKey, limit, q, roomId, sender, since, token, type]);

  const loadMore = useCallback(() => {
    if (!token || state.more || !state.nextCursor || state.status !== "ready") return;
    const cursor = state.nextCursor;
    setState((current) => ({ ...current, more: true }));
    fetchArtifacts(base, token, roomId, {
      type,
      q,
      sender: sender || undefined,
      since: since || undefined,
      cursor,
      limit,
    }).then(
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
  }, [
    base,
    limit,
    q,
    roomId,
    sender,
    since,
    state.more,
    state.nextCursor,
    state.status,
    token,
    type,
  ]);

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

function FilesGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path
        d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zm0 0v5h5M9 13h6m-6 4h4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ViewIcon({ view }: { view: ArtifactView }) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        d={
          view === "grid"
            ? "M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z"
            : "M4 6h16M4 12h16M4 18h16"
        }
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 详情栏里的大图：按容器缩放，透明处棋盘格 */
function DetailImage({
  item,
  base,
  token,
}: {
  item: ArtifactItem;
  base: string;
  token: string | undefined;
}) {
  const { url, error } = useAttachmentUrl(base, token, item.id, true);
  if (error) return <span className="artifact-detail-status danger">{error}</span>;
  return url ? (
    <img src={url} alt={item.name} decoding="async" />
  ) : (
    <span className="artifact-detail-status">{t("加载中…")}</span>
  );
}

type ArtifactView = "grid" | "list";
type TimeRange = "any" | "today" | "week" | "month";

/** 网格还是列表记在本机；只影响图片怎么摆，文件总是表格 */
const VIEW_KEY = "superhive.artifacts-view";

const RANGE_LABELS: Record<TimeRange, string> = localized(() => ({
  any: t("不限时间"),
  today: t("今天"),
  week: t("最近 7 天"),
  month: t("最近 30 天"),
}));

function rangeStart(range: TimeRange): string | undefined {
  if (range === "any") return undefined;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (range === "week") start.setDate(start.getDate() - 6);
  if (range === "month") start.setDate(start.getDate() - 29);
  return start.toISOString();
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(getLocale(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export type ArtifactsPanelProps = {
  base: string;
  token: string | undefined;
  roomId: string;
  /** 有新附件或撤回时加一，面板据此刷新 */
  epoch: number;
  /** 跳回聊天里的那条消息并高亮（调用方先关面板） */
  onLocate: (item: ArtifactItem) => void;
  /** 没按发送者、时间筛时，把最新的各类型数量报上去，给入口角标 */
  onCounts?: (counts: ArtifactCounts) => void;
  onClose: () => void;
};

export function ArtifactsPanel({
  base,
  token,
  roomId,
  epoch,
  onLocate,
  onCounts,
  onClose,
}: ArtifactsPanelProps): ReactNode {
  const [filter, setFilter] = useState<ArtifactFilter>("all");
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [sender, setSender] = useState<string>();
  const [range, setRange] = useState<TimeRange>("any");
  const [view, setViewState] = useState<ArtifactView>(() =>
    localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid",
  );
  const [counts, setCounts] = useState<ArtifactCounts>();
  const [senders, setSenders] = useState<ArtifactSender[]>([]);
  // 详情栏：选中的那一项（可能是某个历史版本）和它所属的产物
  const [selected, setSelected] = useState<{ artifactId: string; itemId: string }>();
  // 看图器里切换的这一组：网格、「全部」顶上那一排，或某张图的历史版本
  const [lightbox, setLightbox] = useState<
    | { source: "grid" | "strip"; index: number }
    | { source: "versions"; items: ArtifactItem[]; index: number }
  >();
  const [previewing, setPreviewing] = useState<ArtifactItem>();
  const [actionError, setActionError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const mainRef = useRef<HTMLDivElement>(null);

  const setView = (next: ArtifactView) => {
    setViewState(next);
    localStorage.setItem(VIEW_KEY, next);
  };

  // 换房间：筛选、搜索、选中都回到初始
  useEffect(() => {
    setFilter("all");
    setInput("");
    setQuery("");
    setSender(undefined);
    setRange("any");
    setSenders([]);
    setSelected(undefined);
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

  const since = useMemo(() => rangeStart(range), [range]);
  const scoped = Boolean(sender || since);
  const onPayload = useCallback(
    (payload: ArtifactsResponse) => {
      setCounts(payload.counts);
      if (payload.senders) setSenders(payload.senders);
      if (!scoped) onCounts?.(payload.counts);
    },
    [onCounts, scoped],
  );

  // 「全部」的网格视图：上面一块最新图片，下面文件表格；列表视图或搜索时合成一张表
  const sectioned = filter === "all" && !query && view === "grid";
  const strip = useArtifactList({
    base,
    token,
    roomId,
    params: { type: "image", sender, since },
    limit: IMAGE_STRIP_SIZE,
    epoch,
    enabled: sectioned,
  });
  const listType: ArtifactFilter = sectioned ? "file" : filter;
  const list = useArtifactList({
    base,
    token,
    roomId,
    params: { type: listType, q: query, sender, since },
    limit: PAGE_SIZE,
    epoch,
    onPayload,
  });
  const imageGrid = listType === "image" && view === "grid";

  // 列表底部进入可视区就接着翻页；没有 IntersectionObserver 时用「加载更多」按钮
  const sentinelRef = useRef<HTMLButtonElement>(null);
  const loadMore = list.loadMore;
  useEffect(() => {
    const target = sentinelRef.current;
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => entries.some((entry) => entry.isIntersecting) && loadMore(),
      { root: mainRef.current, rootMargin: "240px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [loadMore, list.nextCursor]);

  const gridImages = useMemo(
    (): Artifact[] => (listType === "image" ? list.artifacts : []),
    [list.artifacts, listType],
  );

  const lightboxImages: ArtifactItem[] =
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

  // 选中项随列表刷新：撤回了就关掉详情栏
  const selectedArtifact = selected
    ? [...list.artifacts, ...strip.artifacts].find((item) => item.id === selected.artifactId)
    : undefined;
  const selectedItem: ArtifactItem | undefined = selectedArtifact
    ? [selectedArtifact, ...(selectedArtifact.versions ?? [])].find(
        (item) => item.id === selected?.itemId,
      )
    : undefined;
  useEffect(() => {
    if (selected && list.status === "ready" && !selectedItem) setSelected(undefined);
  }, [list.status, selected, selectedItem]);

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

  /** 打开大图或预览；两者都不支持的只能下载 */
  const open = useCallback(
    (item: ArtifactItem, group?: Artifact) => {
      if (item.kind === "image") {
        const items = group ? [group, ...(group.versions ?? [])] : [item];
        setLightbox({
          source: "versions",
          items,
          index: Math.max(
            0,
            items.findIndex((entry) => entry.id === item.id),
          ),
        });
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

  /** 点一下选中看详情；已经选中的再点一下（或双击）打开 */
  const activate = (artifact: Artifact, openNow = false) => {
    if (openNow || (selected?.artifactId === artifact.id && selected.itemId === artifact.id)) {
      open(artifact, artifact);
    }
    setSelected({ artifactId: artifact.id, itemId: artifact.id });
  };

  /** 关详情栏，焦点回到选中的那一项（不在列表里了就回到面板），键盘接着能用 */
  const closeDetail = () => {
    const main = mainRef.current;
    const target =
      main?.querySelector<HTMLElement>(
        '[aria-pressed="true"].artifact-open, .artifact-tile.selected',
      ) ?? main?.closest<HTMLElement>(".sheet-panel");
    setSelected(undefined);
    target?.focus();
  };

  const clearScope = () => {
    setSender(undefined);
    setRange("any");
  };

  const total = counts?.all ?? 0;
  const subFilters = FILE_CATEGORIES.filter(
    (category) => (counts?.[category] ?? 0) > 0 || filter === category,
  );
  const fileFilter = filter !== "all" && filter !== "image";
  const senderName = senders.find((item) => item.id === sender)?.name;

  const filterButton = (value: ArtifactFilter, sub = false) => (
    <button
      type="button"
      key={value}
      className={`artifact-filter${sub ? " sub" : ""}`}
      aria-pressed={filter === value}
      onClick={() => setFilter(value)}
    >
      <span className="artifact-filter-label">{FILTER_LABELS[value]}</span>
      {counts?.[value] !== undefined && (
        <span className="artifact-filter-count">{counts[value]}</span>
      )}
    </button>
  );

  const itemActions = (item: ArtifactItem) => (
    <span className="artifact-actions">
      <button
        type="button"
        className="artifact-action"
        aria-label={t("下载 {0}", { 0: item.name })}
        title={t("下载")}
        onClick={(event) => {
          event.stopPropagation();
          download(item);
        }}
      >
        <DownloadIcon />
      </button>
      <button
        type="button"
        className="artifact-action"
        aria-label={t("定位到 {0} 所在的消息", { 0: item.name })}
        title={t("定位到消息")}
        onClick={(event) => {
          event.stopPropagation();
          locate(item);
        }}
      >
        <LocateIcon />
      </button>
    </span>
  );

  const fileIcon = (item: ArtifactItem) =>
    item.kind === "image" ? (
      <Thumbnail item={item} base={base} token={token} />
    ) : (
      <span className={`artifact-icon ${item.category}`} aria-hidden="true">
        {fileBadge(item)}
      </span>
    );

  const imageTile = (item: Artifact, onOpen: () => void) => {
    const isSelected = selected?.artifactId === item.id;
    return (
      <li key={item.id}>
        <button
          type="button"
          className={`artifact-tile${isSelected ? " selected" : ""}`}
          aria-pressed={isSelected}
          onClick={() => (isSelected ? onOpen() : activate(item))}
          onDoubleClick={onOpen}
          aria-label={t("查看图片 {0}，{1}", { 0: item.name, 1: describe(item, now) })}
          title={`${item.name}\n${describe(item, now)}`}
        >
          <span className="artifact-tile-image">
            <Thumbnail item={item} base={base} token={token} />
            {item.versions && (
              <span className="artifact-version-badge">
                {t("{0} 版", { 0: item.versions.length + 1 })}
              </span>
            )}
          </span>
          <span className="artifact-tile-caption">
            <strong>{item.name}</strong>
            <small>
              {item.senderName} · {formatRelativeTime(item.createdAt, now)}
            </small>
          </span>
        </button>
      </li>
    );
  };

  const table = (artifacts: Artifact[], label: string) => (
    <table className="artifact-table" aria-label={label}>
      <thead>
        <tr>
          <th scope="col">{t("名称")}</th>
          <th scope="col" className="artifact-col-type">
            {t("类型")}
          </th>
          <th scope="col" className="artifact-col-size">
            {t("大小")}
          </th>
          <th scope="col" className="artifact-col-sender">
            {t("发送者")}
          </th>
          <th scope="col" className="artifact-col-time">
            {t("时间")}
          </th>
          <th scope="col" className="artifact-col-actions">
            <span className="sr-only">{t("操作")}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {artifacts.map((artifact) => {
          const isSelected = selected?.artifactId === artifact.id;
          return (
            <tr
              key={artifact.id}
              className={isSelected ? "selected" : undefined}
              onClick={() => activate(artifact)}
              onDoubleClick={() => activate(artifact, true)}
            >
              <td>
                <button
                  type="button"
                  className="artifact-open"
                  aria-pressed={isSelected}
                  aria-label={t("{0}，{1}", { 0: artifact.name, 1: describe(artifact, now) })}
                  title={artifact.name}
                  onClick={(event) => {
                    event.stopPropagation();
                    activate(artifact);
                  }}
                >
                  {fileIcon(artifact)}
                  <span className="artifact-name">{artifact.name}</span>
                  {artifact.versions && (
                    <span className="artifact-version-chip">
                      {t("{0} 版", { 0: artifact.versions.length + 1 })}
                    </span>
                  )}
                </button>
              </td>
              <td className="artifact-col-type">{FILTER_LABELS[artifact.category]}</td>
              <td className="artifact-col-size">{formatBytes(artifact.size)}</td>
              <td className="artifact-col-sender">{artifact.senderName}</td>
              <td className="artifact-col-time" title={formatDateTime(artifact.createdAt)}>
                {formatRelativeTime(artifact.createdAt, now)}
              </td>
              <td className="artifact-col-actions">{itemActions(artifact)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const emptyText = query
    ? t("没有文件名包含「{0}」的产物", { 0: query })
    : scoped
      ? t("这个范围里没有产物")
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
      sectioned && strip.artifacts.length > 0 ? null : (
        <p className="artifact-status">{emptyText}</p>
      )
    ) : imageGrid ? (
      <ul className="artifact-grid" aria-label={t("图片")}>
        {gridImages.map((item, index) =>
          imageTile(item, () => setLightbox({ source: "grid", index })),
        )}
      </ul>
    ) : (
      table(list.artifacts, sectioned ? t("文件") : FILTER_LABELS[filter])
    );

  const heading = query ? t("搜索「{0}」", { 0: query }) : FILTER_LABELS[filter];
  const headingCount = query ? undefined : counts?.[filter];

  const detail = selectedItem && selectedArtifact && (
    <aside className="artifact-detail" aria-label={t("{0} 的详情", { 0: selectedItem.name })}>
      <header className="artifact-detail-header">
        <h3 title={selectedItem.name}>{selectedItem.name}</h3>
        <button
          type="button"
          className="sheet-icon-button"
          aria-label={t("关闭详情")}
          title={t("关闭详情")}
          onClick={closeDetail}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </header>
      <div className="artifact-detail-scroll">
        {selectedItem.kind === "image" ? (
          <button
            type="button"
            className="artifact-detail-preview image"
            aria-label={t("查看大图 {0}", { 0: selectedItem.name })}
            title={t("查看大图")}
            onClick={() => open(selectedItem, selectedArtifact)}
          >
            <DetailImage key={selectedItem.id} item={selectedItem} base={base} token={token} />
          </button>
        ) : (
          <div className="artifact-detail-preview">
            <span className={`artifact-icon large ${selectedItem.category}`} aria-hidden="true">
              {fileBadge(selectedItem)}
            </span>
          </div>
        )}
        <div className="artifact-detail-actions">
          {(selectedItem.kind === "image" || previewKind(selectedItem)) && (
            <button
              type="button"
              className="artifact-button primary"
              onClick={() => open(selectedItem, selectedArtifact)}
            >
              {selectedItem.kind === "image" ? t("查看大图") : t("预览")}
            </button>
          )}
          <button type="button" className="artifact-button" onClick={() => download(selectedItem)}>
            <DownloadIcon />
            {t("下载")}
          </button>
          <button type="button" className="artifact-button" onClick={() => locate(selectedItem)}>
            <LocateIcon />
            {t("定位到消息")}
          </button>
        </div>
        <dl className="artifact-detail-info">
          <dt>{t("类型")}</dt>
          <dd>
            {FILTER_LABELS[selectedItem.category]}
            <span className="artifact-detail-muted"> · {selectedItem.mime}</span>
          </dd>
          <dt>{t("大小")}</dt>
          <dd>{formatBytes(selectedItem.size)}</dd>
          {selectedItem.width && selectedItem.height ? (
            <>
              <dt>{t("尺寸")}</dt>
              <dd>
                {selectedItem.width} × {selectedItem.height}
              </dd>
            </>
          ) : null}
          <dt>{t("发送者")}</dt>
          <dd>
            {selectedItem.senderName}
            {selectedItem.senderType === "agent" && (
              <span className="artifact-detail-tag">Agent</span>
            )}
          </dd>
          <dt>{t("时间")}</dt>
          <dd>
            {formatDateTime(selectedItem.createdAt)}
            <span className="artifact-detail-muted">
              {" "}
              · {formatRelativeTime(selectedItem.createdAt, now)}
            </span>
          </dd>
        </dl>
        {selectedArtifact.versions && (
          <section className="artifact-detail-versions">
            <h4>{t("历史版本（{0}）", { 0: selectedArtifact.versions.length + 1 })}</h4>
            <ul aria-label={t("{0} 的历史版本", { 0: selectedArtifact.name })}>
              {[selectedArtifact, ...selectedArtifact.versions].map((version, index) => {
                const current = version.id === selectedItem.id;
                return (
                  <li key={version.id} className={current ? "current" : undefined}>
                    <button
                      type="button"
                      className="artifact-version"
                      aria-pressed={current}
                      onClick={() =>
                        setSelected({ artifactId: selectedArtifact.id, itemId: version.id })
                      }
                    >
                      <strong>
                        {index === 0 ? t("最新版") : formatRelativeTime(version.createdAt, now)}
                      </strong>
                      <small>
                        {formatBytes(version.size)} · {formatDateTime(version.createdAt)}
                      </small>
                    </button>
                    {itemActions(version)}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );

  return (
    <SheetPanel
      storageKey="superhive.artifacts"
      className="artifacts-sheet"
      icon={<FilesGlyph />}
      title={t("产物")}
      subtitle={total > 0 && !scoped ? t("{0} 个图片和文件", { 0: total }) : undefined}
      closeLabel={t("关闭产物面板")}
      onClose={onClose}
    >
      <div
        className={`artifacts-layout${detail ? " with-detail" : ""}`}
        onKeyDown={(event) => {
          // Esc 先关详情栏，再按一次才关面板
          if (event.key === "Escape" && selected && !event.defaultPrevented) {
            event.preventDefault();
            closeDetail();
          }
        }}
      >
        <nav className="artifacts-sidebar" aria-label={t("筛选产物")}>
          <input
            type="search"
            className="artifact-search"
            value={input}
            placeholder={t("搜索文件名")}
            aria-label={t("按文件名搜索产物")}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && input) {
                event.preventDefault();
                setInput("");
              }
            }}
          />
          <div className="artifact-filter-group" role="group" aria-label={t("按类型筛选")}>
            <h3 aria-hidden="true">{t("类型")}</h3>
            {filterButton("all")}
            {filterButton("image")}
            {filterButton("file")}
            {subFilters.length > 0 && (
              <div className="artifact-subfilters" role="group" aria-label={t("文件类型")}>
                {subFilters.map((value) => filterButton(value, true))}
              </div>
            )}
          </div>
          {senders.length > 1 && (
            <div className="artifact-filter-group" role="group" aria-label={t("按发送者筛选")}>
              <h3 aria-hidden="true">{t("发送者")}</h3>
              <button
                type="button"
                className="artifact-filter"
                aria-pressed={!sender}
                onClick={() => setSender(undefined)}
              >
                <span className="artifact-filter-label">{t("所有人")}</span>
              </button>
              {senders.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className="artifact-filter"
                  aria-pressed={sender === item.id}
                  onClick={() => setSender(item.id)}
                  title={item.name}
                >
                  <span className="artifact-filter-label">{item.name}</span>
                  {item.type === "agent" && (
                    <span className="artifact-detail-tag" aria-hidden="true">
                      Agent
                    </span>
                  )}
                  <span className="artifact-filter-count">{item.count}</span>
                </button>
              ))}
            </div>
          )}
          <div className="artifact-filter-group" role="group" aria-label={t("按时间筛选")}>
            <h3 aria-hidden="true">{t("时间")}</h3>
            {(["any", "today", "week", "month"] as const).map((value) => (
              <button
                type="button"
                key={value}
                className="artifact-filter"
                aria-pressed={range === value}
                onClick={() => setRange(value)}
              >
                <span className="artifact-filter-label">{RANGE_LABELS[value]}</span>
              </button>
            ))}
          </div>
        </nav>

        <div className="artifacts-main" ref={mainRef}>
          <div className="artifacts-main-toolbar">
            <h3>
              {heading}
              {headingCount !== undefined && (
                <span className="artifact-filter-count">{headingCount}</span>
              )}
            </h3>
            {scoped && (
              <button type="button" className="artifact-scope" onClick={clearScope}>
                {[senderName, range !== "any" ? RANGE_LABELS[range] : undefined]
                  .filter(Boolean)
                  .join(" · ")}
                <span aria-hidden="true"> ×</span>
                <span className="sr-only">{t("清除发送者和时间筛选")}</span>
              </button>
            )}
            {!fileFilter && (
              <div className="artifact-view-toggle" role="group" aria-label={t("图片显示方式")}>
                {(["grid", "list"] as const).map((value) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={view === value}
                    aria-label={value === "grid" ? t("网格") : t("列表")}
                    title={value === "grid" ? t("网格") : t("列表")}
                    onClick={() => setView(value)}
                  >
                    <ViewIcon view={value} />
                  </button>
                ))}
              </div>
            )}
          </div>
          {actionError && (
            <p className="artifact-status danger" role="alert">
              {actionError}
            </p>
          )}

          {sectioned && strip.artifacts.length > 0 && (
            <section className="artifact-section" aria-label={t("最新图片")}>
              <header>
                <h4>{t("图片")}</h4>
                {(counts?.image ?? 0) > strip.artifacts.length && (
                  <button
                    type="button"
                    className="artifact-more"
                    onClick={() => setFilter("image")}
                  >
                    {t("全部 {0} 张", { 0: counts?.image ?? 0 })}
                  </button>
                )}
              </header>
              <ul className="artifact-grid">
                {strip.artifacts.map((item, index) =>
                  imageTile(item, () => setLightbox({ source: "strip", index })),
                )}
              </ul>
            </section>
          )}

          <section
            className="artifact-section"
            aria-live="polite"
            aria-busy={list.status === "loading"}
          >
            {sectioned && list.artifacts.length > 0 && (
              <header>
                <h4>{t("文件")}</h4>
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
        </div>

        {detail}
      </div>

      {lightbox && lightboxImages[lightbox.index] && (
        <Lightbox
          images={lightboxImages}
          index={lightbox.index}
          base={base}
          token={token}
          onIndex={(index) => {
            setLightbox((current) => current && { ...current, index });
            // 详情栏跟着看图器翻到的那张
            const image = lightboxImages[index];
            if (image && lightbox.source !== "versions")
              setSelected({ artifactId: image.id, itemId: image.id });
          }}
          onClose={closeLightbox}
          actions={(current) => {
            const item = lightboxImages.find((image) => image.id === current.id) as
              Artifact | undefined;
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
    </SheetPanel>
  );
}
