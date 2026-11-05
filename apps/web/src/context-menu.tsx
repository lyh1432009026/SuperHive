import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";

export type ContextMenuItem =
  | {
      label: string;
      onSelect: () => void;
      disabled?: boolean;
      danger?: boolean;
      /** 右侧的说明，比如快捷键 */
      hint?: string;
    }
  | "separator";

export type ContextMenuState = { x: number; y: number; title?: string; items: ContextMenuItem[] };

/**
 * 右键位置：鼠标右键用指针位置；键盘（菜单键、Shift+F10）触发时坐标是 0，改用元素左下角
 */
export function contextMenuPoint(event: MouseEvent<HTMLElement>): { x: number; y: number } {
  if (event.clientX !== 0 || event.clientY !== 0) return { x: event.clientX, y: event.clientY };
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.left + 12, y: rect.bottom };
}

/** 右键菜单：贴着指针弹出、不超出窗口；↑↓ 选择、Enter 执行、Esc 或点别处关闭 */
export function ContextMenu({ menu, onClose }: { menu: ContextMenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  const actions = menu.items.filter((item) => item !== "separator");
  const [active, setActive] = useState(() => actions.findIndex((item) => !item.disabled));

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(menu.x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(menu.y, window.innerHeight - height - 4)),
    });
    element.focus();
  }, [menu]);

  useEffect(() => {
    const close = (event: Event) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      onClose();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const run = (index: number) => {
    const item = actions[index];
    if (!item || item.disabled) return;
    onClose();
    item.onSelect();
  };
  const step = (direction: 1 | -1) => {
    if (!actions.some((item) => !item.disabled)) return;
    let next = active;
    do next = (next + direction + actions.length) % actions.length;
    while (actions[next]!.disabled);
    setActive(next);
  };

  let actionIndex = -1;
  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={menu.title}
      tabIndex={-1}
      style={position}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Tab") onClose();
        else if (event.key === "ArrowDown") step(1);
        else if (event.key === "ArrowUp") step(-1);
        else if (event.key === "Enter" || event.key === " ") run(active);
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {menu.title && <div className="context-menu-title">{menu.title}</div>}
      {menu.items.map((item, index) => {
        if (item === "separator") {
          return <div key={`s${index}`} className="context-menu-separator" role="separator" />;
        }
        actionIndex += 1;
        const current = actionIndex;
        return (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={`context-menu-item${item.danger ? " danger" : ""}${current === active ? " active" : ""}`}
            disabled={item.disabled}
            tabIndex={-1}
            onPointerEnter={() => !item.disabled && setActive(current)}
            onClick={() => run(current)}
          >
            <span>{item.label}</span>
            {item.hint && <small>{item.hint}</small>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
