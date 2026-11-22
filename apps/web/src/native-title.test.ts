import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * 按钮这类可交互元素不用原生 title 做悬停提示，一律包 <Tooltip>（tooltip.tsx）：
 * 原生 title 不跟主题、出得慢、键盘聚焦和触屏都看不到，读屏也不一定念。
 *
 * 只查可交互元素（<button>、<a>、<select>、<input>、<textarea>、<summary> 和带交互 role 的元素）。
 * 不可交互元素上的 title 不拦：
 * - <iframe title> 是给读屏的框架名，无障碍规范要求写；
 * - 被截断文字（文件名、路径、分支名）上的 title 用来看全称，元素拿不到焦点，Tooltip 也帮不上键盘用户；
 * - 徽标、状态点、时间戳上的补充说明同理。
 * 组件自己的 title 属性（<SheetPanel title>、<EmptyState title>）是标题文字，不是原生 title，也不查。
 *
 * 可交互元素确实只能用原生 title 时，加进下面的 ALLOWED 并写清理由，键是「文件:title 的原文」。
 */
const ALLOWED: Record<string, string> = {};

const srcDir = import.meta.dirname;
const INTERACTIVE_TAGS = new Set(["button", "a", "select", "input", "textarea", "summary"]);
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "tab",
  "menuitem",
  "menuitemradio",
  "menuitemcheckbox",
  "option",
  "radio",
  "checkbox",
  "switch",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith(".tsx") && !name.endsWith(".test.tsx") ? [full] : [];
  });
}

function attribute(node: ts.JsxOpeningLikeElement, name: string) {
  return node.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

/** 一个文件里可交互元素上的原生 title */
function titlesIn(relative: string, text: string) {
  const found: { key: string; where: string }[] = [];
  const source = ts.createSourceFile(
    relative,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText();
      const title = attribute(node, "title");
      const role = attribute(node, "role")?.initializer;
      const interactive =
        INTERACTIVE_TAGS.has(tag) ||
        (role !== undefined && ts.isStringLiteral(role) && INTERACTIVE_ROLES.has(role.text));
      // 只有小写开头的是原生元素
      if (title && interactive && /^[a-z]/.test(tag)) {
        const line = source.getLineAndCharacterOfPosition(title.getStart()).line + 1;
        const value = title.initializer?.getText().replace(/\s+/g, " ") ?? "";
        found.push({ key: `${relative}:${value}`, where: `${relative}:${line} <${tag}>` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("native title", () => {
  const found = sourceFiles(srcDir).flatMap((file) =>
    titlesIn(path.relative(srcDir, file), readFileSync(file, "utf8")),
  );

  it("is not used on buttons and other interactive elements; wrap them in <Tooltip>", () => {
    const offending = found.filter((item) => !(item.key in ALLOWED)).map((item) => item.where);
    expect(offending, "去掉 title，改用 <Tooltip content=…>，按钮名字用 aria-label").toEqual([]);
  });

  it("has no stale or unexplained exemptions", () => {
    const used = new Set(found.map((item) => item.key));
    expect(Object.keys(ALLOWED).filter((key) => !used.has(key))).toEqual([]);
    expect(Object.entries(ALLOWED).filter(([, reason]) => !reason.trim())).toEqual([]);
  });

  it("catches titles on interactive elements only", () => {
    expect(sourceFiles(srcDir).length).toBeGreaterThan(50);
    const probe = titlesIn(
      "probe.tsx",
      `<>
        <button title="关闭" aria-label="关闭" />
        <div role="button" title={hint} />
        <select title="筛选" />
        <span title={name}>{name}</span>
        <iframe title="预览" />
        <SheetPanel title="产物" />
      </>`,
    );
    expect(probe.map((item) => item.where)).toEqual([
      "probe.tsx:2 <button>",
      "probe.tsx:3 <div>",
      "probe.tsx:4 <select>",
    ]);
  });
});
