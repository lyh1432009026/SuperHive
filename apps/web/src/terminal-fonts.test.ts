// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CJK_FONT_FAMILY,
  CJK_UNICODE_RANGE,
  cjkSizeAdjust,
  prepareCjkFont,
  terminalFontFamily,
} from "./terminal-fonts";

function families(stack: string): string[] {
  return stack.split(", ").map((name) => name.replace(/^"|"$/g, ""));
}

describe("terminalFontFamily", () => {
  it("puts the platform monospace fonts first, then scaled CJK, CJK fonts, emoji", () => {
    const mac = families(terminalFontFamily("darwin"));
    expect(mac.slice(0, 3)).toEqual(["ui-monospace", "SF Mono", "SFMono-Regular"]);
    expect(mac.indexOf(CJK_FONT_FAMILY)).toBeGreaterThan(mac.indexOf("Menlo"));
    expect(mac.indexOf("PingFang SC")).toBeGreaterThan(mac.indexOf(CJK_FONT_FAMILY));
    expect(mac.at(-1)).toBe("monospace");

    const win = families(terminalFontFamily("win32"));
    expect(win.slice(0, 3)).toEqual(["Cascadia Mono", "Cascadia Code", "Consolas"]);
    expect(win).toContain("Microsoft YaHei");
    expect(win).toContain("Segoe UI Emoji");

    const linux = families(terminalFontFamily("linux"));
    expect(linux).toContain("Noto Sans Mono CJK SC");
    expect(linux).toContain("Noto Color Emoji");
    // 其他类 Unix（freebsd 等）按 Linux 处理
    expect(terminalFontFamily("freebsd")).toBe(terminalFontFamily("linux"));
  });

  it("leaves out the scaled CJK face when it couldn't be registered", () => {
    expect(families(terminalFontFamily("darwin", false))).not.toContain(CJK_FONT_FAMILY);
  });

  it("quotes names with spaces but not CSS keywords", () => {
    const stack = terminalFontFamily("darwin");
    expect(stack).toContain('"SF Mono"');
    expect(stack).toContain("ui-monospace, ");
    expect(stack.endsWith(", monospace")).toBe(true);
  });
});

describe("cjkSizeAdjust", () => {
  it("scales CJK glyphs toward two cells, within 1x–1.12x", () => {
    // SF Mono / Menlo 13px：单元格约 7.8px，两格 15.6px
    expect(cjkSizeAdjust(7.83, 13)).toBeCloseTo(1.108, 2);
    // 单元格很宽时封顶，免得中文比英文大太多
    expect(cjkSizeAdjust(9, 13)).toBe(1.12);
    // Consolas 这类窄单元格不缩小
    expect(cjkSizeAdjust(6.6, 13)).toBe(1);
    expect(cjkSizeAdjust(0, 13)).toBe(1);
    expect(cjkSizeAdjust(Number.NaN, 13)).toBe(1);
  });
});

describe("CJK_UNICODE_RANGE", () => {
  it("covers CJK ideographs, kana and fullwidth punctuation but not ASCII", () => {
    expect(CJK_UNICODE_RANGE).toContain("U+4E00-9FFF");
    expect(CJK_UNICODE_RANGE).toContain("U+3000-30FF");
    expect(CJK_UNICODE_RANGE).toContain("U+FF00-FF60");
    expect(CJK_UNICODE_RANGE).not.toMatch(/U\+0{0,2}[0-7][0-9A-F]-/);
  });
});

describe("prepareCjkFont", () => {
  const fonts: string[] = [];
  beforeEach(() => {
    // jsdom 没有 canvas：假装量出 SF Mono 的单元格宽度（0.6em）
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      const context = {
        font: "",
        measureText: () => ({ width: Number.parseFloat(context.font) * 0.6 }),
      };
      return new Proxy(context, {
        set(target, key, value) {
          if (key === "font") fonts.push(value as string);
          return Reflect.set(target, key, value);
        },
      }) as unknown as CanvasRenderingContext2D;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns false when FontFace isn't available", async () => {
    vi.stubGlobal("FontFace", undefined);
    await expect(prepareCjkFont("darwin", 11)).resolves.toBe(false);
  });

  it("registers regular and bold faces with size-adjust and the CJK range", async () => {
    const created: { family: string; source: string; descriptors: Record<string, string> }[] = [];
    vi.stubGlobal(
      "FontFace",
      class {
        constructor(family: string, source: string, descriptors: Record<string, string>) {
          created.push({ family, source, descriptors });
        }
        load() {
          return Promise.resolve(this);
        }
      },
    );
    const add = vi.fn();
    Object.defineProperty(document, "fonts", { value: { add }, configurable: true });
    await expect(prepareCjkFont("darwin", 12)).resolves.toBe(true);
    expect(created.map((face) => face.descriptors.weight)).toEqual(["400", "700"]);
    expect(created[0]!.family).toBe(CJK_FONT_FAMILY);
    expect(created[0]!.source).toContain('local("PingFangSC-Regular")');
    expect(created[1]!.source).toContain('local("PingFangSC-Semibold")');
    expect(created[0]!.descriptors.unicodeRange).toBe(CJK_UNICODE_RANGE);
    // 按英文等宽字体（不含 CJK 字体）量的单元格宽度：0.6em × 2 × 0.92 ≈ 110.4%
    expect(fonts.at(-1)).toMatch(/^12px ui-monospace, "SF Mono"/);
    expect(fonts.at(-1)).not.toContain("PingFang");
    expect(created[0]!.descriptors.sizeAdjust).toBe("110.4%");
    expect(add).toHaveBeenCalledTimes(2);
    // 同一平台、字号只注册一次
    await prepareCjkFont("darwin", 12);
    expect(created).toHaveLength(2);
  });

  it("returns false when the system doesn't have the font", async () => {
    vi.stubGlobal(
      "FontFace",
      class {
        load() {
          return Promise.reject(new Error("not found"));
        }
      },
    );
    Object.defineProperty(document, "fonts", { value: { add: vi.fn() }, configurable: true });
    await expect(prepareCjkFont("linux", 12)).resolves.toBe(false);
  });
});
