import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { t } from "./i18n";

/** 侧栏默认宽度就是最小宽度：只能拖宽，不能比设计宽度更窄 */
export const PANEL_LIMITS = {
  rooms: { min: 260, max: 480, key: "superhive.rooms-width" },
  members: { min: 320, max: 560, key: "superhive.members-width" },
  // 停靠在对话旁边的文件预览：默认宽一些，Word、表格才看得清
  preview: { min: 360, max: 1600, default: 560, key: "superhive.preview-width" },
} as const;

export type ResizablePanel = keyof typeof PANEL_LIMITS;

/** 对话区至少留这么宽：两侧都拖到很宽时，以对话区为准再收回 */
const CHAT_MIN_WIDTH = 420;

function clampWidth(panel: ResizablePanel, width: number, other: number): number {
  const { min, max } = PANEL_LIMITS[panel];
  const room = window.innerWidth - other - CHAT_MIN_WIDTH;
  return Math.round(Math.max(min, Math.min(max, room, width)));
}

function defaultWidth(panel: ResizablePanel): number {
  const limits = PANEL_LIMITS[panel];
  return "default" in limits ? limits.default : limits.min;
}

function storedWidth(panel: ResizablePanel): number {
  const value = Number(localStorage.getItem(PANEL_LIMITS[panel].key));
  return Number.isFinite(value) && value > 0 ? value : defaultWidth(panel);
}

/** 两侧栏和预览栏宽度：记在本机，下次打开沿用 */
export function usePanelWidths() {
  const [widths, setWidths] = useState(() => ({
    rooms: storedWidth("rooms"),
    members: storedWidth("members"),
    preview: storedWidth("preview"),
  }));
  const resize = useCallback((panel: ResizablePanel, width: number) => {
    setWidths((current) => {
      // 预览栏只给房间栏留出位置；成员栏常被收起，实际放不下时由布局（grid）再收窄
      const other = panel === "rooms" ? current.members : current.rooms;
      const next = clampWidth(panel, width, other);
      return next === current[panel] ? current : { ...current, [panel]: next };
    });
  }, []);
  useEffect(() => {
    localStorage.setItem(PANEL_LIMITS.rooms.key, String(widths.rooms));
    localStorage.setItem(PANEL_LIMITS.members.key, String(widths.members));
    localStorage.setItem(PANEL_LIMITS.preview.key, String(widths.preview));
  }, [widths]);
  return { widths, resize };
}

/**
 * 侧栏边缘的拖拽手柄：按住左右拖改宽度，双击恢复默认；键盘聚焦后 ←/→ 每次 16px。
 * 左侧栏手柄在右边缘，右侧栏和预览栏手柄在左边缘
 */
export function PanelResizer({
  panel,
  width,
  onResize,
}: {
  panel: ResizablePanel;
  width: number;
  onResize: (panel: ResizablePanel, width: number) => void;
}) {
  const { min, max } = PANEL_LIMITS[panel];
  // 右侧栏往左拖是变宽
  const direction = panel === "rooms" ? 1 : -1;
  const [dragging, setDragging] = useState(false);
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    // 预览栏可能被布局压得比记下的宽度窄，从看到的宽度开始拖，手感才对得上
    const shown = panel === "preview" ? handle.parentElement?.getBoundingClientRect().width : 0;
    const startWidth = shown ? Math.round(shown) : width;
    setDragging(true);
    document.body.classList.add("resizing-panel");
    const move = (moveEvent: PointerEvent) =>
      onResize(panel, startWidth + (moveEvent.clientX - startX) * direction);
    const end = () => {
      setDragging(false);
      document.body.classList.remove("resizing-panel");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  return (
    <div
      className={`panel-resizer ${panel}${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={
        panel === "rooms"
          ? t("调整房间栏宽度")
          : panel === "members"
            ? t("调整成员栏宽度")
            : t("调整预览栏宽度")
      }
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={t("拖动调整宽度，双击恢复默认")}
      onPointerDown={start}
      onDoubleClick={() => onResize(panel, defaultWidth(panel))}
      onKeyDown={(event) => {
        const step = { ArrowRight: 16, ArrowLeft: -16 }[event.key];
        if (step === undefined) return;
        event.preventDefault();
        onResize(panel, width + step * direction);
      }}
    />
  );
}
