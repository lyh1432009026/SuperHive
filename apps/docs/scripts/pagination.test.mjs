import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../src/styles/custom.css", import.meta.url), "utf8");

function declarations(selector) {
  const offset = styles.indexOf(`${selector} {`);
  assert.notEqual(offset, -1);
  return styles.slice(offset, styles.indexOf("}", offset));
}

test("pagination cards stay compact without constraining wrapped titles", () => {
  assert.ok(declarations(".pagination-links").includes("gap: 0.75rem"));
  const card = declarations(".pagination-links > a");
  for (const declaration of [
    "padding: 0.75rem 1rem",
    "font-size: var(--sl-text-sm)",
    "line-height: 1.5",
    "box-shadow: none",
  ]) {
    assert.ok(card.includes(declaration), declaration);
  }
  assert.doesNotMatch(card, /(?:^|[;{])\s*(?:height|max-height)\s*:/);
});

test("pagination titles and arrows use a smaller scale than Starlight defaults", () => {
  const title = declarations(".pagination-links .link-title");
  assert.ok(title.includes("font-size: var(--sl-text-base)"));
  assert.ok(title.includes("font-weight: 500"));
  assert.ok(title.includes("line-height: 1.5"));
  const arrow = declarations(".pagination-links svg");
  assert.ok(arrow.includes("width: 1.25rem"));
  assert.ok(arrow.includes("height: 1.25rem"));
});
