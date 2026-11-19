import DOMPurify from "dompurify";

/**
 * 文档渲染库产出的 HTML 在放进隔离 iframe 之前再洗一遍：不留脚本、事件属性、表单、嵌入对象、
 * 音视频和任何外部地址。图片只认库从文件里解出来的 data:image；链接只留文档内的 #锚点，
 * 外链去掉 href 只剩文字（预览里不该从文档跳到别的网站）。CSS 里的 url() 只留 data:，@import 一律删。
 * iframe 自己还有 sandbox 和 CSP 兜底，这里是第一道。
 */

const FORBID_TAGS = [
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "link",
  "meta",
  "base",
  "video",
  "audio",
  "source",
  "track",
  "portal",
  "noscript",
  "template",
];

const FORBID_ATTR = [
  "srcset",
  "action",
  "formaction",
  "background",
  "poster",
  "ping",
  "target",
  "download",
  "lowsrc",
  "dynsrc",
];

/** 地址类属性只放行内嵌位图 / SVG 图片和文档内锚点 */
const URL_ATTRS = new Set([
  "src",
  "href",
  "xlink:href",
  "action",
  "data",
  "cite",
  "longdesc",
  "usemap",
]);
const ALLOWED_URL = /^(?:data:image\/(?:png|jpe?g|gif|webp|bmp|x-emf|x-wmf|svg\+xml|tiff?)[;,]|#)/i;

const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;

/** CSS 里的外部地址（url(http…)、@import）去掉；data: 的字体、背景图留着 */
export function sanitizeCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(CSS_URL, (match, _quote: string, value: string) =>
      /^data:(?:image|font|application\/(?:font|x-font|octet-stream))/i.test(value.trim())
        ? match
        : "none",
    )
    .replace(/expression\s*\(/gi, "(")
    .replace(/-moz-binding/gi, "");
}

let hooked = false;

function installHooks() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
    if (data.attrName === "style") data.attrValue = sanitizeCss(data.attrValue);
    else if (URL_ATTRS.has(data.attrName) && !ALLOWED_URL.test(data.attrValue.trim()))
      data.keepAttr = false;
  });
  DOMPurify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style" && node.textContent)
      node.textContent = sanitizeCss(node.textContent);
  });
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    // 去掉 href 的 <a> 照旧显示文字，但不像链接
    if (node.tagName === "A" && !node.hasAttribute("href"))
      node.setAttribute("aria-disabled", "true");
  });
}

export function sanitizeDocumentHtml(html: string): string {
  installHooks();
  return DOMPurify.sanitize(html, {
    FORCE_BODY: true,
    ADD_TAGS: ["style"],
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
}
