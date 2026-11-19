import { describe, expect, it } from "vitest";
import {
  diffBlocks,
  diffStats,
  highlightHunks,
  highlightLines,
  languageFor,
  parsePatch,
  splitRows,
} from "./workspace-diff";

const patch = [
  "@@ -1,3 +1,3 @@ function main() {",
  " keep",
  "-old",
  "+new",
  " tail",
  "\\ No newline at end of file",
  "@@ -10,2 +10,3 @@",
  " ten",
  "+added",
  " eleven",
  "",
].join("\n");

describe("parsePatch", () => {
  it("按 hunk 解析出行号、增删与「末尾没有换行」", () => {
    const hunks = parsePatch(patch)!;
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 1, newStart: 1, header: "function main() {" });
    expect(hunks[0]!.lines).toEqual([
      { kind: "context", text: "keep", oldNumber: 1, newNumber: 1 },
      { kind: "del", text: "old", oldNumber: 2 },
      { kind: "add", text: "new", newNumber: 2 },
      { kind: "context", text: "tail", oldNumber: 3, newNumber: 3, noNewline: true },
    ]);
    expect(hunks[1]!.lines.map((line) => [line.kind, line.oldNumber, line.newNumber])).toEqual([
      ["context", 10, 10],
      ["add", undefined, 11],
      ["context", 11, 12],
    ]);
    expect(diffStats(hunks)).toEqual({ additions: 2, deletions: 1 });
  });

  it("合并冲突的组合格式按原文显示", () => {
    expect(parsePatch("@@@ -1,1 -1,1 +1,1 @@@\n- a\n")).toBeUndefined();
  });
});

describe("diffBlocks", () => {
  const long = parsePatch(
    [
      "@@ -1,20 +1,20 @@",
      ...Array.from({ length: 10 }, (_, index) => ` line${index + 1}`),
      "-line11",
      "+changed",
      ...Array.from({ length: 9 }, (_, index) => ` line${index + 12}`),
      "",
    ].join("\n"),
  )!;

  it("整份上下文时只在改动前后各留 3 行，其余折成可展开的一段", () => {
    const blocks = diffBlocks(long, new Set(), { showHunkHeaders: false });
    expect(blocks.map((block) => block.type)).toEqual(["gap", "lines", "gap"]);
    const [head, lines, tail] = blocks;
    expect(head).toMatchObject({ type: "gap", gap: { count: 7 } });
    expect(tail).toMatchObject({ type: "gap", gap: { count: 6 } });
    expect(lines?.type === "lines" && lines.lines.map((line) => line.text)).toEqual([
      "line8",
      "line9",
      "line10",
      "line11",
      "changed",
      "line12",
      "line13",
      "line14",
    ]);
  });

  it("展开一段或全部展开后不再折叠", () => {
    const first = diffBlocks(long, new Set(), { showHunkHeaders: false })[0]!;
    const id = first.type === "gap" ? first.gap.id : "";
    expect(
      diffBlocks(long, new Set([id]), { showHunkHeaders: false }).map((block) => block.type),
    ).toEqual(["lines", "gap"]);
    const all = diffBlocks(long, "all", { showHunkHeaders: false });
    expect(all).toHaveLength(1);
    expect(all[0]?.type === "lines" && all[0].lines).toHaveLength(21);
  });

  it("普通 3 行上下文的 diff 不折叠，可带 hunk 标题", () => {
    expect(
      diffBlocks(parsePatch(patch)!, new Set(), { showHunkHeaders: true }).map(
        (block) => block.type,
      ),
    ).toEqual(["hunk", "lines", "hunk", "lines"]);
  });
});

describe("splitRows", () => {
  it("连续的删除与新增按顺序配对，多出来的一边留空", () => {
    const [hunk] = parsePatch("@@ -1,3 +1,2 @@\n ctx\n-a\n-b\n+A\n")!;
    const rows = splitRows(hunk!.lines);
    expect(rows.map((row) => [row.left?.text, row.right?.text])).toEqual([
      ["ctx", "ctx"],
      ["a", "A"],
      ["b", undefined],
    ]);
  });
});

describe("语法高亮", () => {
  it("按扩展名和文件名选语言，认不出的不高亮", () => {
    expect(languageFor("src/App.tsx")).toBe("typescript");
    expect(languageFor("pkg/main.go")).toBe("go");
    expect(languageFor("Makefile")).toBe("makefile");
    expect(languageFor("config.toml")).toBe("ini");
    expect(languageFor("LICENSE")).toBeUndefined();
    expect(languageFor("weird.unknownext")).toBeUndefined();
  });

  it("整段高亮后按行拆开，跨行注释的每一行都带类名，行数不变", () => {
    const text = "/* one\ntwo */\nconst x = 1;";
    const lines = highlightLines(text, "javascript");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toEqual([{ text: "two */", className: "hljs-comment" }]);
    expect(lines[2]?.some((token) => token.className === "hljs-keyword")).toBe(true);
    expect(highlightLines("a\n\nb", undefined)).toEqual([[{ text: "a" }], [], [{ text: "b" }]]);
  });

  it("diff 的旧版本与新版本各自整段高亮再对回每一行", () => {
    const hunks = parsePatch("@@ -1,2 +1,2 @@\n /* start\n-old */\n+new */\n")!;
    const tokens = highlightHunks(hunks, "javascript");
    const [context, removed, added] = hunks[0]!.lines;
    expect(tokens.get(context!)?.[0]?.className).toBe("hljs-comment");
    expect(tokens.get(removed!)).toEqual([{ text: "old */", className: "hljs-comment" }]);
    expect(tokens.get(added!)).toEqual([{ text: "new */", className: "hljs-comment" }]);
  });
});
