import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { KeyCombo } from "./key-combo";
import { keyCombo } from "./shortcuts";

/** 鼠标停多久才出提示；刚关掉一个提示又移到相邻按钮上时立刻出，扫过一排按钮不用每个都等 */
export const TOOLTIP_DELAY = 450;
const TOOLTIP_SKIP_DELAY = 400;
/** 离视口边缘至少留这么多 */
const VIEWPORT_MARGIN = 8;
const GAP = 6;

let lastHiddenAt = -Infinity;
/** 同一时间只显示一个提示：嵌套的触发元素（比如成员行里的设置按钮）出提示时收起外层的 */
let hideActive: (() => void) | undefined;

type TriggerProps = {
  ref?: Ref<HTMLElement>;
  "aria-label"?: string;
  "aria-describedby"?: string;
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
};

/** 用键盘切过来的聚焦才出提示；鼠标点按钮带来的聚焦不出（不然点完按钮提示一直挂着） */
function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

/**
 * 悬停 / 键盘聚焦时的提示，替代原生 title：跟随明暗主题、有出现动画、不会出视口。
 * 包住一个元素（通常是只剩图标的按钮），把事件和 aria-describedby 挂到它身上：
 *
 *   <Tooltip content={t("分享对话")} shortcut={["Mod", "S"]}><button aria-label=…/></Tooltip>
 *
 * - 只响应鼠标悬停（pointerType 为 mouse），触屏点按不出；
 * - 名字靠元素自己的 aria-label；提示文字和它不同（或带快捷键）时，用 aria-describedby 指向一份隐藏的说明补充；
 * - Esc、点击、滚动、窗口失焦都会收起。
 */
export function Tooltip({
  content,
  shortcut,
  children,
}: {
  content: ReactNode;
  /** 快捷键，按 SHORTCUTS 的写法，例如 ["Mod", "K"] */
  shortcut?: string[];
  children: ReactElement<TriggerProps>;
}) {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLElement>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const props = children.props;
  const triggerRef = useRef<HTMLElement | null>(null);
  const childRef = props.ref;
  const ref = useCallback(
    (node: HTMLElement | null) => {
      triggerRef.current = node;
      if (typeof childRef === "function") childRef(node);
      else if (childRef) childRef.current = node;
    },
    [childRef],
  );
  // 提示只是把名字里已有的文字再写一遍（比如被截断的文件名）时不挂说明，读屏不会念两遍
  const [repeatsName, setRepeatsName] = useState(false);
  useLayoutEffect(() => {
    const element = triggerRef.current;
    const text = typeof content === "string" ? content.trim() : "";
    const name = element?.getAttribute("aria-label") || element?.textContent || "";
    setRepeatsName(Boolean(text) && name.replace(/\s+/g, " ").includes(text));
  });

  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setAnchor((current) => {
      if (current) lastHiddenAt = performance.now();
      return undefined;
    });
  }, []);

  const show = (element: HTMLElement, immediate: boolean) => {
    clearTimeout(timer.current);
    if (immediate || performance.now() - lastHiddenAt < TOOLTIP_SKIP_DELAY) {
      setAnchor(element);
      return;
    }
    timer.current = setTimeout(() => setAnchor(element), TOOLTIP_DELAY);
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (!anchor) return;
    if (hideActive !== hide) hideActive?.();
    hideActive = hide;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
      window.removeEventListener("keydown", onKey, true);
      if (hideActive === hide) hideActive = undefined;
    };
  }, [anchor, hide]);

  if (content === undefined || content === null || content === "") return children;

  // 提示文字就是元素的名字时不再挂 describedby，读屏不会念两遍。说明一直留在 DOM 里（隐藏），
  // 读屏聚焦时就能念到，不用等气泡出来
  const describes = Boolean(shortcut?.length) || (content !== props["aria-label"] && !repeatsName);
  const describedBy = describes ? id : undefined;

  const trigger = cloneElement(children, {
    ref,
    "aria-describedby":
      [props["aria-describedby"], describedBy].filter(Boolean).join(" ") || undefined,
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      props.onPointerEnter?.(event);
      if (event.pointerType === "mouse") show(event.currentTarget, false);
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      props.onPointerLeave?.(event);
      hide();
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      props.onPointerDown?.(event);
      hide();
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      props.onFocus?.(event);
      if (focusVisible(event.currentTarget)) show(event.currentTarget, true);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      props.onBlur?.(event);
      hide();
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      props.onKeyDown?.(event);
      // 回车、空格触发按钮后提示就没用了，会挡住刚打开的东西
      if (event.key === "Enter" || event.key === " ") hide();
    },
  });

  return (
    <>
      {trigger}
      {describes && (
        <span id={id} className="tooltip-description" hidden>
          {content}
          {shortcut?.length ? ` (${keyCombo(shortcut)})` : null}
        </span>
      )}
      {anchor && (
        <TooltipBubble anchor={anchor} shortcut={shortcut}>
          {content}
        </TooltipBubble>
      )}
    </>
  );
}

/** 默认出在元素下方、水平居中；下方放不下翻到上方，左右贴边时往里收 */
export function tooltipPosition(
  anchor: { left: number; right: number; top: number; bottom: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number; side: "top" | "bottom" } {
  const center = (anchor.left + anchor.right) / 2;
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(center - size.width / 2, viewport.width - size.width - VIEWPORT_MARGIN),
  );
  const below = anchor.bottom + GAP;
  if (below + size.height <= viewport.height - VIEWPORT_MARGIN || anchor.top < size.height + GAP) {
    return { left, top: below, side: "bottom" };
  }
  return { left, top: anchor.top - GAP - size.height, side: "top" };
}

function TooltipBubble({
  anchor,
  shortcut,
  children,
}: {
  anchor: HTMLElement;
  shortcut?: string[];
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<ReturnType<typeof tooltipPosition>>();

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setPlacement(
      tooltipPosition(
        anchor.getBoundingClientRect(),
        { width, height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className="tooltip"
      data-side={placement?.side}
      style={
        placement
          ? { left: placement.left, top: placement.top }
          : { left: 0, top: 0, visibility: "hidden" }
      }
    >
      <span className="tooltip-text">{children}</span>
      {shortcut?.length ? <KeyCombo keys={shortcut} className="tooltip-keys" /> : null}
    </div>,
    document.body,
  );
}
