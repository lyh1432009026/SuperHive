import { describe, expect, it } from "vitest";
import { docxZoom } from "./docx-view";
import { replaceSymbolBullets } from "./docx-render";
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
