// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginShowcase } from "./login-showcase";

let observerCallback: IntersectionObserverCallback | undefined;

class FakeIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    observerCallback = callback;
  }
  observe() {}
  disconnect() {}
}

function setVisible(visible: boolean) {
  act(() =>
    observerCallback?.(
      [{ isIntersecting: visible } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
}

/** 每一拍的计时器在上一拍渲染后才挂上，所以分小步推进时间 */
function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 50) {
    act(() => vi.advanceTimersByTime(Math.min(50, ms - elapsed)));
  }
}

describe("LoginShowcase", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    observerCallback = undefined;
  });

  it("types the draft, then plays the room step by step while visible and loops", () => {
    const { container } = render(<LoginShowcase />);
    const messages = () => container.querySelectorAll(".showcase-message").length;
    expect(container.querySelector(".showcase")?.getAttribute("aria-hidden")).toBe("true");
    expect(messages()).toBe(0);

    // 不在视口里不播放
    advance(5_000);
    expect(container.querySelector(".showcase-caret")).toBeNull();

    setVisible(true);
    advance(600);
    expect(container.querySelector(".showcase-caret")).not.toBeNull();

    advance(6_000);
    expect(messages()).toBeGreaterThanOrEqual(1);
    expect(container.querySelector(".showcase-chip.running")).not.toBeNull();

    // 离开视口时停在当前这一拍
    setVisible(false);
    const paused = container.innerHTML;
    advance(20_000);
    expect(container.innerHTML).toBe(paused);

    setVisible(true);
    advance(11_000);
    expect(container.querySelector(".showcase-system")).not.toBeNull();
    expect(container.querySelector(".showcase-chip.done")).not.toBeNull();

    // 播完淡出后从头再来
    advance(4_500);
    expect(messages()).toBe(0);
  });

  it("shows the finished room without timers when motion is reduced", () => {
    const { container } = render(<LoginShowcase still />);
    setVisible(true);
    expect(container.querySelector(".showcase.static")).not.toBeNull();
    expect(container.querySelectorAll(".showcase-message")).toHaveLength(3);
    expect(container.querySelector(".showcase-option.picked")).not.toBeNull();
    const frame = container.innerHTML;
    advance(30_000);
    expect(container.innerHTML).toBe(frame);
  });
});
