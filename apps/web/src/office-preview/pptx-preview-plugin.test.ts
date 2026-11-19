import fs from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { patchPptxPreview, pptxPreviewPatches } from "../../pptx-preview-plugin";

const source = fs.readFileSync(createRequire(import.meta.url).resolve("pptx-preview"), "utf8");

describe("pptx-preview 构建补丁", () => {
  it("装着的 1.0.7：文字改成 textContent，图表关动画、补颜色", () => {
    const patched = patchPptxPreview(source);
    expect(patched).not.toContain('s.innerHTML="string"==typeof c?c:""');
    expect(patched).toContain('s.textContent="string"==typeof c?c:""');
    expect(patched).toContain("t.setOption(__superhiveChartOption(i))");
    expect(patched.startsWith("function __superhiveChartOption(")).toBe(true);
    // 再跑一遍不变（开发时预构建和正式构建可能各过一次）
    expect(patchPptxPreview(patched)).toBe(patched);
  });

  it("注入的图表选项：空色换成 Office 默认色，关掉动画", () => {
    const helper = patchPptxPreview(source).split("\n")[0]!;
    const fix = new Function(`${helper}; return __superhiveChartOption;`)() as (
      option: Record<string, unknown>,
    ) => Record<string, unknown>;
    expect(
      fix({
        color: [undefined, "#123456", "none"],
        series: [{}, {}, {}],
        legend: { bottom: "bottom" },
      }),
    ).toEqual({
      color: ["#4472C4", "#123456", "#A5A5A5"],
      series: [{}, {}, {}],
      legend: { bottom: "bottom" },
      animation: false,
    });
  });

  it("库的代码变了就报错，不悄悄失效", () => {
    expect(() => patchPptxPreview("export const x = 1;")).toThrow(/pptx-preview 的代码变了/);
  });

  it("只处理 pptx-preview 的 ES 产物", () => {
    const plugin = pptxPreviewPatches();
    const transform = plugin.transform as (code: string, id: string) => unknown;
    expect(transform("let a", "/x/node_modules/other/index.js")).toBeUndefined();
    expect(
      transform(source, "/x/node_modules/pptx-preview/dist/pptx-preview.es.js?v=1"),
    ).toMatchObject({ code: expect.stringContaining("__superhiveChartOption") });
  });
});
