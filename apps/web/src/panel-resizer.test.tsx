// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PANEL_LIMITS, PanelResizer, usePanelWidths } from "./panel-resizer";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("panel widths", () => {
  it("never go below the design width, cap at the max, and persist", () => {
    Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true });
    const { result } = renderHook(() => usePanelWidths());
    expect(result.current.widths).toEqual({ rooms: 260, members: 320, preview: 560 });
    act(() => result.current.resize("rooms", 120));
    expect(result.current.widths.rooms).toBe(PANEL_LIMITS.rooms.min);
    act(() => result.current.resize("rooms", 999));
    expect(result.current.widths.rooms).toBe(PANEL_LIMITS.rooms.max);
    act(() => result.current.resize("members", 400));
    expect(localStorage.getItem(PANEL_LIMITS.members.key)).toBe("400");
    // 窗口窄时给对话区留出位置，但不会比默认宽度更窄
    Object.defineProperty(window, "innerWidth", { value: 1300, configurable: true });
    act(() => result.current.resize("members", 560));
    expect(result.current.widths.members).toBe(1300 - 480 - 420);
    Object.defineProperty(window, "innerWidth", { value: 1100, configurable: true });
    act(() => result.current.resize("members", 560));
    expect(result.current.widths.members).toBe(PANEL_LIMITS.members.min);
    // 停靠的预览栏默认更宽，同样给对话区和房间栏留位置
    Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true });
    act(() => result.current.resize("preview", 2000));
    expect(result.current.widths.preview).toBe(1600 - 480 - 420);
    expect(localStorage.getItem(PANEL_LIMITS.preview.key)).toBe(String(1600 - 480 - 420));
  });

  it("drags from the inner edge, double-click resets, arrows nudge", () => {
    const resized: Array<[string, number]> = [];
    render(
      <PanelResizer
        panel="members"
        width={360}
        onResize={(panel, w) => resized.push([panel, w])}
      />,
    );
    const handle = screen.getByRole("separator", { name: "调整成员栏宽度" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.doubleClick(handle);
    // 右侧栏往左是变宽
    expect(resized).toEqual([
      ["members", 376],
      ["members", 320],
    ]);
  });

  it("preview panel double-click resets to its own default width", () => {
    const resized: Array<[string, number]> = [];
    render(
      <div style={{ width: 500 }}>
        <PanelResizer
          panel="preview"
          width={900}
          onResize={(panel, w) => resized.push([panel, w])}
        />
      </div>,
    );
    const handle = screen.getByRole("separator", { name: "调整预览栏宽度" });
    fireEvent.doubleClick(handle);
    expect(resized).toEqual([["preview", PANEL_LIMITS.preview.default]]);
  });
});
