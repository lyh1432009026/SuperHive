import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import en from "./en.json";
import { LOCALE_OPTIONS, setLocalePreference, t } from "./index";

/**
 * 英文词表和界面文案对得上：
 * - 每个 t("…") 字面量都有译文；
 * - 常量表里的中文标签（渲染时经 t() 取译文，例如快捷键说明、执行步骤名称）也都有译文；
 * - 词表里没有已经不用的词条；
 * - 译文里不再夹中文，占位符 {0} 和原文一一对应。
 */

const srcDir = path.resolve(import.meta.dirname, "..");
const cjk = /[一-鿿]/;
/** 不给人看的中文字面量：拿来匹配服务端写的说明，或者只出现在注释性质的常量里 */
const notUiText = new Set(["上游模型服务出错"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

function collect() {
  const tKeys = new Map<string, string>();
  const literals = new Map<string, string>();
  for (const file of sourceFiles(srcDir)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const where = path.relative(srcDir, file);
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const parent = node.parent;
        const isT =
          ts.isCallExpression(parent) &&
          parent.arguments[0] === node &&
          ts.isIdentifier(parent.expression) &&
          parent.expression.text === "t";
        if (isT) tKeys.set(node.text, where);
        else if (cjk.test(node.text)) literals.set(node.text, where);
      }
      // JSX 里直接写中文会绕过 t()
      if (ts.isJsxText(node) && cjk.test(node.text)) literals.set(`JSX:${node.text.trim()}`, where);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { tKeys, literals };
}

const catalog = en as Record<string, string>;
const { tKeys, literals } = collect();

describe("English catalog", () => {
  it("translates every t() literal", () => {
    const missing = [...tKeys]
      .filter(([key]) => !(key in catalog))
      .map(([key, at]) => `${at}: ${key}`);
    expect(missing).toEqual([]);
  });

  it("translates Chinese labels kept in constant tables", () => {
    const missing = [...literals]
      .filter(([text]) => !(text in catalog) && !notUiText.has(text))
      .map(([text, at]) => `${at}: ${text}`);
    expect(missing).toEqual([]);
  });

  it("has no entries the UI no longer uses", () => {
    const unused = Object.keys(catalog).filter((key) => !tKeys.has(key) && !literals.has(key));
    expect(unused).toEqual([]);
  });

  it("contains no Chinese and keeps every placeholder", () => {
    const languageNames = new Set(LOCALE_OPTIONS.map((option) => option.label));
    const problems: string[] = [];
    for (const [key, value] of Object.entries(catalog)) {
      if (cjk.test(value) && !languageNames.has(value)) problems.push(`Chinese: ${key}`);
      // {0} 和复数写法 {0|one|other} 都算用到了参数 0
      const placeholders = (text: string) =>
        [
          ...new Set([...text.matchAll(/\{(\w+)(?:\|[^|{}]*\|[^|{}]*)?\}/g)].map((m) => m[1])),
        ].sort();
      if (placeholders(key).join() !== placeholders(value).join()) problems.push(`{n}: ${key}`);
    }
    expect(problems).toEqual([]);
  });
});

describe("plural placeholders", () => {
  it("picks the singular form only for 1", () => {
    setLocalePreference("en");
    try {
      expect(t("运行 {0} 条命令", { 0: 1 })).toBe("ran 1 command");
      expect(t("运行 {0} 条命令", { 0: 3 })).toBe("ran 3 commands");
      expect(t("运行 {0} 条命令", { 0: 0 })).toBe("ran 0 commands");
      expect(t("# {0}：{1} 个任务需要处理", { 0: "build", 1: 1 })).toBe(
        "# build: 1 task needs attention",
      );
    } finally {
      setLocalePreference("zh-CN");
    }
    expect(t("运行 {0} 条命令", { 0: 1 })).toBe("运行 1 条命令");
  });
});
