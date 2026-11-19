import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  new URL("../src/components/ThemeSelect.astro", import.meta.url),
  "utf8",
);
const config = readFileSync(new URL("../astro.config.mjs", import.meta.url), "utf8");

test("the custom theme menu enhances Starlight without replacing its preference handling", () => {
  assert.ok(config.includes('ThemeSelect: "./src/components/ThemeSelect.astro"'));
  assert.ok(component.includes("<DefaultThemeSelect />"));
  assert.ok(component.includes('customElements.whenDefined("starlight-theme-select")'));
  assert.ok(component.includes('select.dispatchEvent(new Event("change", { bubbles: true }))'));
  assert.doesNotMatch(component, /localStorage|matchMedia/);
});

test("the menu exposes its current selection and keyboard controls", () => {
  for (const attribute of [
    'aria-haspopup="menu"',
    'aria-expanded="false"',
    'role="menuitemradio"',
  ]) {
    assert.ok(component.includes(attribute), attribute);
  }
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Escape"]) {
    assert.ok(component.includes(`"${key}"`), key);
  }
  assert.match(component, /this\.addEventListener\(\s*"focusout"/);
  assert.match(component, /document\.addEventListener\(\s*"pointerdown"/);
  assert.ok(component.includes("disconnectedCallback()"));
});

test("the menu uses existing theme tokens and opens upwards in the mobile footer", () => {
  assert.ok(component.includes("background: var(--sl-color-bg-nav)"));
  assert.ok(component.includes("outline: 2px solid var(--docs-focus-ring)"));
  assert.ok(component.includes(":global(.mobile-preferences) .theme-menu"));
  assert.ok(component.includes("inset-block-end: calc(100% + 0.5rem)"));
  assert.ok(component.includes("prefers-reduced-motion: reduce"));
});
