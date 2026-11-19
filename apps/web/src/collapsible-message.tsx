import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { t } from "./i18n";

/**
 * 与 protocol 的 LIMITS.maxMessageLength 保持一致（由 collapsible-message.test.ts 校验）。
 * 前端只做类型导入，直接引用会把 zod 打进页面包。
 */
export const MAX_MESSAGE_LENGTH = 100_000;
/** 输入超过上限的这个比例时才显示字数，平时不打扰 */
export const MESSAGE_LENGTH_WARNING_RATIO = 0.9;

const COLLAPSE_LINE_THRESHOLD = 18;
const COLLAPSE_HEIGHT_THRESHOLD = 600;

function saveExpansion(storageKey: string | undefined, expanded: boolean): void {
  if (!storageKey) return;
  try {
    sessionStorage.setItem(storageKey, String(expanded));
  } catch {
    return;
  }
}

export function isLongMessage(content: string, renderedHeight = 0): boolean {
  if (renderedHeight > COLLAPSE_HEIGHT_THRESHOLD) return true;
  let lines = 1;
  for (let index = content.indexOf("\n"); index !== -1; index = content.indexOf("\n", index + 1)) {
    lines += 1;
    if (lines > COLLAPSE_LINE_THRESHOLD) return true;
  }
  return false;
}

/** 长消息默认折叠，只影响显示；存储、复制和分享导出仍使用全文 */
export function CollapsibleMessage({
  content,
  enabled = true,
  storageKey,
  expandOnLocate = false,
  forceExpanded = false,
  onToggle,
  children,
}: {
  content: string;
  enabled?: boolean;
  storageKey?: string;
  expandOnLocate?: boolean;
  forceExpanded?: boolean;
  /** 在展开/收起改变高度之前调用：消息列表据此暂停贴底，读者看到的位置不动 */
  onToggle?: () => void;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(() => {
    try {
      return storageKey ? sessionStorage.getItem(storageKey) === "true" : false;
    } catch {
      return false;
    }
  });
  const [renderedHeight, setRenderedHeight] = useState(0);
  const contentId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!expandOnLocate) return;
    setExpanded(true);
    saveExpansion(storageKey, true);
  }, [expandOnLocate, storageKey]);

  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!enabled || !node) return;
    const measure = () => setRenderedHeight(node.scrollHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [content, enabled]);

  if (!enabled) return <>{children}</>;
  const long = isLongMessage(content, renderedHeight);
  const collapsed = !expanded && !forceExpanded;

  function toggle() {
    const next = !expanded;
    onToggle?.();
    setExpanded(next);
    saveExpansion(storageKey, next);
    if (!next) {
      // 收起后消息顶部可能已在视口上方，滚回来以免读者丢失位置
      window.requestAnimationFrame(() => {
        const node = containerRef.current;
        if (node && node.getBoundingClientRect().top < 0) {
          node.scrollIntoView({ block: "start" });
        }
      });
    }
  }

  return (
    <div
      ref={containerRef}
      className={`message-collapsible ${long && collapsed ? "collapsed" : ""}`}
    >
      <div ref={contentRef} id={contentId} className="message-collapsible-content">
        {children}
      </div>
      {long && !forceExpanded && (
        <button
          type="button"
          className="message-expand"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
        >
          {expanded ? t("收起") : t("展开全文 · 共 {0} 字", { 0: content.length.toLocaleString() })}
        </button>
      )}
    </div>
  );
}
