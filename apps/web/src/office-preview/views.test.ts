// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { docxZoom } from "./docx-view";
import { applyDefaultPageMargins, replaceSymbolBullets } from "./docx-render";
import { slideScale } from "./pptx-view";
import { visibleWindow } from "./sheet-view";

describe("缩放与虚拟滚动", () => {
  it("Symbol / Wingdings 私用区的项目符号换成普通字符", () => {
    expect(replaceSymbolBullets("\uf0b7 一\uf0a7 二\uf0fc 三")).toBe("• 一▪ 二✓ 三");
  });

  it("纸张只缩不放，按 5% 一档", () => {
    expect(docxZoom(2000, 800, 24)).toBe(1);
    expect(docxZoom(400, 800, 24)).toBe(0.45);
    expect(docxZoom(10, 800, 24)).toBe(0.2);
  });

  it("幻灯片按更紧的一边缩放", () => {
    expect(slideScale({ width: 480, height: 1000 }, { width: 960, height: 540 })).toBe(0.5);
    expect(slideScale({ width: 2000, height: 270 }, { width: 960, height: 540 })).toBe(0.5);
  });

  it("只渲染视口附近的行；被合并单元格盖住的行从合并起点开始", () => {
    const offsets = Array.from({ length: 1001 }, (_, index) => index * 24);
    const mergeTop = Array.from({ length: 1000 }, (_, index) => index);
    const [start, end] = visibleWindow(offsets, mergeTop, 24 * 500, 240);
    expect(start).toBeGreaterThan(450);
    expect(end).toBeLessThan(560);
    mergeTop[start] = start - 30;
    expect(visibleWindow(offsets, mergeTop, 24 * 500, 240)[0]).toBe(start - 30);
    expect(visibleWindow([0], [], 0, 100)).toEqual([0, 0]);
  });
});

describe("applyDefaultPageMargins", () => {
  const page = (style: string) => {
    const root = document.createElement("div");
    root.innerHTML = `<section class="docx" style="${style}"><article><p>正文</p></article></section>`;
    return { root, section: root.querySelector<HTMLElement>("section")! };
  };

  it("gives a page without pgMar the Word default margins so text does not touch the edge", () => {
    const { root, section } = page("width: 595.25pt; min-height: 842pt");
    applyDefaultPageMargins(root);
    expect([
      section.style.paddingTop,
      section.style.paddingRight,
      section.style.paddingBottom,
      section.style.paddingLeft,
    ]).toEqual(["2.54cm", "3.17cm", "2.54cm", "3.17cm"]);
  });

  it("keeps margins the document declares, including an explicit zero", () => {
    const declared = page("padding: 72pt 54pt");
    applyDefaultPageMargins(declared.root);
    expect(declared.section.style.paddingLeft).toBe("54pt");
    const zero = page("padding: 0pt");
    applyDefaultPageMargins(zero.root);
    expect(zero.section.style.paddingTop).toBe("0pt");
  });
});
