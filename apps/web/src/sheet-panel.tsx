import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { t } from "./i18n";
import { Tooltip } from "./tooltip";

/**
 * 从聊天头部打开的大面板外壳（「代码」「产物」「任务目录」共用）：
 * - 默认从右侧滑出、铺满整个窗口；点「还原为侧边面板」、拖动或双击左边缘变成可拖宽的侧边抽屉；
 * - 铺满还是抽屉、抽屉宽度都记在本机，每个面板用自己的键名；
 * - Esc 关闭（里面的弹层、搜索框先处理 Esc 时会 preventDefault，这里就不关）；窄屏一律全屏。
 * 关闭后焦点回到哪里由调用方在 onClose 里决定（通常是头部的入口按钮）。
 */

const MIN_WIDTH = 560;

function readWidth(key: string): number {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value >= MIN_WIDTH
    ? value
    : Math.max(MIN_WIDTH, Math.min(1120, Math.round(window.innerWidth * 0.68)));
}

function clampWidth(width: number): number {
  return Math.round(Math.max(MIN_WIDTH, Math.min(width, window.innerWidth - 80)));
}

export type SheetPanelProps = {
  /** 本机记忆的键名前缀：`${storageKey}-width`、`${storageKey}-maximized` */
  storageKey: string;
  className?: string;
  /** 标题前的图标 */
  icon: ReactNode;
  title: string;
  /** 标题后的灰色说明（工作区名等），窄时省略 */
  subtitle?: ReactNode;
  /** 标题和右侧按钮之间（来源选择等） */
  headerExtra?: ReactNode;
  /** 右侧「铺满 / 还原」「关闭」之前的按钮（刷新等） */
  actions?: ReactNode;
  closeLabel: string;
  onClose: () => void;
  panelRef?: RefObject<HTMLElement | null>;
  /** 本机没记过时是否铺满；内容是一列清单的面板默认用侧边抽屉 */
  defaultMaximized?: boolean;
  children: ReactNode;
};

export function SheetPanel({
  storageKey,
  className,
  icon,
  title,
  subtitle,
  headerExtra,
  actions,
  closeLabel,
  onClose,
  panelRef: externalRef,
  defaultMaximized = true,
  children,
}: SheetPanelProps) {
  const ownRef = useRef<HTMLElement>(null);
  const panelRef = externalRef ?? ownRef;
  const widthKey = `${storageKey}-width`;
  const maximizedKey = `${storageKey}-maximized`;
  const titleId = `${storageKey.replace(/[^a-z0-9-]/gi, "-")}-title`;
  const [width, setWidth] = useState(() => readWidth(widthKey));
  const [maximized, setMaximized] = useState(() => {
    const stored = localStorage.getItem(maximizedKey);
    return stored === null ? defaultMaximized : stored !== "false";
  });

  useEffect(() => {
    localStorage.setItem(maximizedKey, String(maximized));
  }, [maximized, maximizedKey]);
  useEffect(() => {
    localStorage.setItem(widthKey, String(width));
  }, [width, widthKey]);
  useEffect(() => {
    panelRef.current?.focus();
  }, [panelRef]);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    // 全屏时拖边缘：从当前实际宽度开始变成抽屉
    const startWidth = maximized
      ? (panelRef.current?.getBoundingClientRect().width ?? window.innerWidth)
      : width;
    if (maximized) setMaximized(false);
    document.body.classList.add("resizing-panel");
    const move = (moveEvent: PointerEvent) =>
      setWidth(clampWidth(startWidth - (moveEvent.clientX - startX)));
    const end = () => {
      document.body.classList.remove("resizing-panel");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    // 面板里有元素全屏（幻灯片放映）时，Esc 交给浏览器退出全屏
    if (event.key === "Escape" && !event.defaultPrevented && !document.fullscreenElement) {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <aside
      ref={panelRef}
      className={`sheet-panel${maximized ? " maximized" : ""}${className ? ` ${className}` : ""}`}
      style={maximized ? undefined : { width }}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div
        className="sheet-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("拖动调整面板宽度")}
        aria-valuemin={MIN_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={startResize}
        onDoubleClick={() => setMaximized((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          setMaximized(false);
          setWidth((current) => clampWidth(current + (event.key === "ArrowLeft" ? 32 : -32)));
        }}
      />
      <header className="sheet-header">
        <div className="sheet-title">
          {icon}
          <h2 id={titleId}>{title}</h2>
          {subtitle ? <span className="sheet-subtitle">{subtitle}</span> : null}
        </div>
        {headerExtra}
        <div className="sheet-header-actions">
          {actions}
          <Tooltip content={maximized ? t("还原为侧边面板") : t("占满整个窗口")}>
            <button
              type="button"
              className="sheet-icon-button"
              aria-label={maximized ? t("还原为侧边面板") : t("占满整个窗口")}
              aria-pressed={maximized}
              onClick={() => setMaximized((current) => !current)}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                {maximized ? (
                  <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
                ) : (
                  <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
                )}
              </svg>
            </button>
          </Tooltip>
          <Tooltip content={t("关闭")}>
            <button
              type="button"
              className="sheet-icon-button"
              aria-label={closeLabel}
              onClick={onClose}
            >
              <svg
                width="16"
                height="16"
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
          </Tooltip>
        </div>
      </header>
      {children}
    </aside>
  );
}
