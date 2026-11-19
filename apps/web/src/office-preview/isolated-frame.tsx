import type { CSSProperties } from "react";
import { sanitizeCss } from "./sanitize";

/**
 * 文档内容的隔离容器：srcdoc + 空 sandbox（不给脚本、不给同源、不给表单和弹窗、不能导航顶层），
 * 再加一条只允许内联样式和 data: 图片 / 字体的 CSP。iframe 里的东西读不到本页面，
 * 也发不出任何网络请求；就算洗 HTML 漏了什么，也执行不了、连不出去。
 */
const FRAME_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'";

export function frameDocument(body: string, css = ""): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`,
    '<meta name="referrer" content="no-referrer">',
    `<style>${sanitizeCss(css).replace(/<\/style/gi, "<\\/style")}</style>`,
    `</head><body>${body}</body></html>`,
  ].join("");
}

export function IsolatedFrame({
  body,
  css,
  title,
  className,
  style,
  lazy = false,
}: {
  /** 已经洗过的 HTML */
  body: string;
  css?: string;
  title: string;
  className?: string;
  style?: CSSProperties;
  lazy?: boolean;
}) {
  return (
    <iframe
      className={className}
      style={style}
      title={title}
      sandbox=""
      referrerPolicy="no-referrer"
      loading={lazy ? "lazy" : undefined}
      srcDoc={frameDocument(body, css)}
    />
  );
}
