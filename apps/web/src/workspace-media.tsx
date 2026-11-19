import { useEffect, useState, type ReactNode } from "react";
import type { Attachment, WorkspaceChangeStatus, WorkspaceRawUrl } from "@superhive/protocol";
import { Lightbox } from "./attachments";
import { t } from "./i18n";
import { formatBytes } from "./workspace-diff";

/**
 * 工作区面板里的图片、音视频、PDF 预览，以及图片改动的改前 / 改后对照。
 *
 * 原始字节走服务端签发的临时链接（只对一个文件的一个版本有效、10 分钟过期、绑定查看者）：
 * <img>/<video>/<audio> 带不了请求头，又不能把房主令牌写进 URL；用链接而不是 fetch→blob，
 * 视频才能边下边播、拖进度条时按 Range 取。SVG 只用 <img> 显示，里面的脚本不会执行。
 */

/** 取原始字节临时链接的接口（和面板其他请求同一个，带房主或访客凭证） */
export type RawUrlApi = ((
  path: string,
  query?: Record<string, string | undefined>,
) => Promise<unknown>) & { base?: string };

export type MediaKind = "image" | "video" | "audio" | "pdf";

const KINDS: Record<string, MediaKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  bmp: "image",
  ico: "image",
  svg: "image",
  mp4: "video",
  m4v: "video",
  webm: "video",
  mov: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  m4a: "audio",
  flac: "audio",
  pdf: "pdf",
};

/** 按扩展名判断能不能在页面里预览（和服务端的类型白名单一致） */
export function mediaKind(path: string): MediaKind | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? KINDS[name.slice(dot + 1)] : undefined;
}

/**
 * 一处改动的两边各是哪个版本：暂存区对 HEAD、工作区对暂存区、提交对它的父提交、工作区对分叉点。
 * 新增的没有改前，删除的没有改后。
 */
