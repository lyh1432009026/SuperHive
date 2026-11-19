import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { t } from "../i18n";
import { useElementSize } from "./hooks";
import { IsolatedFrame } from "./isolated-frame";
import { renderPptx, type RenderedSlide } from "./pptx-render";
import type { OfficeViewProps } from "./types";

const SLIDE_CSS = "html,body{margin:0;overflow:hidden;background:#fff}";
/** 面板至少这么宽才在左边放缩略图栏 */
const THUMBS_MIN_WIDTH = 720;
const THUMB_WIDTH = 132;

/** 整页放进舞台：按宽高里更紧的那一边缩放，不放大到超过两倍 */
export function slideScale(
  stage: { width: number; height: number },
  slide: { width: number; height: number },
): number {
  if (stage.width <= 0 || slide.width <= 0) return 1;
  const byWidth = stage.width / slide.width;
  const byHeight = stage.height > 0 ? stage.height / slide.height : byWidth;
  return Math.max(0.05, Math.min(2, byWidth, byHeight));
}

/** 一页幻灯片：按原尺寸放进 iframe，再整体缩放；iframe 不接收鼠标，键盘焦点留在外面翻页 */
function SlideFrame({
  slide,
  scale,
  title,
  lazy = false,
}: {
  slide: RenderedSlide;
  scale: number;
  title: string;
  lazy?: boolean;
}) {
  return (
    <div
      className="office-slide"
      style={{ width: slide.width * scale, height: slide.height * scale }}
    >
      <IsolatedFrame
        className="office-slide-frame"
        title={title}
        body={slide.body}
        css={SLIDE_CSS}
        lazy={lazy}
        style={{
          width: slide.width,
          height: slide.height,
          transform: `scale(${scale})`,
        }}
      />
    </div>
  );
}

export default function PptxView({ bytes, name, compact, onError }: OfficeViewProps) {
  const [deck, setDeck] = useState<{ bytes: Uint8Array; slides: RenderedSlide[] }>();
  const [index, setIndex] = useState(0);
  useEffect(() => {
    let alive = true;
    setIndex(0);
    renderPptx(bytes).then(
      (slides) => alive && setDeck({ bytes, slides }),
      (cause: unknown) => alive && onError(cause),
    );
    return () => {
      alive = false;
    };
  }, [bytes, onError]);
  const slides = deck?.bytes === bytes ? deck.slides : undefined;
  const count = slides?.length ?? 0;
  const go = useCallback(
    (next: number) => setIndex(Math.max(0, Math.min(count - 1, next))),
    [count],
  );

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [measureRoot, rootSize] = useElementSize<HTMLDivElement>();
  const [measureStage, stageSize] = useElementSize<HTMLDivElement>();
  const setRoot = useCallback(
    (element: HTMLDivElement | null) => {
      rootRef.current = element;
      measureRoot(element);
    },
    [measureRoot],
  );
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen?.().catch(() => undefined);
  };

  // 当前页的缩略图滚到看得见的地方
  const thumbsRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const active = thumbsRef.current?.querySelector<HTMLElement>(`[data-slide="${index}"]`);
    active?.scrollIntoView?.({ block: "nearest" });
  }, [index]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowDown: 1,
      PageDown: 1,
      " ": 1,
      ArrowLeft: -1,
      ArrowUp: -1,
      PageUp: -1,
    };
    if (event.key in step) go(index + step[event.key]!);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(count - 1);
    else return;
    event.preventDefault();
  };

  if (!slides)
    return (
      <p className="office-preview-status" role="status">
        {t("正在排版幻灯片…")}
      </p>
    );
  const slide = slides[Math.min(index, count - 1)]!;
  const showThumbs = !compact && !fullscreen && rootSize.width >= THUMBS_MIN_WIDTH && count > 1;
  return (
    <div
      ref={setRoot}
      className={`office-pptx${compact ? " compact" : ""}${fullscreen ? " fullscreen" : ""}`}
      tabIndex={0}
      role="region"
      aria-roledescription={t("幻灯片")}
      aria-label={name}
      onKeyDown={onKeyDown}
    >
      <div className="office-pptx-main">
        {showThumbs && (
          <nav className="office-pptx-thumbs" aria-label={t("幻灯片缩略图")} ref={thumbsRef}>
            {slides.map((item, position) => (
              <button
                type="button"
                key={position}
                data-slide={position}
                className={position === index ? "active" : ""}
                aria-current={position === index ? "true" : undefined}
                aria-label={t("第 {0} 页", { 0: position + 1 })}
                onClick={() => go(position)}
              >
                <SlideFrame
                  slide={item}
                  scale={THUMB_WIDTH / item.width}
                  title={t("第 {0} 页", { 0: position + 1 })}
                  lazy
                />
                <span>{position + 1}</span>
              </button>
            ))}
          </nav>
        )}
        <div className="office-pptx-stage" ref={measureStage}>
          {stageSize.width > 0 && (
            <SlideFrame
              key={index}
              slide={slide}
              scale={slideScale(stageSize, slide)}
              title={t("{0} 第 {1} 页", { 0: name, 1: index + 1 })}
            />
          )}
        </div>
      </div>
      <div className="office-pptx-bar">
        <button
          type="button"
          onClick={() => go(index - 1)}
          disabled={index === 0}
          aria-label={t("上一页")}
          title={t("上一页")}
        >
          ‹
        </button>
        <span className="office-pptx-count" aria-live="polite">
          {index + 1} / {count}
        </span>
        <button
          type="button"
          onClick={() => go(index + 1)}
          disabled={index >= count - 1}
          aria-label={t("下一页")}
          title={t("下一页")}
        >
          ›
        </button>
        {!compact && typeof document.documentElement.requestFullscreen === "function" && (
          <button
            type="button"
            className="office-pptx-fullscreen"
            aria-pressed={fullscreen}
            onClick={toggleFullscreen}
          >
            {fullscreen ? t("退出全屏") : t("全屏放映")}
          </button>
        )}
      </div>
    </div>
  );
}
