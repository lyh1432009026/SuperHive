// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge, DesktopTitlebarAppearance } from "./desktop-bridge";
import { compositeColors, syncDesktopTitlebar, toHexColor } from "./desktop-titlebar";

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

describe("compositeColors", () => {
  it("stacks translucent layers over the base, top layer first", () => {
    // 50% 黑遮罩盖在白底上
    expect(compositeColors(["rgba(0, 0, 0, 0.5)"], "#ffffff")).toBe("#808080");
    // 两层遮罩叠加，下面不透明的那层挡住了底色
    expect(
      compositeColors(["rgb(0 0 0 / 0.5)", "rgb(255, 0, 0)", "rgb(0, 255, 0)"], "#ffffff"),
    ).toBe("#800000");
    // 透明层、认不出的值跳过
    expect(compositeColors(["rgba(0, 0, 0, 0)", "transparent"], "#212121")).toBe("#212121");
    expect(compositeColors(["rgb(0 0 0 / 40%)"], "#ffffff")).toBe("#999999");
    expect(compositeColors([], "nope")).toBeUndefined();
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

describe("syncDesktopTitlebar: dialogs dim the window buttons", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  const flush = async () => {
    await Promise.resolve();
    vi.advanceTimersByTime(20);
    await Promise.resolve();
  };

  it("Windows / Linux: paints the overlay with the scrim color while a modal is open", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "setTimeout", "clearTimeout"] });
    const root = document.documentElement;
    const { bridge, setAppearance } = bridgeWith("overlay");
    const readCorner = vi.fn(() => "#0d0d0d");
    const stop = syncDesktopTitlebar(bridge, root, () => dark, readCorner);
    expect(setAppearance).toHaveBeenLastCalledWith(dark);
    expect(readCorner).not.toHaveBeenCalled();

    // 消息流在后面刷新（没有弹窗）不去取色
    document.body.append(document.createElement("p"));
    await flush();
    expect(readCorner).not.toHaveBeenCalled();

    const layer = document.createElement("div");
    layer.setAttribute("role", "dialog");
    layer.setAttribute("aria-modal", "true");
    document.body.append(layer);
    await flush();
    expect(setAppearance).toHaveBeenLastCalledWith({ ...dark, scrim: "#0d0d0d" });
    // 遮罩淡入完再取一次
    vi.advanceTimersByTime(300);
    expect(readCorner).toHaveBeenCalledTimes(2);

    layer.remove();
    await flush();
    expect(setAppearance).toHaveBeenLastCalledWith(dark);
    stop();
  });

  it("skips the scrim when the corner color did not change, and never runs on macOS", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "setTimeout", "clearTimeout"] });
    const root = document.documentElement;
    const overlay = bridgeWith("overlay");
    const stopOverlay = syncDesktopTitlebar(
      overlay.bridge,
      root,
      () => dark,
      () => dark.color,
    );
    const mac = bridgeWith("mac");
    const readCorner = vi.fn(() => "#000000");
    const stopMac = syncDesktopTitlebar(mac.bridge, root, () => dark, readCorner);
    document.body.append(document.createElement("dialog"));
    document.querySelector("dialog")!.setAttribute("open", "");
    await flush();
    expect(overlay.setAppearance).toHaveBeenCalledTimes(1);
    expect(overlay.setAppearance).toHaveBeenLastCalledWith(dark);
    expect(readCorner).not.toHaveBeenCalled();
    stopOverlay();
    stopMac();
  });
});

describe("desktop-titlebar.css", () => {
  it("every overlay that touches the top of the window makes room for the window buttons", () => {
    const css = readFileSync(path.join(import.meta.dirname, "styles/desktop-titlebar.css"), "utf8");
    // 选择器 → 声明，用来查某个弹层有没有按安全区让位
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
      (match) => ({ selector: match[1]!.replace(/\s+/g, " "), body: match[2]! }),
    );
    const uses = (name: string, variable: string) =>
      rules.some((rule) => rule.selector.includes(name) && rule.body.includes(variable));
    // 窗口最上面那一行（顶栏 + 窗口按钮）始终露在外面：大面板、弹窗、面板都从它下面开始
    expect(uses(".attachment-lightbox-close", "--titlebar-safe-top")).toBe(true);
    // 铺满窗口的弹窗层、面板：从窗口按钮那一行下面开始排
    for (const name of [
      ".sheet-panel",
      ".room-dialog-layer",
      ".agent-dialog-layer",
      ".settings-dialog-layer",
      ".file-preview-backdrop",
      ".app-dialog-layer",
      ".invocation-details",
      ".onboarding-guide",
    ])
      expect(uses(name, "--titlebar-safe-top"), name).toBe(true);
  });

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
