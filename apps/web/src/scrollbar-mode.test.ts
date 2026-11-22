// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyScrollbarMode, detectScrollbarMode } from "./scrollbar-mode";

describe("scrollbar mode", () => {
  it("没有占宽度的滚动条时判为 overlay（macOS 悬浮滚动条），探测元素用完即删", () => {
    expect(detectScrollbarMode()).toBe("overlay");
    expect(document.body.children).toHaveLength(0);
  });

  it("滚动条占宽度时判为 classic，并写到 html 的 data-scrollbars 上", () => {
    const offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get: () => 100,
    });
    try {
      applyScrollbarMode();
      expect(document.documentElement.dataset.scrollbars).toBe("classic");
    } finally {
      if (offset) Object.defineProperty(HTMLElement.prototype, "offsetWidth", offset);
    }
  });
});
