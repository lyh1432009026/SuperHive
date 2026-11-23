// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge, DesktopTitlebarAppearance } from "./desktop-bridge";
import { syncDesktopTitlebar, toHexColor } from "./desktop-titlebar";

describe("toHexColor", () => {
  it("normalizes computed colors to #rrggbb", () => {
    expect(toHexColor("rgb(33, 33, 33)")).toBe("#212121");
    expect(toHexColor("rgba(255, 255, 255, 0.5)")).toBe("#ffffff");
    expect(toHexColor("rgb(180 180 180)")).toBe("#b4b4b4");
    expect(toHexColor("#ABC")).toBe("#aabbcc");
    expect(toHexColor("#5d5d5d")).toBe("#5d5d5d");
    expect(toHexColor("transparent")).toBeUndefined();
    expect(toHexColor("")).toBeUndefined();
  });
});

function bridgeWith(mode: "mac" | "overlay" | "native") {
  const setAppearance = vi.fn();
  return {
    setAppearance,
    bridge: {
      version: 1,
      platform: "win32",
      terminal: {} as DesktopBridge["terminal"],
      titlebar: { mode, setAppearance },
    } satisfies DesktopBridge,
  };
}

const dark: DesktopTitlebarAppearance = {
  height: 52,
  color: "#212121",
  symbolColor: "#b4b4b4",
  inactiveSymbolColor: "#8e8e8e",
};
const light: DesktopTitlebarAppearance = {
  height: 52,
  color: "#ffffff",
  symbolColor: "#5d5d5d",
  inactiveSymbolColor: "#8f8f8f",
};

describe("syncDesktopTitlebar", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.density;
  });

  it("does nothing in a browser or with the native frame", () => {
    const read = vi.fn(() => dark);
    expect(() => syncDesktopTitlebar(undefined, document.documentElement, read)()).not.toThrow();
    const { bridge, setAppearance } = bridgeWith("native");
    syncDesktopTitlebar(bridge, document.documentElement, read)();
    expect(read).not.toHaveBeenCalled();
    expect(setAppearance).not.toHaveBeenCalled();
  });

  it("pushes the appearance now and again whenever the theme or density changes", async () => {
    const root = document.documentElement;
    const read = vi.fn(() =>
      root.dataset.theme === "light"
        ? light
        : { ...dark, height: root.dataset.density === "compact" ? 46 : 52 },
    );
    const { bridge, setAppearance } = bridgeWith("overlay");
    const stop = syncDesktopTitlebar(bridge, root, read);
    expect(setAppearance).toHaveBeenLastCalledWith(dark);

    root.dataset.theme = "light";
    await Promise.resolve();
    expect(setAppearance).toHaveBeenLastCalledWith(light);

    root.dataset.theme = "dark";
    root.dataset.density = "compact";
    await Promise.resolve();
    expect(setAppearance).toHaveBeenLastCalledWith({ ...dark, height: 46 });

    // 外观没变（比如别的属性变了）不重复发
    const calls = setAppearance.mock.calls.length;
    root.dataset.theme = "dark";
    await Promise.resolve();
    expect(setAppearance).toHaveBeenCalledTimes(calls);

    stop();
    root.dataset.theme = "light";
    await Promise.resolve();
    expect(setAppearance).toHaveBeenCalledTimes(calls);
  });
});

describe("desktop-titlebar.css", () => {
  it("only applies inside the desktop app (every rule is scoped to :root[data-titlebar])", () => {
    const css = readFileSync(path.join(import.meta.dirname, "styles/desktop-titlebar.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@media[^{]*\{/g, "");
    const selectors = [...css.matchAll(/([^{}]+)\{/g)].map((match) => match[1]!.trim());
    expect(selectors.length).toBeGreaterThan(5);
    for (const selector of selectors) {
      for (const part of selector.split(/,(?![^(]*\))/)) {
        expect(part.trim()).toMatch(/^:root\[data-titlebar/);
      }
    }
  });
});
