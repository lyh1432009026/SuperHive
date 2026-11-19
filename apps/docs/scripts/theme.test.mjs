import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../src/styles/custom.css", import.meta.url), "utf8");

function declarations(selector) {
  const offset = styles.indexOf(`${selector} {`);
  assert.notEqual(offset, -1);
  return styles.slice(offset, styles.indexOf("}", offset));
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
  const primary = declarations(".workroom-primary");
  assert.ok(primary.includes("color: var(--docs-button-text)"));
  assert.ok(primary.includes("background: var(--docs-button-bg)"));
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

test("homepage accents use neutral theme colors without changing documentation links", () => {
  for (const selector of [".workroom-eyebrow", ".workroom-secondary", ".workroom-pathway-label"]) {
    assert.ok(declarations(selector).includes("color: var(--sl-color-gray-2)"), selector);
  }
  assert.ok(declarations(".workroom-pathway-label").includes("font-weight: 600"));
  assert.ok(declarations(".workroom-pathway-arrow").includes("color: var(--sl-color-gray-3)"));
  assert.ok(
    declarations(".workroom-pathway:hover").includes("border-color: var(--sl-color-gray-4)"),
  );
  assert.ok(declarations(".workroom-secondary:hover").includes("color: var(--sl-color-white)"));
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
