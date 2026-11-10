import { describe, expect, it } from "vitest";
import { imText, imTexts, parseImLocale, renderImMessage } from "./im-texts.js";

const CJK = /[㐀-鿿、-〿！（），：；？]/u;
/** 英文里故意留的中文：切到中文的按钮、告诉人可以填 zh（中文） */
const CHINESE_ON_PURPOSE = new Set(["im.button.otherLanguage", "im.lang.invalid"]);

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

describe("IM 文案目录", () => {
  it("每条都有中英文，两边占位符一致，英文里不夹中文", () => {
    for (const [key, entry] of Object.entries(imTexts)) {
      expect(entry.zh.trim(), key).not.toBe("");
      expect(entry.en.trim(), key).not.toBe("");
      expect(placeholders(entry.en), key).toEqual(placeholders(entry.zh));
      if (!CHINESE_ON_PURPOSE.has(key)) expect(entry.en, key).not.toMatch(CJK);
    }
  });

  it("按语言渲染，参数可以是另一句话", () => {
    expect(imText("en", "im.task.title", { agents: "codex" })).toBe("Sent to codex");
    expect(imText("zh-CN", "im.task.title", { agents: "codex" })).toBe("已派给 codex");
    const notice = {
      key: "im.audit.notice",
      params: {
        device: "iPhone",
        host: "mac",
        action: { key: "im.audit.roomCleared", params: { room: "build" } },
      },
    } as const;
    expect(renderImMessage("en", notice)).toContain('"iPhone" cleared the room build on mac');
    expect(renderImMessage("zh-CN", notice)).toContain("在 mac 上清空了房间 build");
  });

  it("认得中英文写法的语言名", () => {
    expect(parseImLocale("English")).toBe("en");
    expect(parseImLocale(" EN ")).toBe("en");
    expect(parseImLocale("中文")).toBe("zh-CN");
    expect(parseImLocale("zh")).toBe("zh-CN");
    expect(parseImLocale("fr")).toBeUndefined();
  });
});
