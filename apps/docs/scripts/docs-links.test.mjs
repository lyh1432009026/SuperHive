import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
// 网页和 CLI 用的文档地址表（Node 直接剥掉类型运行 .ts）
import { DOCS_BASE_URL, DOCS_LINKS } from "../../../packages/protocol/src/docs-links.ts";

// 和 Starlight 生成标题锚点用同一个 slugger（astro 的依赖）
const astroRequire = createRequire(createRequire(import.meta.url).resolve("astro/package.json"));
const { default: GithubSlugger } = await import(astroRequire.resolve("github-slugger"));

const contentRoot = new URL("../src/content/docs/", import.meta.url);

function pageSource(path, locale) {
  const prefix = locale === "en" ? "en/" : "";
  const stem = path === "" ? "index" : path.replace(/\/$/, "");
  for (const extension of [".md", ".mdx"]) {
    const file = new URL(`${prefix}${stem}${extension}`, contentRoot);
    if (existsSync(file)) return readFileSync(file, "utf8");
  }
  return undefined;
}

function headingIds(source) {
  const slugger = new GithubSlugger();
  const body = source.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^```[\s\S]*?^```/gm, "");
  return [...body.matchAll(/^#{1,6} +(.+?) *$/gm)].map((match) =>
    slugger.slug(match[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "")),
  );
}

test("web and CLI documentation links point at pages and headings that exist in both languages", () => {
  for (const [key, link] of Object.entries(DOCS_LINKS)) {
    for (const locale of ["zh-CN", "en"]) {
      const source = pageSource(link.path, locale);
      assert.ok(source, `${key} (${locale}): missing page ${link.path || "/"}`);
      if (link.anchor) {
        assert.ok(
          headingIds(source).includes(link.anchor[locale]),
          `${key} (${locale}): no heading with id ${link.anchor[locale]} in ${link.path}`,
        );
      }
    }
  }
});

test("documentation base URL matches the GitHub Pages deployment", () => {
  const workflow = readFileSync(
    new URL("../../../.github/workflows/docs.yml", import.meta.url),
    "utf8",
  );
  const site = workflow.match(/DOCS_SITE_URL: *(\S+)/)?.[1];
  const base = workflow.match(/DOCS_BASE_PATH: *(\S+)/)?.[1];
  assert.equal(DOCS_BASE_URL, `${site}${base}`);
});
