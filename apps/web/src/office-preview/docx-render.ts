import { parseAsync, renderDocument, type Options } from "docx-preview";
import { OfficePreviewError } from "./office-kind";
import { sanitizeDocumentHtml } from "./sanitize";

/**
 * Word：docx-preview 按页排版成 HTML（页眉页脚、脚注、表格、图片、字体都保留）。
 * 元素一律建在一份脱离页面的空文档里（options.h），图片地址设上去也不会去加载；
 * 排完版序列化、洗一遍，再交给隔离 iframe 显示。
 */
const OPTIONS: Partial<Options> = {
  className: "docx",
  inWrapper: true,
  breakPages: true,
  // 分页按文档里的分节符和分页符来，不用 Word 上次排版时留下的分页标记（换了字体后那些位置不准）
  ignoreLastRenderedPageBreak: true,
  ignoreWidth: false,
  ignoreHeight: false,
  ignoreFonts: false,
  // experimental 会按页面布局量制表位，要真实排版，空文档里量不了
  experimental: false,
  renderHeaders: true,
  renderFooters: true,
  renderFootnotes: true,
  renderEndnotes: true,
  renderChanges: false,
  renderComments: false,
  // altChunk 是文档里嵌的整页 HTML，库会给它建 iframe
  renderAltChunks: false,
  useBase64URL: true,
  debug: false,
};

type HElement = {
  ns?: string;
  tagName: string;
  className?: string;
  style?: string | Record<string, string>;
  children?: Array<HElement | Node | string>;
  [key: string]: unknown;
};

/** 和库自带的 h 一样，只是元素建在 owner 这份空文档里 */
function inertFactory(owner: Document) {
  const h = (elem: HElement | Node | string): Node => {
    if (typeof elem === "string") return owner.createTextNode(elem);
    // 库偶尔把自己建好的节点再传回来
    if (typeof (elem as Node).nodeType === "number") return elem as Node;
    const { ns, tagName, className, style, children, ...props } = elem as HElement;
    if (tagName === "#fragment") {
      const fragment = owner.createDocumentFragment();
      children?.forEach((child) => fragment.appendChild(h(child)));
      return fragment;
    }
    if (tagName === "#comment") return owner.createComment(String(children?.[0] ?? ""));
    const node = ns ? owner.createElementNS(ns, tagName) : owner.createElement(tagName);
    if (className) node.setAttribute("class", className);
    if (typeof style === "string") node.setAttribute("style", style);
    else if (style) Object.assign((node as HTMLElement).style, style);
    for (const [key, value] of Object.entries(props))
      if (value !== undefined) (node as unknown as Record<string, unknown>)[key] = value;
    children?.forEach((child) => node.appendChild(h(child)));
    return node;
  };
  return h;
}

/**
 * 项目符号常用 Symbol / Wingdings 字体里的私用区字符（U+F0xx），浏览器没有这些字体时显示成方框；
 * 换成长得一样的普通 Unicode 字符
 */
const SYMBOL_BULLETS: Record<string, string> = {
  "\uf0b7": "•",
  "\uf0a7": "▪",
  "\uf06c": "●",
  "\uf06e": "■",
  "\uf0a8": "◆",
  "\uf075": "◆",
  "\uf076": "❖",
  "\uf0d8": "➢",
  "\uf0e8": "➔",
  "\uf0fc": "✓",
  "\uf0fe": "☑",
  "\uf071": "❑",
};

export function replaceSymbolBullets(html: string): string {
  return html.replace(/[\uf06c-\uf0fe]/g, (char) => SYMBOL_BULLETS[char] ?? char);
}

export type RenderedDocx = { body: string; pageWidth: number; pages: number };

const PT_TO_PX = 96 / 72;

function lengthToPx(value: string): number | undefined {
  const match = /^([\d.]+)(pt|px|in|cm|mm)?$/.exec(value.trim());
  if (!match) return undefined;
  const number = Number(match[1]);
  switch (match[2]) {
    case "pt":
      return number * PT_TO_PX;
    case "in":
      return number * 96;
    case "cm":
      return (number * 96) / 2.54;
    case "mm":
      return (number * 96) / 25.4;
    default:
      return number;
  }
}

export async function renderDocx(bytes: Uint8Array): Promise<RenderedDocx> {
  const owner = document.implementation.createHTMLDocument("");
  let nodes: Node[];
  try {
    const parsed: unknown = await parseAsync(bytes.slice().buffer, OPTIONS);
    nodes = await renderDocument(parsed, {
      ...OPTIONS,
      h: inertFactory(owner) as Options["h"],
    });
  } catch (cause) {
    throw new OfficePreviewError("failed", cause instanceof Error ? cause.message : String(cause));
  }
  const root = owner.createElement("div");
  for (const node of nodes) root.appendChild(node);
  const sections = root.querySelectorAll<HTMLElement>("section.docx");
  if (sections.length === 0) throw new OfficePreviewError("failed", "empty document");
  const widths = [...sections]
    .map((section) => lengthToPx(section.style.width))
    .filter((value): value is number => value !== undefined && value > 0);
  return {
    body: sanitizeDocumentHtml(replaceSymbolBullets(root.innerHTML)),
    pageWidth: widths.length > 0 ? Math.max(...widths) : 816,
    pages: sections.length,
  };
}
