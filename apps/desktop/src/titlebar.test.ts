import { describe, expect, it } from "vitest";
import {
  acceptAppearance,
  defaultAppearance,
  desktopPlatform,
  macButtonPosition,
  overlayOptions,
  parseAppearance,
  titlebarMode,
  titlebarWindowOptions,
} from "./titlebar.js";

const good = {
  height: 52,
  color: "#212121",
  symbolColor: "#B4B4B4",
  inactiveSymbolColor: "#6e6e6e",
};

describe("titlebarMode", () => {
  it("hides the system title bar on every desktop platform", () => {
    expect(titlebarMode("darwin")).toBe("mac");
    expect(titlebarMode("win32")).toBe("overlay");
    expect(titlebarMode("linux")).toBe("overlay");
    expect(titlebarMode("freebsd")).toBe("native");
  });

  it("falls back to the native frame when asked (window managers without overlay support)", () => {
    expect(titlebarMode("linux", { SUPERHIVE_DESKTOP_TITLEBAR: "native" })).toBe("native");
    expect(titlebarMode("darwin", { SUPERHIVE_DESKTOP_TITLEBAR: "native" })).toBe("native");
  });
});

describe("desktopPlatform", () => {
  it("maps node platforms to the html marker", () => {
    expect(desktopPlatform("darwin")).toBe("mac");
    expect(desktopPlatform("win32")).toBe("win");
    expect(desktopPlatform("linux")).toBe("linux");
    expect(desktopPlatform("aix")).toBe("other");
  });
});

describe("parseAppearance", () => {
  it("accepts #rrggbb colors and a sane height, normalized", () => {
    expect(parseAppearance({ ...good, height: 46.4 })).toEqual({
      height: 46,
      color: "#212121",
      symbolColor: "#b4b4b4",
      inactiveSymbolColor: "#6e6e6e",
    });
  });

  it.each([
    null,
    "x",
    { ...good, height: "52" },
    { ...good, height: Number.NaN },
    { ...good, height: 10 },
    { ...good, height: 500 },
    { ...good, color: "red" },
    { ...good, color: "#fff" },
    { ...good, symbolColor: "rgb(0,0,0)" },
    { ...good, inactiveSymbolColor: undefined },
  ])("rejects %j", (input) => {
    expect(parseAppearance(input)).toBeUndefined();
  });
});

describe("window options", () => {
  it("macOS: hidden title bar, traffic lights centered in the header row", () => {
    expect(macButtonPosition(52)).toEqual({ x: 18, y: 19 });
    expect(macButtonPosition(46)).toEqual({ x: 18, y: 16 });
    expect(titlebarWindowOptions("mac", defaultAppearance(true))).toEqual({
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 18, y: 19 },
    });
  });

  it("Windows / Linux: hidden title bar with a themed overlay keeping system buttons", () => {
    expect(titlebarWindowOptions("overlay", good)).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#212121", symbolColor: "#B4B4B4", height: 52 },
    });
  });

  it("native: leaves the frame alone", () => {
    expect(titlebarWindowOptions("native", good)).toEqual({});
  });

  it("dims the overlay symbols when the window loses focus", () => {
    expect(overlayOptions(good, true).symbolColor).toBe("#B4B4B4");
    expect(overlayOptions(good, false).symbolColor).toBe("#6e6e6e");
  });

  it("default appearance follows the system theme", () => {
    expect(defaultAppearance(true).color).toBe("#212121");
    expect(defaultAppearance(false).color).toBe("#ffffff");
  });
});

describe("acceptAppearance", () => {
  const origin = "http://127.0.0.1:8787";
  const allowed = { origin, webContentsIds: new Set([7]) };
  const event = (id = 7, url = `${origin}/#build`, parent: unknown = null) => ({
    sender: { id, isDestroyed: () => false },
    senderFrame: { url, parent },
  });

  it("applies appearance from the local Hive's top frame", () => {
    expect(acceptAppearance(event(), good, allowed)?.height).toBe(52);
  });

  it("ignores other windows, iframes, other origins and bad payloads", () => {
    expect(acceptAppearance(event(8), good, allowed)).toBeUndefined();
    expect(acceptAppearance(event(7, `${origin}/x`, {}), good, allowed)).toBeUndefined();
    expect(acceptAppearance(event(7, "http://192.168.1.2:8787/"), good, allowed)).toBeUndefined();
    expect(acceptAppearance(event(), { ...good, color: "javascript:" }, allowed)).toBeUndefined();
    expect(
      acceptAppearance(event(), good, { origin: undefined, webContentsIds: new Set([7]) }),
    ).toBeUndefined();
  });
});
