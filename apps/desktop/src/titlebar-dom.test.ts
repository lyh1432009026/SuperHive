import { describe, expect, it } from "vitest";
import {
  applyDesktopMarks,
  parseTitlebarArg,
  setFullscreenMark,
  TITLEBAR_ARG_PREFIX,
} from "./titlebar-dom.js";

const root = () => ({ dataset: {} as Record<string, string | undefined> });

describe("applyDesktopMarks", () => {
  it("marks macOS with the inset title bar", () => {
    const el = root();
    applyDesktopMarks(el, { platform: "darwin", mode: "mac" });
    expect(el.dataset).toEqual({ desktop: "mac", titlebar: "mac" });
  });

  it("marks Windows / Linux with the overlay title bar", () => {
    const win = root();
    applyDesktopMarks(win, { platform: "win32", mode: "overlay" });
    expect(win.dataset).toEqual({ desktop: "win", titlebar: "overlay" });
    const linux = root();
    applyDesktopMarks(linux, { platform: "linux", mode: "overlay", fullscreen: true });
    expect(linux.dataset).toEqual({ desktop: "linux", titlebar: "overlay", fullscreen: "" });
  });

  it("native frame: only the platform marker, no title bar styles", () => {
    const el = root();
    el.dataset.titlebar = "overlay";
    applyDesktopMarks(el, { platform: "linux", mode: "native" });
    expect(el.dataset).toEqual({ desktop: "linux" });
  });

  it("toggles the fullscreen marker", () => {
    const el = root();
    setFullscreenMark(el, true);
    expect(el.dataset.fullscreen).toBe("");
    setFullscreenMark(el, false);
    expect("fullscreen" in el.dataset).toBe(false);
  });
});

describe("parseTitlebarArg", () => {
  it("reads the mode from preload argv and defaults to native", () => {
    expect(parseTitlebarArg(["x", `${TITLEBAR_ARG_PREFIX}mac`])).toBe("mac");
    expect(parseTitlebarArg([`${TITLEBAR_ARG_PREFIX}overlay`])).toBe("overlay");
    expect(parseTitlebarArg([`${TITLEBAR_ARG_PREFIX}evil`])).toBe("native");
    expect(parseTitlebarArg([])).toBe("native");
  });
});
