import { describe, expect, it } from "vitest";
import { highlightDraft } from "./draft-highlight";

const kinds = (value: string) =>
  highlightDraft(value)
    .filter((token) => token.kind)
    .map((token) => `${token.kind}:${token.text}`);

describe("输入框 Markdown 着色", () => {
  it("拼起来和原文一模一样（高亮层的字必须和输入框对齐）", () => {
    const value =
      "# 标题\n- **加粗** 和 `code` @rd-claude\n> 引用 [链接](http://x)\n```ts\nconst a = 1;\n```";
    expect(
      highlightDraft(value)
        .map((token) => token.text)
        .join(""),
    ).toBe(value);
  });

  it("标出标题、列表、加粗、行内代码、链接和 @", () => {
    expect(kinds("# 标题")).toEqual(["mark:# ", "heading:标题"]);
    expect(kinds("- **重点** 看 `pnpm test`")).toEqual([
      // 相邻的同类记号合成一段
      "mark:- **",
      "strong:重点",
      "mark:**",
      "mark:`",
      "code:pnpm test",
      "mark:`",
    ]);
    expect(kinds("见 [文档](http://a.b) @rd")).toEqual([
      "mark:[",
      "link:文档",
      "mark:](http://a.b)",
      "mention:@rd",
    ]);
  });

  it("代码里的东西不当成别的语法，也不当 @", () => {
    expect(kinds("`@rd **x**`")).toEqual(["mark:`", "code:@rd **x**", "mark:`"]);
    expect(kinds("```\n# 不是标题 @rd\n```")).toEqual([
      "fence:```",
      "code:\n# 不是标题 @rd\n",
      "fence:```",
    ]);
  });
});
