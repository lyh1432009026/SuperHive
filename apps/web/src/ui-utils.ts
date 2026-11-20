import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { flushSync } from "react-dom";

/**
 * 侧栏标签一行放不下时（窄面板、英文等较长的译文），未选中的标签只留图标和计数，文字仍供读屏与悬停提示；
 * 按实际宽度判断，不按语言写死，任何语言都不会折行。
 */
export function fitSideTabs(element: HTMLDivElement | null) {
  if (!element) return;
  const fit = () => {
    element.classList.remove("compact");
    if (element.scrollWidth > element.clientWidth + 1) element.classList.add("compact");
    // 选中标签底下的滑块：量出选中标签的位置和宽度，切换时由 CSS 过渡滑过去
    const active = element.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!active) return;
    element.style.setProperty("--tab-indicator-x", `${active.offsetLeft}px`);
    element.style.setProperty("--tab-indicator-width", `${active.offsetWidth}px`);
  };
  fit();
  // 第一次放好位置之后才开过渡，免得打开页面时滑块从左边滑进来
  requestAnimationFrame(() => element.classList.add("tab-indicator-ready"));
  if (typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return;
  const resize = new ResizeObserver(fit);
  resize.observe(element);
  // 切换标签、计数变化都会改变所需宽度
  const mutation = new MutationObserver((records) => {
    if (records.some((record) => record.target !== element)) fit();
  });
  mutation.observe(element, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "aria-selected"],
  });
  return () => {
    resize.disconnect();
    mutation.disconnect();
  };
}

/**
 * 展开 / 收起侧栏这类布局变化：支持 View Transitions 的浏览器里让侧栏滑入滑出、对话区平滑变宽变窄，
 * 不支持或开了「减少动态效果」时直接切换
 */
export function animateLayout(update: () => void) {
  const start = (
    document as Document & {
      startViewTransition?: (callback: () => void) => unknown;
    }
  ).startViewTransition;
  if (!start || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    update();
    return;
  }
  start.call(document, () => flushSync(update));
}

export function platformModifierLabel(): string {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "Cmd" : "Ctrl";
}

export function moveRadioSelection(
  event: ReactKeyboardEvent<HTMLElement>,
  checkedIndex: number,
  select: (index: number) => void,
): void {
  const delta =
    event.key === "ArrowDown" || event.key === "ArrowRight"
      ? 1
      : event.key === "ArrowUp" || event.key === "ArrowLeft"
        ? -1
        : 0;
  if (!delta) return;
  event.preventDefault();
  const radios = event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
  const next = (checkedIndex + delta + radios.length) % radios.length;
  select(next);
  radios[next]?.focus();
}