export function changeSides(change: {
  mode: string;
  commit?: string | undefined;
  base?: string | undefined;
  status?: WorkspaceChangeStatus | undefined;
}): { before?: string; after?: string } {
  let before: string | undefined;
  let after: string | undefined;
  switch (change.mode) {
    case "staged":
      before = "HEAD";
      after = "index";
      break;
    case "unstaged":
      before = "index";
      after = "worktree";
      break;
    case "commit":
      before = change.commit ? `parent:${change.commit}` : undefined;
      after = change.commit;
      break;
    case "base":
      before = change.base ? `base:${change.base}` : undefined;
      after = "worktree";
      break;
    default:
      after = "worktree";
  }
  if (change.status === "A" || change.status === "?") before = undefined;
  if (change.status === "D") after = undefined;
  return { ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

/** 取一个临时链接；src 已经拼好 Server 地址，可以直接用 */
export function useRawUrl(
  api: RawUrlApi,
  source: string,
  path: string,
  ref: string | undefined,
  options: { reveal?: boolean; version?: unknown } = {},
) {
  const [state, setState] = useState<{
    data?: WorkspaceRawUrl & { src: string };
    error?: string;
    loading: boolean;
  }>({ loading: Boolean(ref) });
  const reveal = Boolean(options.reveal);
  useEffect(() => {
    if (!ref) return;
    let alive = true;
    setState({ loading: true });
    api("/raw-url", { source, path, ref, reveal: reveal ? "1" : undefined }).then(
      (value) => {
        const data = value as WorkspaceRawUrl;
        if (alive)
          setState({ data: { ...data, src: `${api.base ?? ""}${data.url}` }, loading: false });
      },
      (reason: unknown) => {
        if (alive)
          setState({
            error: reason instanceof Error ? reason.message : String(reason),
            loading: false,
          });
      },
    );
    return () => {
      alive = false;
    };
  }, [api, source, path, ref, reveal, options.version]);
  return state;
}

/** 下载按钮：点的时候才签一个下载链接，按附件方式下载 */
export function DownloadButton({
  api,
  source,
  path,
  ref = "worktree",
  label,
}: {
  api: RawUrlApi;
  source: string;
  path: string;
  ref?: string | undefined;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <>
      <button
        type="button"
        className="workspace-primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(undefined);
          try {
            const data = (await api("/raw-url", {
              source,
              path,
              ref,
              download: "1",
            })) as WorkspaceRawUrl;
            const link = document.createElement("a");
            link.href = `${api.base ?? ""}${data.url}`;
            link.download = path.slice(path.lastIndexOf("/") + 1);
            link.rel = "noopener";
            document.body.append(link);
            link.click();
            link.remove();
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? t("准备下载…") : (label ?? t("下载"))}
      </button>
      {error && (
        <p className="workspace-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** 文件类型：显示扩展名（PNG、MP4…），比「图片」「视频」更具体 */
function typeLabel(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : undefined;
}

/** 一个文件某个版本的预览：骨架 → 图片 / 播放器 / PDF；太大或类型不支持时给下载 */
export function MediaView({
  api,
  source,
  path,
  ref = "worktree",
  version,
  label,
  compact = false,
}: {
  api: RawUrlApi;
  source: string;
  path: string;
  ref?: string;
  /** 变了就重新取（文件又改了） */
  version?: unknown;
  /** 对照时标在上方：改前 / 改后 */
  label?: string;
  /** 对照里的一边：不显示下面那行信息里的类型 */
  compact?: boolean;
}) {
  const kind = mediaKind(path);
  const raw = useRawUrl(api, source, path, ref, { version });
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    setSize(undefined);
    setFailed(false);
  }, [raw.data?.src]);
  const name = path.slice(path.lastIndexOf("/") + 1);

  let body: ReactNode;
  if (raw.loading)
    body = <div className={`workspace-media-skeleton ${kind ?? ""}`} aria-label={t("加载中…")} />;
  else if (raw.error)
    body = (
      <p className="workspace-error" role="alert">
        {raw.error}
      </p>
    );
  else if (!raw.data || !kind) body = null;
  else if (!raw.data.inline)
    body = (
      <div className="workspace-media-fallback">
        <p className="workspace-muted">{t("文件太大，不在页面里显示。")}</p>
        <DownloadButton api={api} source={source} path={path} ref={ref} />
      </div>
    );
  else if (failed)
    body = (
      <div className="workspace-media-fallback">
        <p className="workspace-muted">{t("浏览器无法显示这个文件。")}</p>
        <DownloadButton api={api} source={source} path={path} ref={ref} />
      </div>
    );
  else if (kind === "image")
    body = (
      <button
        type="button"
        className="workspace-media-image"
        title={t("点击放大查看")}
        aria-label={t("放大查看 {0}", { 0: name })}
        onClick={() => setZoomed(true)}
      >
        <img
          src={raw.data.src}
          alt={name}
          onLoad={(event) =>
            setSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          onError={() => setFailed(true)}
        />
      </button>
    );
  else if (kind === "video")
    body = (
      <video
        className="workspace-media-video"
        src={raw.data.src}
        controls
        preload="metadata"
        aria-label={name}
        onLoadedMetadata={(event) =>
          setSize({
            width: event.currentTarget.videoWidth,
            height: event.currentTarget.videoHeight,
          })
        }
        onError={() => setFailed(true)}
      />
    );
  else if (kind === "audio")
    body = (
      <audio
        className="workspace-media-audio"
        src={raw.data.src}
        controls
        preload="metadata"
        aria-label={name}
        onError={() => setFailed(true)}
      />
    );
  else
    body = (
      <object
        className="workspace-media-pdf"
        data={raw.data.src}
        type="application/pdf"
        aria-label={name}
      >
        <div className="workspace-media-fallback">
          <p className="workspace-muted">{t("浏览器无法内嵌显示 PDF。")}</p>
          <DownloadButton api={api} source={source} path={path} ref={ref} />
        </div>
      </object>
    );

  return (
    <figure className={`workspace-media ${kind ?? ""}`}>
      {label && <figcaption className="workspace-media-label">{label}</figcaption>}
      <div className="workspace-media-stage">{body}</div>
      {raw.data && (
        <p className="workspace-media-meta workspace-muted">
          {[
            size && size.width ? `${size.width} × ${size.height}` : undefined,
            formatBytes(raw.data.size),
            compact ? undefined : typeLabel(path),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {zoomed && raw.data && (
        <Lightbox
          images={[{ id: `workspace:${path}`, name, size: raw.data.size } as unknown as Attachment]}
          index={0}
          base=""
          token={undefined}
          src={raw.data.src}
          onIndex={() => undefined}
          onClose={() => setZoomed(false)}
        />
      )}
    </figure>
  );
}

const COMPARE_KEY = "superhive.workspace-image-compare";

/** 改动对照：图片可选并排或滑动对比；音视频并排两个播放器；只有一边时只显示那一边 */
export function MediaCompare({
  api,
  source,
  path,
  oldPath,
  before,
  after,
  version,
}: {
  api: RawUrlApi;
  source: string;
  path: string;
  oldPath?: string | undefined;
  before?: string | undefined;
  after?: string | undefined;
  version?: unknown;
}) {
  const kind = mediaKind(path);
  const [mode, setMode] = useState<"side" | "slider">(() =>
    localStorage.getItem(COMPARE_KEY) === "slider" ? "slider" : "side",
  );
  const choose = (next: "side" | "slider") => {
    localStorage.setItem(COMPARE_KEY, next);
    setMode(next);
  };
  const both = Boolean(before && after);
  return (
    <div className="workspace-compare">
      {both && kind === "image" && (
        <div className="workspace-segmented" role="radiogroup" aria-label={t("对照方式")}>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "side"}
            className={mode === "side" ? "active" : ""}
            onClick={() => choose("side")}
          >
            {t("并排")}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "slider"}
            className={mode === "slider" ? "active" : ""}
            onClick={() => choose("slider")}
          >
            {t("滑动对比")}
          </button>
        </div>
      )}
      {both && kind === "image" && mode === "slider" ? (
        <ImageSlider
          api={api}
          source={source}
          beforePath={oldPath ?? path}
          afterPath={path}
          before={before!}
          after={after!}
          version={version}
        />
      ) : (
        <div className={`workspace-compare-sides ${both ? "both" : ""}`}>
          {before && (
            <MediaView
              api={api}
              source={source}
              path={oldPath ?? path}
              ref={before}
              version={version}
              label={after ? t("改前") : t("已删除")}
              compact
            />
          )}
          {after && (
            <MediaView
              api={api}
              source={source}
              path={path}
              ref={after}
              version={version}
              label={before ? t("改后") : t("新增")}
              compact
            />
          )}
        </div>
      )}
    </div>
  );
}

/** 滑动对比：改后的图盖在改前上面，拖动（或用方向键调）分界线左边露出改前 */
function ImageSlider({
  api,
  source,
  beforePath,
  afterPath,
  before,
  after,
  version,
}: {
  api: RawUrlApi;
  source: string;
  beforePath: string;
  afterPath: string;
  before: string;
  after: string;
  version?: unknown;
}) {
  const left = useRawUrl(api, source, beforePath, before, { version });
  const right = useRawUrl(api, source, afterPath, after, { version });
  const [position, setPosition] = useState(50);
  if (left.loading || right.loading) return <div className="workspace-media-skeleton image" />;
  const error = left.error ?? right.error;
  if (error)
    return (
      <p className="workspace-error" role="alert">
        {error}
      </p>
    );
  return (
    <div className="workspace-slider">
      <div className="workspace-slider-stage">
        {/* 改后的图按改前那张的框缩放后盖在上面，分界线和裁切都以这个框为准 */}
        <div className="workspace-slider-frame">
          <img src={left.data?.src} alt={t("改前")} />
          <div className="workspace-slider-after" style={{ clipPath: `inset(0 0 0 ${position}%)` }}>
            <img src={right.data?.src} alt={t("改后")} />
          </div>
          <span
            className="workspace-slider-line"
            style={{ left: `${position}%` }}
            aria-hidden="true"
          />
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={position}
        aria-label={t("左边是改前，右边是改后；拖动调整分界")}
        onChange={(event) => setPosition(Number(event.target.value))}
      />
    </div>
  );
}
