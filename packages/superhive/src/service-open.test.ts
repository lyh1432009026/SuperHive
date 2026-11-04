import { describe, expect, it } from "vitest";
import { openBrowser } from "./service.js";

describe("openBrowser", () => {
  it("stays quiet without a desktop or when the user opted out", () => {
    const url = "http://127.0.0.1:8787";
    expect(openBrowser(url, { CI: "1" })).toBe(false);
    expect(openBrowser(url, { BROWSER: "none" })).toBe(false);
    expect(openBrowser(url, { HIVE_NO_OPEN: "1" })).toBe(false);
    if (process.platform === "linux") expect(openBrowser(url, {})).toBe(false);
  });
});
