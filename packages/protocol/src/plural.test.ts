import { expect, it } from "vitest";
import { isEnglishSingular } from "./index.js";

it("follows Intl.PluralRules for English", () => {
  expect(isEnglishSingular(1)).toBe(true);
  expect(isEnglishSingular("1")).toBe(true);
  for (const value of [0, 2, 1.5, "x", undefined]) expect(isEnglishSingular(value)).toBe(false);
});
