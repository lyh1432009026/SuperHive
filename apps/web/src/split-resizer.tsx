import {
  useCallback,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/**
 * 面板里两栏之间的分隔条（「代码」面板左栏、「产物」面板筛选栏）：拖动调宽度、双击恢复默认、
 * 键盘聚焦后 ←/→ 每次 16px（Home/End 到最窄/最宽）；宽度记在本机。最宽不超过所在容器的一半。
 */

const STEP = 16;

export function useSplitWidth(key: string, defaultWidth: number, min: number) {
  const read = () => {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value >= min ? value : undefined;
  };
  const [stored, setStored] = useState(read);
  const set = useCallback(
    (width: number | undefined) => {
      if (width === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, String(Math.round(width)));
      setStored(width === undefined ? undefined : Math.round(width));
    },
    [key],
  );
  return { width: stored ?? defaultWidth, customized: stored !== undefined, set };
}

export function SplitResizer({
  width,
  min,
  onChange,
  label,
  className = "",
}: {
  width: number;
  min: number;
  /** undefined 表示恢复默认 */
  onChange: (width: number | undefined) => void;
  label: string;
  className?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const maxOf = (element: HTMLElement) => {
    const container = element.parentElement?.getBoundingClientRect().width ?? 0;
    return Math.max(min, Math.floor(container / 2));
  };
  const clamp = (value: number, max: number) => Math.round(Math.max(min, Math.min(max, value)));

  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = width;
    const max = maxOf(handle);
    setDragging(true);
    document.body.classList.add("resizing-panel");
    const move = (moveEvent: PointerEvent) =>
      onChange(clamp(startWidth + moveEvent.clientX - startX, max));
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

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const max = maxOf(event.currentTarget);
    const next =
      event.key === "ArrowLeft"
        ? width - STEP
        : event.key === "ArrowRight"
          ? width + STEP
          : event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onChange(clamp(next, max));
  };

  return (
    <div
      className={`split-resizer ${dragging ? "dragging" : ""} ${className}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuenow={width}
      tabIndex={0}
      title={label}
      style={{ left: width }}
      onPointerDown={start}
      onDoubleClick={() => onChange(undefined)}
      onKeyDown={onKeyDown}
    />
  );
}
