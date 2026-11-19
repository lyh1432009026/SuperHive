import { init } from "pptx-preview";
import { OfficePreviewError } from "./office-kind";
import { sanitizeDocumentHtml } from "./sanitize";

/**
 * PowerPoint：pptx-preview 把每页排成绝对定位的 HTML（图表用 ECharts 画成 SVG）。
 * 渲染要真实布局（图表按容器量尺寸），所以挂在屏幕外一个看不见的容器里排；排完逐页序列化、洗一遍，
 * 每页单独交给隔离 iframe 显示，然后拆掉容器。库里把文字当 HTML 写入的那一处，构建时改成了纯文本，
 * 图表的入场动画也关掉了（见 pptx-preview-plugin.ts）。
 */

/** 排版宽度：幻灯片按这个宽度排，显示时再整体缩放 */
export const SLIDE_RENDER_WIDTH = 960;

/** 库在 setTimeout(0) 里才画图表；有图表时稍等一下再序列化 */
const CHART_SETTLE_MS = 120;

export type RenderedSlide = { body: string; width: number; height: number };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** canvas 序列化后是空的，换成同样大小的图片 */
function freezeCanvases(root: HTMLElement) {
  for (const canvas of root.querySelectorAll("canvas")) {
    try {
      const image = document.createElement("img");
      image.src = canvas.toDataURL("image/png");
      image.setAttribute("style", canvas.getAttribute("style") ?? "");
      image.width = canvas.width;
      image.height = canvas.height;
      canvas.replaceWith(image);
    } catch {
      canvas.remove();
    }
  }
}

export async function renderPptx(bytes: Uint8Array): Promise<RenderedSlide[]> {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${SLIDE_RENDER_WIDTH}px;visibility:hidden;pointer-events:none;contain:layout style`;
  document.body.appendChild(host);
  const previewer = init(host, { width: SLIDE_RENDER_WIDTH, mode: "list" });
  try {
    await previewer.preview(bytes.slice().buffer);
    const wrappers = [...host.querySelectorAll<HTMLElement>(".pptx-preview-slide-wrapper")];
    if (wrappers.length === 0) throw new OfficePreviewError("failed", "no slides");
    if (host.querySelector(".chart-node")) await wait(CHART_SETTLE_MS);
    return wrappers.map((wrapper) => {
      freezeCanvases(wrapper);
      wrapper.style.margin = "0";
      const width = parseFloat(wrapper.style.width) || SLIDE_RENDER_WIDTH;
      const height = parseFloat(wrapper.style.height) || (SLIDE_RENDER_WIDTH * 9) / 16;
      return { body: sanitizeDocumentHtml(wrapper.outerHTML), width, height };
    });
  } catch (cause) {
    if (cause instanceof OfficePreviewError) throw cause;
    throw new OfficePreviewError("failed", cause instanceof Error ? cause.message : String(cause));
  } finally {
    try {
      previewer.destroy();
    } catch {
      // 拆不掉也不影响已经拿到的结果
    }
    host.remove();
  }
}
