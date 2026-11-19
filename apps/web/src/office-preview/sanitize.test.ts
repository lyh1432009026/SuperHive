// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { frameDocument } from "./isolated-frame";
import { sanitizeCss, sanitizeDocumentHtml } from "./sanitize";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("sanitizeDocumentHtml", () => {
  it("去掉脚本、事件属性、嵌入对象、表单和音视频", () => {
    const html = sanitizeDocumentHtml(
      `<p onclick="x()">正文</p><script>alert(1)</script><iframe src="https://evil.test"></iframe>` +
        `<object data="x.swf"></object><form action="https://evil.test"><input></form>` +
        `<video src="blob:x"></video><img src="${PNG}" onerror="steal()">`,
    );
    expect(html).toContain("正文");
    expect(html).not.toMatch(/script|onclick|onerror|iframe|object|form|input|video/i);
    expect(html).toContain(`src="${PNG}"`);
  });

  it("图片只留 data:image，外部地址和相对地址都去掉", () => {
    const html = sanitizeDocumentHtml(
      `<img src="https://tracker.test/p.gif"><img src="logo.png"><img src="javascript:alert(1)">` +
        `<svg><image xlink:href="https://evil.test/a.png"></image></svg>`,
    );
    expect(html).not.toMatch(/tracker|logo\.png|javascript|evil/);
  });

  it("外链去掉 href 只剩文字，文档内锚点保留", () => {
    const html = sanitizeDocumentHtml(
      `<a href="https://example.com" target="_blank">外链</a><a href="#_Toc1">目录</a>`,
    );
    const root = document.createElement("div");
    root.innerHTML = html;
    const [outer, inner] = [...root.querySelectorAll("a")];
    expect(outer!.hasAttribute("href")).toBe(false);
    expect(outer!.getAttribute("aria-disabled")).toBe("true");
    expect(outer!.hasAttribute("target")).toBe(false);
    expect(outer!.textContent).toBe("外链");
    expect(inner!.getAttribute("href")).toBe("#_Toc1");
  });

  it("保留排版要用的 style 块、内联样式和 SVG 图形属性", () => {
    const html = sanitizeDocumentHtml(
      `<style>.docx{color:red}</style><section class="docx" style="width: 612pt"><svg width="100%" height="100%"><rect x="0" y="0" width="10px" fill="rgba(1,2,3,1)"></rect></svg></section>`,
    );
    expect(html).toContain("<style>.docx{color:red}</style>");
    expect(html).toContain('style="width: 612pt"');
    expect(html).toContain('<rect x="0" y="0" width="10px" fill="rgba(1,2,3,1)"></rect>');
  });

  it("CSS 里的外部 url() 和 @import 去掉，data: 字体与图片保留", () => {
    const html = sanitizeDocumentHtml(
      `<style>@import url("https://evil.test/x.css");@font-face{src:url(data:font/woff2;base64,AA)} .a{background:url('https://evil.test/b.png')}</style>` +
        `<p style="background-image: url(https://evil.test/c.png)">x</p>`,
    );
    expect(html).not.toContain("evil.test");
    expect(html).toContain("url(data:font/woff2;base64,AA)");
  });
});

describe("sanitizeCss / frameDocument", () => {
  it("只留 data: 地址", () => {
    expect(sanitizeCss("a{background:url(/local.png)}")).toBe("a{background:none}");
    expect(sanitizeCss("a{background:url(data:image/png;base64,AA)}")).toBe(
      "a{background:url(data:image/png;base64,AA)}",
    );
  });

  it("iframe 文档带只允许内联样式和 data: 资源的 CSP，样式里关不掉 style 标签", () => {
    const doc = frameDocument("<p>x</p>", "p{color:red}</style><script>alert(1)</script>");
    expect(doc).toContain(
      `content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'"`,
    );
    expect(doc).not.toContain("</style><script>");
    expect(doc).toContain("<body><p>x</p></body>");
  });
});
