/**
 * 判断系统用的是常驻滚动条还是悬浮滚动条，写到 <html data-scrollbars="classic|overlay">。
 * 细滚动条样式（base.css）只在 classic 下生效：Windows、Linux 和 macOS 设成「始终显示」时换成细条，
 * macOS 默认的悬浮滚动条（不滚动时隐藏）保持系统原样，不被 ::-webkit-scrollbar 改成常显。
 */
export function detectScrollbarMode(doc: Document = document): "classic" | "overlay" {
  const probe = doc.createElement("div");
  probe.style.cssText =
    "position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;visibility:hidden";
  doc.body.appendChild(probe);
  const classic = probe.offsetWidth - probe.clientWidth > 0;
  probe.remove();
  return classic ? "classic" : "overlay";
}

export function applyScrollbarMode(doc: Document = document): void {
  if (!doc.body) return;
  doc.documentElement.dataset.scrollbars = detectScrollbarMode(doc);
}

applyScrollbarMode();
