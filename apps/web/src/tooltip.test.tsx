// @vitest-environment jsdom

import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOLTIP_DELAY, Tooltip, tooltipPosition } from "./tooltip";

// jsdom 没有 PointerEvent，fireEvent 造出来的事件不带 pointerType
class TestPointerEvent extends MouseEvent {
  pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "";
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("PointerEvent", TestPointerEvent);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function hover(element: Element, pointerType = "mouse") {
  fireEvent.pointerOver(element, { pointerType });
}

function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("Tooltip", () => {
  it("shows after a short delay on mouse hover, hides on leave, and skips the delay for the next button", () => {
    render(
      <>
        <Tooltip content="分享对话">
          <button type="button" aria-label="分享">
            S
          </button>
        </Tooltip>
        <Tooltip content="产物">
          <button type="button" aria-label="产物">
            A
          </button>
        </Tooltip>
      </>,
    );
    const share = screen.getByRole("button", { name: "分享" });
    hover(share);
    expect(screen.queryByRole("tooltip")).toBeNull();
    wait(TOOLTIP_DELAY);
    expect(screen.getByRole("tooltip").textContent).toBe("分享对话");

    fireEvent.pointerOut(share, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    // 刚关掉一个提示，移到相邻按钮上不用再等
    hover(screen.getByRole("button", { name: "产物" }));
    expect(screen.getByRole("tooltip").textContent).toBe("产物");
  });

  it("never shows for touch, and hides on click or Esc", () => {
    render(
      <Tooltip content="新话题">
        <button type="button" aria-label="新话题">
          +
        </button>
      </Tooltip>,
    );
    const button = screen.getByRole("button");
    hover(button, "touch");
    wait(TOOLTIP_DELAY * 2);
    expect(screen.queryByRole("tooltip")).toBeNull();

    hover(button);
    wait(TOOLTIP_DELAY);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.pointerDown(button, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.pointerOut(button, { pointerType: "mouse" });
    wait(1000);
    hover(button);
    wait(TOOLTIP_DELAY);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows right away on keyboard focus and describes the button only when it adds something", () => {
    render(
      <>
        <Tooltip content="开启新话题：Agent 丢弃之前的会话" shortcut={["Mod", "K"]}>
          <button type="button" aria-label="新话题">
            +
          </button>
        </Tooltip>
        <Tooltip content="分享">
          <button type="button" aria-label="分享" aria-describedby="extra">
            S
          </button>
        </Tooltip>
      </>,
    );
    const topic = screen.getByRole("button", { name: "新话题" });
    // 说明一直在（隐藏），读屏聚焦时就能念到
    const description = document.getElementById(topic.getAttribute("aria-describedby")!)!;
    expect(description.hidden).toBe(true);
    expect(description.textContent).toMatch(/^开启新话题：Agent 丢弃之前的会话 \((⌘K|Ctrl\+K)\)$/);

    act(() => topic.focus());
    const bubble = screen.getByRole("tooltip");
    expect(bubble.textContent).toContain("开启新话题");
    expect(bubble.querySelectorAll("kbd")).toHaveLength(2);
    act(() => topic.blur());
    expect(screen.queryByRole("tooltip")).toBeNull();

    // 提示和名字一样：不重复描述，原有的 describedby 保留
    expect(screen.getByRole("button", { name: "分享" }).getAttribute("aria-describedby")).toBe(
      "extra",
    );
  });

  it("keeps the trigger's own handlers and renders nothing extra without content", () => {
    const onPointerDown = vi.fn();
    const onFocus = vi.fn();
    render(
      <Tooltip content={undefined}>
        <button type="button" aria-label="更多" onPointerDown={onPointerDown} onFocus={onFocus}>
          …
        </button>
      </Tooltip>,
    );
    const button = screen.getByRole("button");
    fireEvent.pointerDown(button);
    fireEvent.focus(button);
    expect(onPointerDown).toHaveBeenCalledOnce();
    expect(onFocus).toHaveBeenCalledOnce();
    expect(button.hasAttribute("aria-describedby")).toBe(false);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("skips the description when the visible text already says it", () => {
    render(
      <>
        <Tooltip content="report-final-v2.md">
          <button type="button">
            <span>report-final-v2.md</span>
            <small>12 KB</small>
          </button>
        </Tooltip>
        <Tooltip content="下载">
          <button type="button" aria-label="下载 report.md">
            ↓
          </button>
        </Tooltip>
        <Tooltip content="跳到这条任务">
          <button type="button">@helper · #general</button>
        </Tooltip>
      </>,
    );
    const [file, download, jump] = screen.getAllByRole("button");
    expect(file!.hasAttribute("aria-describedby")).toBe(false);
    expect(download!.hasAttribute("aria-describedby")).toBe(false);
    expect(document.getElementById(jump!.getAttribute("aria-describedby")!)?.textContent).toBe(
      "跳到这条任务",
    );
    // 悬停照样出提示
    hover(file!);
    wait(TOOLTIP_DELAY);
    expect(screen.getByRole("tooltip").textContent).toBe("report-final-v2.md");
  });

  it("shows one tooltip at a time, so a nested button replaces its row's", () => {
    render(
      <Tooltip content="正在处理 #5 · 点击跳过去">
        <div role="button" tabIndex={0}>
          helper
          <Tooltip content="设置">
            <button type="button" aria-label="helper 的设置">
              ⚙
            </button>
          </Tooltip>
        </div>
      </Tooltip>,
    );
    const row = document.querySelector<HTMLElement>("div[role=button]")!;
    hover(row);
    wait(TOOLTIP_DELAY);
    expect(screen.getByRole("tooltip").textContent).toBe("正在处理 #5 · 点击跳过去");
    hover(screen.getByRole("button", { name: "helper 的设置" }));
    wait(TOOLTIP_DELAY);
    expect(screen.getAllByRole("tooltip").map((tip) => tip.textContent)).toEqual(["设置"]);
  });

  it("keeps the trigger's own ref", () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <Tooltip content="关闭">
        <button ref={ref} type="button" aria-label="关闭">
          ×
        </button>
      </Tooltip>,
    );
    expect(ref.current).toBe(screen.getByRole("button"));
  });
});

describe("tooltipPosition", () => {
  const viewport = { width: 400, height: 300 };
  const size = { width: 120, height: 28 };

  it("centers below the anchor", () => {
    expect(tooltipPosition({ left: 100, right: 140, top: 10, bottom: 46 }, size, viewport)).toEqual(
      { left: 60, top: 52, side: "bottom" },
    );
  });

  it("stays inside the viewport near the edges", () => {
    expect(
      tooltipPosition({ left: 370, right: 396, top: 10, bottom: 46 }, size, viewport).left,
    ).toBe(272);
    expect(tooltipPosition({ left: 0, right: 20, top: 10, bottom: 46 }, size, viewport).left).toBe(
      8,
    );
  });

  it("flips above when there is no room below", () => {
    expect(
      tooltipPosition({ left: 100, right: 140, top: 270, bottom: 296 }, size, viewport),
    ).toEqual({ left: 60, top: 236, side: "top" });
  });
});
