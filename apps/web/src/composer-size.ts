/**
 * 输入框随内容长高：平时最多约窗口高度的 40%（至少 176px），展开后最多约 70%；
 * 超出才出现滚动条。
 */
export function composerMaxHeight(expanded: boolean): number {
  const viewport = typeof window === "undefined" ? 800 : window.innerHeight;
  return Math.round(Math.max(176, viewport * (expanded ? 0.7 : 0.4)));
}

/** 展开后直接变高（约半屏），不用等写满才看得出变化 */
export function composerMinHeight(expanded: boolean): number {
  if (!expanded) return 54;
  const viewport = typeof window === "undefined" ? 800 : window.innerHeight;
  return Math.round(Math.max(176, viewport * 0.5));
}

export function resizeComposer(textarea: HTMLTextAreaElement, expanded = false): void {
  const max = composerMaxHeight(expanded);
  textarea.style.maxHeight = `${max}px`;
  textarea.style.height = "0px";
  const nextHeight = Math.min(max, Math.max(composerMinHeight(expanded), textarea.scrollHeight));
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > max ? "auto" : "hidden";
}

/** 纯文本输入框背后的高亮层与输入框排版一致：在它里面找到第 offset 个字符，量出它在屏幕上的横坐标 */
export function highlightOffsetX(layer: HTMLElement | null, offset: number): number | undefined {
  if (!layer) return undefined;
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.setEnd(node, Math.min(remaining + 1, length));
      // jsdom 等环境没有排版信息，量不到就让面板照旧靠左
      if (typeof range.getBoundingClientRect !== "function") return undefined;
      const rect = range.getBoundingClientRect();
      return rect.width || rect.left ? rect.left : undefined;
    }
    remaining -= length;
  }
  return undefined;
}
