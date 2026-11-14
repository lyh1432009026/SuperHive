import { useEffect, useRef, type ReactNode, type RefObject } from "react";

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
  /** 气泡锚定的元素：点它不算“点外面”；收起时调用方负责把焦点还给它 */
  anchorRef: RefObject<HTMLElement | null>;
  /** 弹在锚点上方（默认）还是下方 */
  placement?: "top" | "bottom";
  /** 与锚点左对齐（默认）还是右对齐 */
  align?: "start" | "end";
  busy?: boolean;
}

/**
 * 就地确认气泡：贴着触发它的控件弹一个轻量 dialog（取消 / 确认）。
 * 打开时焦点落在「确认」上；Esc（不冒泡，避免顺带关掉外层弹窗）、点气泡外面
 * 或点「取消」都算取消，由调用方收起并还原焦点。
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
  placement = "top",
  align = "start",
  busy = false,
}: ConfirmPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmButtonRef.current?.focus();
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
  return (
    <div
      ref={popoverRef}
      className={`confirm-popover${placement === "bottom" ? " below" : ""}${align === "end" ? " align-end" : ""}`}
      role="dialog"
      aria-label={ariaLabel}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      {title ? <strong>{title}</strong> : null}
      <p>{message}</p>
      <div className="confirm-popover-actions">
        <button type="button" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button
          type="button"
          ref={confirmButtonRef}
          className="primary"
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
