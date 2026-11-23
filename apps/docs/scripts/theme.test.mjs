import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../src/styles/custom.css", import.meta.url), "utf8");
const landing = readFileSync(
  new URL("../src/components/home/landing.css", import.meta.url),
  "utf8",
);

function declarations(selector, source = styles) {
  const offset = source.indexOf(`${selector} {`);
  assert.notEqual(offset, -1, selector);
  return source.slice(offset, source.indexOf("}", offset));
}

test("documentation themes retain the project's neutral surfaces and blue accents", () => {
  const themes = [
    {
      selector: ":root",
      colors: {
        "--sl-color-bg": "#212121",
        "--sl-color-bg-sidebar": "#181818",
        "--sl-color-white": "#ececec",
        "--sl-color-accent": "#48aaff",
        "--docs-button-bg": "#ececec",
        "--docs-button-text": "#0d0d0d",
      },
    },
    {
      selector: ':root[data-theme="light"]',
      colors: {
        "--sl-color-bg": "#ffffff",
        "--sl-color-bg-sidebar": "#f9f9f9",
        "--sl-color-white": "#0d0d0d",
        "--sl-color-accent": "#0169cc",
        "--docs-button-bg": "#0d0d0d",
        "--docs-button-text": "#ffffff",
      },
    },
  ];
  for (const { selector, colors } of themes) {
    const theme = declarations(selector);
    for (const [property, color] of Object.entries(colors)) {
      assert.ok(theme.includes(`${property}: ${color};`), `${selector} ${property}`);
    }
  }
});

test("primary actions, navigation and keyboard focus use semantic theme colors", () => {
  const primary = declarations(".hl-btn-primary", landing);
  assert.ok(primary.includes("color: var(--hl-btn-text)"));
  assert.ok(primary.includes("background: var(--hl-btn-bg)"));
  assert.ok(declarations(":focus-visible").includes("var(--docs-focus-ring)"));
  assert.ok(
    declarations("#starlight__search input:focus").includes(
      "--pagefind-ui-border: var(--sl-color-gray-4)",
    ),
  );
  assert.ok(
    declarations('.sidebar-content a[aria-current="page"]').includes(
      "background-color: var(--sl-color-gray-5)",
    ),
  );
});

test("homepage keeps the brand blue in both themes and respects reduced motion", () => {
  const dark = declarations(":root:has(.hl)", landing);
  const light = declarations(':root[data-theme="light"]:has(.hl)', landing);
  assert.ok(dark.includes("--hl-c1: #48aaff;"));
  assert.ok(light.includes("--hl-c1: #0169cc;"));
  for (const theme of [dark, light]) {
    for (const token of ["--hl-bg", "--hl-text", "--hl-dim", "--hl-grad", "--hl-btn-bg"]) {
      assert.ok(theme.includes(`${token}:`), token);
    }
  }
  assert.match(landing, /@media \(prefers-reduced-motion: reduce\)/);
  // 首页样式只挂在首页的根节点下，不改动正文页
  assert.doesNotMatch(landing, /^(?:body|html|:root)\s*\{/m);
  assert.doesNotMatch(styles, /--sl-color-text-accent\s*:/);
});

test("branding and illustrations no longer contain the retired teal palette", () => {
  function illustrations(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = new URL(entry.name, directory);
      return entry.isDirectory()
        ? illustrations(new URL(`${entry.name}/`, directory))
        : entry.name.endsWith(".svg")
          ? [path]
          : [];
    });
  }
  const mark = new URL("../src/assets/hive-mark.svg", import.meta.url);
  const favicon = new URL("../public/favicon.svg", import.meta.url);
  const images = [
    mark,
    favicon,
    new URL("../src/assets/social-card.svg", import.meta.url),
    ...illustrations(new URL("../public/media/", import.meta.url)),
  ];
  for (const image of images) {
    assert.doesNotMatch(readFileSync(image, "utf8"), /#(?:087e86|132c3b|e9f3f6|214c50)/i);
  }
});

test("the docs default to dark until the reader picks a theme, then follow the reader", () => {
  const provider = readFileSync(
    new URL("../src/components/ThemeProvider.astro", import.meta.url),
    "utf8",
  );
  const config = readFileSync(new URL("../astro.config.mjs", import.meta.url), "utf8");
  assert.ok(config.includes('ThemeProvider: "./src/components/ThemeProvider.astro"'));
  // head 里同步执行，绘制前就定好主题；用户选过（含跟随系统）就不再强制深色
  assert.ok(provider.includes("<script is:inline>"));
  assert.ok(provider.includes('"superhive.docs.theme-chosen"'));
  assert.match(
    provider,
    /if \(!chosen\(\) && root\.dataset\.theme !== "dark"\) root\.dataset\.theme = "dark"/,
  );
  assert.doesNotMatch(provider, /isHome/);
});
