import { describe, expect, it } from "vitest";
import { DEFAULT_SIZE, restoreBounds } from "./window-state.js";

const primary = { x: 0, y: 25, width: 1440, height: 875 };
const external = { x: 1440, y: 0, width: 2560, height: 1415 };

describe("restoreBounds", () => {
  it("uses the default size the first time", () => {
    expect(restoreBounds(undefined, [primary])).toEqual(DEFAULT_SIZE);
  });

  it("restores the saved position when it is still on screen", () => {
    expect(
      restoreBounds({ x: 1600, y: 100, width: 1200, height: 800 }, [primary, external]),
    ).toEqual({
      x: 1600,
      y: 100,
      width: 1200,
      height: 800,
    });
  });

  it("brings the window back when its display was unplugged", () => {
    expect(
      restoreBounds({ x: 1600, y: 100, width: 1200, height: 800, maximized: true }, [primary]),
    ).toEqual({
      x: 120,
      y: 63,
      width: 1200,
      height: 800,
      maximized: true,
    });
  });

  it("shrinks a window larger than the screen and enforces the minimum size", () => {
    expect(restoreBounds({ x: 0, y: 25, width: 3000, height: 2000 }, [primary])).toEqual({
      x: 0,
      y: 25,
      width: 1440,
      height: 875,
    });
    expect(restoreBounds({ x: 10, y: 30, width: 100, height: 100 }, [primary])).toMatchObject({
      width: 960,
      height: 640,
    });
  });
});
