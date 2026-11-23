// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  clampTerminalHeight,
  clampTerminalWidth,
  DEFAULT_TERMINAL_LAYOUT,
  effectivePosition,
  fitsRight,
  LEGACY_TERMINAL_HEIGHT_KEY,
  loadTerminalLayout,
  saveTerminalLayout,
  TERMINAL_LAYOUT_KEY,
} from "./terminal-layout";

afterEach(() => localStorage.clear());

describe("terminal layout preferences", () => {
  it("defaults to a bottom dock and round-trips through localStorage", () => {
    expect(loadTerminalLayout()).toEqual(DEFAULT_TERMINAL_LAYOUT);
    saveTerminalLayout({ position: "right", maximized: true, height: 300, width: 640 });
    expect(loadTerminalLayout()).toEqual({
      position: "right",
      maximized: true,
      height: 300,
      width: 640,
    });
  });

  it("keeps the height saved by older versions and ignores broken data", () => {
    localStorage.setItem(LEGACY_TERMINAL_HEIGHT_KEY, "360");
    expect(loadTerminalLayout().height).toBe(360);
    localStorage.setItem(TERMINAL_LAYOUT_KEY, "{not json");
    expect(loadTerminalLayout()).toMatchObject({ position: "bottom", height: 360 });
    localStorage.setItem(
      TERMINAL_LAYOUT_KEY,
      JSON.stringify({ position: "left", maximized: "yes", height: 20, width: -1 }),
    );
    expect(loadTerminalLayout()).toEqual({ ...DEFAULT_TERMINAL_LAYOUT, height: 280 });
  });
});

describe("terminal layout limits", () => {
  it("only docks on the right when the chat keeps at least 360px", () => {
    expect(fitsRight(680)).toBe(true);
    expect(fitsRight(679)).toBe(false);
    expect(effectivePosition("right", 1200)).toBe("right");
    expect(effectivePosition("right", 600)).toBe("bottom");
    expect(effectivePosition("bottom", 1200)).toBe("bottom");
    // 还没量到尺寸时照偏好
    expect(effectivePosition("right", 0)).toBe("right");
  });

  it("clamps height and width between the minimum and what leaves the chat usable", () => {
    expect(clampTerminalHeight(50, 800)).toBe(140);
    expect(clampTerminalHeight(400.4, 800)).toBe(400);
    expect(clampTerminalHeight(2000, 800)).toBe(620);
    // 对话区本身很矮时守住下限
    expect(clampTerminalHeight(2000, 200)).toBe(140);
    expect(clampTerminalHeight(2000, 0)).toBe(2000);
    expect(clampTerminalWidth(100, 1400)).toBe(320);
    expect(clampTerminalWidth(3000, 1400)).toBe(1040);
    expect(clampTerminalWidth(3000, 500)).toBe(320);
  });
});
