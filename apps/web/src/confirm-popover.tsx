import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "./button";

interface ConfirmPopoverProps {
  /** 读屏名称，说明在确认什么 */
  ariaLabel: string;
  /** 可选标题，比如风险确认的主旨句 */
  title?: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** 气泡指向的控件：点它不算「点外面」；收起时调用方负责把焦点还给它 */
  anchorRef: RefObject<HTMLElement | null>;
  /** 危险操作：标题和确认按钮用警示色 */
  danger?: boolean;
  busy?: boolean;
}

const GAP = 8;
const EDGE = 8;
const WIDTH = 320;

type Position = { left: number; top: number; arrowLeft: number; below: boolean };

/** 默认在锚点正上方居中；上方放不下才改到下方；左右贴着窗口边收进来，小箭头始终指着锚点 */
function place(anchor: HTMLElement, popover: HTMLElement): Position {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(WIDTH, window.innerWidth - EDGE * 2);
  const height = popover.offsetHeight;
  const center = rect.left + rect.width / 2;
  // 锚点比气泡窄（勾选框、小按钮）时箭头靠左对着它，气泡往右展开；锚点宽（整张选项卡）时居中
  const preferred = rect.width < width ? center - 22 : center - width / 2;
  const left = Math.max(EDGE, Math.min(preferred, window.innerWidth - width - EDGE));
  const below = rect.top - GAP - height < EDGE && window.innerHeight - rect.bottom > rect.top;
  return {
    left,
    top: below ? rect.bottom + GAP : rect.top - GAP - height,
    arrowLeft: Math.max(14, Math.min(center - left, width - 14)),
    below,
  };
}

/**
 * 通用的就地确认气泡：在触发它的控件上方弹一个轻量确认框（取消 / 确认），不占布局、不推动页面。
 * 渲染到 body（锚点在打开的 <dialog> 里时放进那个 dialog），按锚点位置定位，滚动、缩放时跟着走。
 * 打开时焦点落在「确认」上；Esc（不冒泡，不会顺带关掉外层弹窗）、点外面或点「取消」都算取消，
 * 由调用方收起并把焦点还给锚点。
 */
export function ConfirmPopover({
  ariaLabel,
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  anchorRef,
  danger = false,
  busy = false,
}: ConfirmPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<Position>();

  // 先按实际高度算好位置再显示，避免先出现在错误位置再跳过去
  useLayoutEffect(() => {
    const update = () => {
      if (anchorRef.current && popoverRef.current) {
        setPosition(place(anchorRef.current, popoverRef.current));
      }
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    confirmButtonRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (popoverRef.current?.contains(target) || anchorRef.current?.contains(target))) {
        return;
      }
      onCancel();
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [anchorRef, onCancel]);

  const portalTarget =
    (anchorRef.current?.closest("dialog[open]") as HTMLElement | null) ?? document.body;

  return createPortal(
    <div
      ref={popoverRef}
      className={`confirm-popover${position?.below ? " below" : ""}${danger ? " danger" : ""}`}
      role="dialog"
      aria-label={ariaLabel}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? "visible" : "hidden",
        ["--arrow-left" as string]: `${position?.arrowLeft ?? 0}px`,
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      {title ? <strong>{title}</strong> : null}
      <p>{message}</p>
      <div className="confirm-popover-actions dialog-actions">
        <Button size="sm" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          ref={confirmButtonRef}
          size="sm"
          variant={danger ? "danger" : "primary"}
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>,
    portalTarget,
  );
}
