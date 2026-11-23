// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOT_SPLASH_ID,
  BOOT_SPLASH_LEAVE_MS,
  resetAppReadyForTest,
  signalAppReady,
} from "./boot-splash";
import type { DesktopBridge } from "./desktop-bridge";

function mountSplash(): HTMLElement {
  const splash = document.createElement("div");
  splash.id = BOOT_SPLASH_ID;
  document.body.appendChild(splash);
  return splash;
}

function bridge(ready = vi.fn()): DesktopBridge {
  return { version: 1, platform: "darwin", terminal: {} as DesktopBridge["terminal"], ready };
}

describe("signalAppReady", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAppReadyForTest();
    delete document.documentElement.dataset.reduceMotion;
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("首屏画好后淡出再移除占位，并通知桌面端收起加载画面；只生效一次", async () => {
    const splash = mountSplash();
    const ready = vi.fn();
    signalAppReady(document, bridge(ready));
    // 等这一帧画出来再动手
    expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(splash.classList.contains("is-leaving")).toBe(true);
    expect(document.getElementById(BOOT_SPLASH_ID)).not.toBeNull();
    vi.advanceTimersByTime(BOOT_SPLASH_LEAVE_MS);
    expect(document.getElementById(BOOT_SPLASH_ID)).toBeNull();

    signalAppReady(document, bridge(ready));
    await vi.runAllTimersAsync();
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("减少动态效果时直接移除，不播退场动画", async () => {
    mountSplash();
    document.documentElement.dataset.reduceMotion = "true";
    signalAppReady(document, undefined);
    await vi.advanceTimersByTimeAsync(20);
    expect(document.getElementById(BOOT_SPLASH_ID)).toBeNull();
  });

  it("浏览器里没有桌面端接口、老版本桌面端没有 ready、页面上没有占位，都不出错", async () => {
    expect(() => signalAppReady(document, undefined)).not.toThrow();
    await vi.runAllTimersAsync();
    resetAppReadyForTest();
    const old = { ...bridge(), ready: undefined };
    signalAppReady(document, old);
    await vi.runAllTimersAsync();
    resetAppReadyForTest();
    const broken = bridge(
      vi.fn(() => {
        throw new Error("ipc gone");
      }),
    );
    const splash = mountSplash();
    signalAppReady(document, broken);
    await vi.runAllTimersAsync();
    expect(splash.isConnected).toBe(false);
  });
});

describe("index.html 首屏占位", () => {
  const html = readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

  it("纯 CSS + 内联 SVG，没有内联脚本（CSP 不放行），主题脚本是同源外部文件", () => {
    expect(html).toContain(`id="${BOOT_SPLASH_ID}"`);
    expect(html).toMatch(/<script src="\/boot-theme\.js"><\/script>/);
    // 除了这两个外部脚本，没有别的 <script>
    expect(html.match(/<script\b/g)).toHaveLength(2);
    expect(html).not.toMatch(/<script>[^<]/);
  });

  it("深浅色、减少动态效果、桌面端隐藏都有", () => {
    expect(html).toContain(':root[data-theme="dark"] #boot-splash');
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("prefers-reduced-motion: reduce");
    expect(html).toContain(":root[data-desktop] #boot-splash");
    expect(html).toContain("#boot-splash.is-leaving");
  });
});
