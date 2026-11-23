// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge, DesktopTerminalExit } from "./desktop-bridge";

// jsdom 没有 PointerEvent：用 MouseEvent 顶上，拖动分隔条时才有 clientX / clientY
if (typeof window.PointerEvent === "undefined") {
  class PointerEventShim extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  window.PointerEvent = PointerEventShim as unknown as typeof PointerEvent;
}

// jsdom 没有 canvas / 布局，xterm 换成记录调用的假实现
const terminals: FakeTerminal[] = [];
class FakeTerminal {
  cols = 80;
  rows = 24;
  element: HTMLElement | undefined;
  written: string[] = [];
  options: Record<string, unknown>;
  disposed = false;
  addons: unknown[] = [];
  unicode = { activeVersion: "6" };
  private dataListener: ((data: string) => void) | undefined;
  constructor(options: Record<string, unknown>) {
    this.options = options;
    terminals.push(this);
  }
  loadAddon(addon: unknown) {
    this.addons.push(addon);
  }
  open(host: HTMLElement) {
    this.element = host;
  }
  write(data: string) {
    this.written.push(data);
  }
  focus() {}
  onData(listener: (data: string) => void) {
    this.dataListener = listener;
    return { dispose() {} };
  }
  onResize() {
    return { dispose() {} };
  }
  type(data: string) {
    this.dataListener?.(data);
  }
  keyHandler: ((event: KeyboardEvent) => boolean) | undefined;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this.keyHandler = handler;
  }
  dispose() {
    this.disposed = true;
  }
}
vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
class FakeUnicode11 {}
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: FakeUnicode11 }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const { TerminalPanel } = await import("./terminal-panel");
const { terminalFontFamily } = await import("./terminal-fonts");
const { useDesktopTerminal, TerminalDock } = await import("./terminal-dock");
const { DEFAULT_TERMINAL_LAYOUT, TERMINAL_LAYOUT_KEY, TERMINAL_OPEN_KEY, TERMINAL_ACTIVE_KEY } =
  await import("./terminal-layout");
type Layout = import("./terminal-layout").TerminalLayout;

/** 面板必填的布局参数：默认底部 */
function layoutProps(layout: Partial<Layout> = {}) {
  return {
    layout: { ...DEFAULT_TERMINAL_LAYOUT, ...layout },
    onTogglePosition: vi.fn(),
    onToggleMaximized: vi.fn(),
    onResize: vi.fn(),
  };
}

/** jsdom 没有布局：给面板的父元素（对话区）一个假尺寸 */
function sizedContainer(width: number, height: number) {
  const container = document.createElement("div");
  Object.defineProperty(container, "clientWidth", { value: width });
  Object.defineProperty(container, "clientHeight", { value: height });
  document.body.appendChild(container);
  return container;
}

function fakeBridge() {
  let dataListener: ((id: string, data: string) => void) | undefined;
  let exitListener: ((event: DesktopTerminalExit) => void) | undefined;
  let newListener: (() => void) | undefined;
  let next = 0;
  const bridge = {
    version: 1,
    platform: "darwin",
    terminal: {
      create: vi.fn(async (request: { cwd?: string | null }) => {
        next += 1;
        const id = `t${next}`;
        // 输出可能比 create 的结果先到
        dataListener?.(id, `hello from ${id}\r\n`);
        return { id, shell: "/bin/zsh", cwd: request.cwd ?? "/Users/me" };
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn((listener: (id: string, data: string) => void) => {
        dataListener = listener;
        return () => (dataListener = undefined);
      }),
      onExit: vi.fn((listener: (event: DesktopTerminalExit) => void) => {
        exitListener = listener;
        return () => (exitListener = undefined);
      }),
      onNewRequest: vi.fn((listener: () => void) => {
        newListener = listener;
        return () => (newListener = undefined);
      }),
    },
  } satisfies DesktopBridge;
  return {
    bridge,
    emitData: (id: string, data: string) => dataListener?.(id, data),
    emitExit: (event: DesktopTerminalExit) => exitListener?.(event),
    requestNew: () => newListener?.(),
  };
}

afterEach(() => {
  cleanup();
  terminals.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = "";
});

/** 页面刷新后的桌面端：还留着两个终端，带回放 */
function reloadedBridge() {
  const base = fakeBridge();
  const sessions = [
    { id: "old1", shell: "/bin/zsh", cwd: "/repo/a", replay: "$ npm run dev\r\nready\r\n" },
    { id: "old2", shell: "/bin/bash", cwd: "/repo/b", replay: "$ htop\r\n" },
  ];
  const bridge = {
    ...base.bridge,
    terminal: {
      ...base.bridge.terminal,
      list: vi.fn(async () => sessions.map(({ id, shell, cwd }) => ({ id, shell, cwd }))),
      attach: vi.fn(async (id: string) => sessions.find((item) => item.id === id) ?? null),
      onLayoutRequest: vi.fn((listener: (action: "maximize" | "position") => void) => {
        layoutListener = listener;
        return () => (layoutListener = undefined);
      }),
    },
  } satisfies DesktopBridge;
  let layoutListener: ((action: "maximize" | "position") => void) | undefined;
  return {
    ...base,
    bridge,
    requestLayout: (action: "maximize" | "position") => layoutListener?.(action),
  };
}

describe("TerminalPanel", () => {
  it("opens a terminal in the room workspace and pipes input and output", async () => {
    const { bridge, emitData } = fakeBridge();
    render(
      <TerminalPanel
        {...layoutProps()}
        bridge={bridge}
        cwd="/repo/room"
        open
        newRequest={0}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(bridge.terminal.create).toHaveBeenCalledTimes(1));
    expect(bridge.terminal.create.mock.calls[0]![0]).toMatchObject({ cwd: "/repo/room" });
    await screen.findByRole("tab", { name: /zsh/ });
    const terminal = terminals[0]!;
    // 先到的输出不会丢
    expect(terminal.written.join("")).toContain("hello from t1");
    act(() => emitData("t1", "more"));
    expect(terminal.written.at(-1)).toBe("more");
    terminal.type("ls\r");
    expect(bridge.terminal.write).toHaveBeenCalledWith("t1", "ls\r");
  });

  it("uses the platform font stack and Unicode 11 widths for CJK and emoji", async () => {
    const { bridge } = fakeBridge();
    render(
      <TerminalPanel
        {...layoutProps()}
        bridge={bridge}
        cwd="/repo"
        open
        newRequest={0}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(terminals).toHaveLength(1));
    const terminal = terminals[0]!;
    // jsdom 没有 FontFace，放大的 CJK 字体注册不上，退回普通中文字体
    expect(terminal.options.fontFamily).toBe(terminalFontFamily("darwin", false));
    expect(terminal.options.fontFamily).toContain('"PingFang SC"');
    expect(terminal.options.allowProposedApi).toBe(true);
    expect(terminal.addons.some((addon) => addon instanceof FakeUnicode11)).toBe(true);
    expect(terminal.unicode.activeVersion).toBe("11");
  });

  it("supports several tabs and kills the process when a tab is closed", async () => {
    const { bridge } = fakeBridge();
    const onClose = vi.fn();
    render(
      <TerminalPanel
        {...layoutProps()}
        bridge={bridge}
        cwd={null}
        open
        newRequest={0}
        onClose={onClose}
      />,
    );
    await screen.findAllByRole("tab");
    fireEvent.click(screen.getByRole("button", { name: "新建终端" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(screen.getAllByRole("tab")[1]!.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getAllByRole("button", { name: "关闭这个终端" })[0]!);
    expect(bridge.terminal.kill).toHaveBeenCalledWith("t1");
    expect(terminals[0]!.disposed).toBe(true);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();

    // 最后一个关掉就收起面板
    fireEvent.click(screen.getByRole("button", { name: "关闭这个终端" }));
    expect(bridge.terminal.kill).toHaveBeenCalledWith("t2");
    expect(onClose).toHaveBeenCalled();
  });

  it("marks exited processes and kills everything on unmount", async () => {
    const { bridge, emitExit } = fakeBridge();
    const view = render(
      <TerminalPanel
        {...layoutProps()}
        bridge={bridge}
        cwd={null}
        open
        newRequest={0}
        onClose={() => undefined}
      />,
    );
    await screen.findByRole("tab");
    act(() => emitExit({ id: "t1", exitCode: 3 }));
    expect(terminals[0]!.written.join("")).toContain("进程已退出（代码 3）");
    view.unmount();
    expect(bridge.terminal.kill).toHaveBeenCalledWith("t1");
  });

  it("shows an error instead of crashing when the shell can't start", async () => {
    const { bridge } = fakeBridge();
    bridge.terminal.create.mockRejectedValueOnce(new Error("spawn failed"));
    render(
      <TerminalPanel
        {...layoutProps()}
        bridge={bridge}
        cwd={null}
        open
        newRequest={0}
        onClose={() => undefined}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toBe("终端启动失败：spawn failed");
    expect(terminals[0]!.disposed).toBe(true);
  });
});

describe("TerminalPanel layout", () => {
  it("docks on the right with a vertical splitter and width limits", async () => {
    const { bridge } = fakeBridge();
    const props = layoutProps({ position: "right", width: 5000 });
    render(
      <TerminalPanel
        {...props}
        bridge={bridge}
        cwd={null}
        open
        newRequest={0}
        onClose={() => undefined}
      />,
      {
        container: sizedContainer(1200, 800),
      },
    );
    await screen.findByRole("tab");
    const panel = screen.getByRole("region", { name: "终端" });
    expect(panel.dataset.position).toBe("right");
    // 最宽到对话区只剩 360px
    expect(panel.style.width).toBe("840px");
    const splitter = screen.getByRole("separator", { name: "拖动调整终端宽度" });
    expect(splitter.getAttribute("aria-orientation")).toBe("vertical");
    fireEvent.keyDown(splitter, { key: "ArrowRight" });
    expect(props.onResize).toHaveBeenLastCalledWith({ width: 816 });
    fireEvent.click(screen.getByRole("button", { name: "移到底部" }));
    expect(props.onTogglePosition).toHaveBeenCalled();
  });

  it("falls back to the bottom when the chat area is too narrow for a right dock", async () => {
    const { bridge } = fakeBridge();
    render(
      <TerminalPanel
        {...layoutProps({ position: "right" })}
        bridge={bridge}
        cwd={null}
        open
        newRequest={0}
        onClose={() => undefined}
      />,
      { container: sizedContainer(600, 700) },
    );
    await screen.findByRole("tab");
    const panel = screen.getByRole("region", { name: "终端" });
    expect(panel.dataset.position).toBe("bottom");
    expect(panel.style.height).toBe("280px");
    expect(screen.getByRole("button", { name: "移到右侧" })).toBeTruthy();
  });

  it("clamps the bottom height so the chat keeps room, and pointer drags commit on release", async () => {
    const { bridge } = fakeBridge();
    const props = layoutProps({ height: 900 });
    render(
      <TerminalPanel
        {...props}
        bridge={bridge}
        cwd={null}
        open
        newRequest={0}
        onClose={() => undefined}
      />,
      {
        container: sizedContainer(1000, 600),
      },
    );
    await screen.findByRole("tab");
    const panel = screen.getByRole("region", { name: "终端" });
    expect(panel.style.height).toBe("420px");
    const splitter = screen.getByRole("separator", { name: "拖动调整终端高度" });
    fireEvent.pointerDown(splitter, { clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(splitter, { clientY: 500, pointerId: 1 });
    expect(panel.style.height).toBe("220px");
    expect(props.onResize).not.toHaveBeenCalled();
    fireEvent.pointerMove(splitter, { clientY: 900, pointerId: 1 });
    fireEvent.pointerUp(splitter, { pointerId: 1 });
    // 不低于 140
    expect(props.onResize).toHaveBeenCalledWith({ height: 140 });
  });

  it("fills the chat area when maximized and hides the splitter", async () => {
    const { bridge } = fakeBridge();
    const props = layoutProps({ maximized: true, position: "right" });
    render(
      <TerminalPanel
        {...props}
        bridge={bridge}
        cwd={null}
        open
        newRequest={0}
        onClose={() => undefined}
      />,
    );
    await screen.findByRole("tab");
    const panel = screen.getByRole("region", { name: "终端" });
    expect(panel.hasAttribute("data-maximized")).toBe(true);
    expect(panel.getAttribute("style")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
    // 最大化时不显示换位置，还原按钮按下态
    expect(screen.queryByRole("button", { name: "移到底部" })).toBeNull();
    const restore = screen.getByRole("button", { name: "还原终端面板" });
    expect(restore.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(restore);
    expect(props.onToggleMaximized).toHaveBeenCalled();
  });

  it("leaves the layout shortcuts to the desktop menu instead of typing them into the shell", async () => {
    const { bridge } = fakeBridge();
    render(
      <TerminalPanel
        {...layoutProps()}
        bridge={bridge}
        cwd={null}
        open
        newRequest={0}
        onClose={() => undefined}
      />,
    );
    await screen.findByRole("tab");
    const handler = terminals[0]!.keyHandler!;
    const key = (init: KeyboardEventInit) => handler(new KeyboardEvent("keydown", init));
    expect(key({ code: "KeyM", key: "M", metaKey: true, shiftKey: true })).toBe(false);
    expect(key({ code: "KeyP", key: "π", metaKey: true, altKey: true })).toBe(false);
    expect(key({ code: "KeyM", key: "m", ctrlKey: true })).toBe(true);
    expect(key({ code: "KeyL", key: "l", ctrlKey: true })).toBe(true);
  });
});

describe("TerminalPanel after a page reload", () => {
  it("reattaches the terminals still running in the desktop app and replays their output", async () => {
    const { bridge, emitData } = reloadedBridge();
    sessionStorage.setItem(TERMINAL_ACTIVE_KEY, "old1");
    render(
      <TerminalPanel
        {...layoutProps()}
        bridge={bridge}
        cwd="/repo"
        open
        newRequest={0}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    // 接回来了就不再新开
    expect(bridge.terminal.create).not.toHaveBeenCalled();
    expect(bridge.terminal.attach).toHaveBeenCalledWith("old1");
    expect(terminals[0]!.written.join("")).toBe("$ npm run dev\r\nready\r\n");
    // 选中刷新前的那个标签
    expect(screen.getAllByRole("tab")[0]!.getAttribute("aria-selected")).toBe("true");
    // 接回后照常输入输出
    act(() => emitData("old2", "tick"));
    expect(terminals[1]!.written.at(-1)).toBe("tick");
    terminals[0]!.type("q");
    expect(bridge.terminal.write).toHaveBeenCalledWith("old1", "q");
  });

  it("opens a fresh terminal when nothing is left to reattach", async () => {
    const { bridge } = reloadedBridge();
    bridge.terminal.list.mockResolvedValueOnce([]);
    render(
      <TerminalPanel
        {...layoutProps()}
        bridge={bridge}
        cwd="/repo"
        open
        newRequest={0}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(bridge.terminal.create).toHaveBeenCalledTimes(1));
    expect(bridge.terminal.attach).not.toHaveBeenCalled();
  });
});

describe("useDesktopTerminal / TerminalDock", () => {
  it("remembers position, size and maximized state, and follows the desktop menu", async () => {
    const { bridge, requestLayout } = reloadedBridge();
    bridge.terminal.list.mockResolvedValue([]);
    const source = () => bridge;
    const { result } = renderHook(() => useDesktopTerminal(source));
    expect(result.current!.layout).toEqual(DEFAULT_TERMINAL_LAYOUT);
    expect(result.current!.open).toBe(false);

    act(() => result.current!.togglePosition());
    expect(result.current!.open).toBe(true);
    expect(result.current!.layout.position).toBe("right");
    act(() => result.current!.resize({ width: 640 }));
    act(() => result.current!.toggleMaximized());
    expect(result.current!.layout.maximized).toBe(true);
    // 最大化时换位置：先还原，位置不变
    act(() => result.current!.togglePosition());
    expect(result.current!.layout).toMatchObject({ position: "right", maximized: false });

    // 收着时按最大化：打开并最大化
    act(() => result.current!.close());
    act(() => requestLayout("maximize"));
    expect(result.current!.open).toBe(true);
    expect(result.current!.layout.maximized).toBe(true);
    act(() => requestLayout("maximize"));
    act(() => requestLayout("position"));
    expect(result.current!.layout.position).toBe("bottom");

    expect(JSON.parse(localStorage.getItem(TERMINAL_LAYOUT_KEY)!)).toEqual({
      position: "bottom",
      maximized: false,
      height: 280,
      width: 640,
    });
    expect(sessionStorage.getItem(TERMINAL_OPEN_KEY)).toBe("1");
    // 重启后读回同一份偏好
    const again = renderHook(() => useDesktopTerminal(source));
    expect(again.result.current!.layout).toMatchObject({ position: "bottom", width: 640 });
  });

  it("brings the panel back after a reload when the desktop app still has terminals", async () => {
    const { bridge } = reloadedBridge();
    sessionStorage.setItem(TERMINAL_OPEN_KEY, "1");
    const source = () => bridge;
    function Harness() {
      const state = useDesktopTerminal(source);
      return <TerminalDock state={state} cwd="/repo" />;
    }
    render(<Harness />);
    expect((await screen.findByRole("region", { name: "终端" })).hidden).toBe(false);
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(bridge.terminal.create).not.toHaveBeenCalled();
  });

  it("keeps a reattached panel collapsed if it was collapsed before the reload", async () => {
    const { bridge } = reloadedBridge();
    sessionStorage.setItem(TERMINAL_OPEN_KEY, "0");
    const { result } = renderHook(() => useDesktopTerminal(() => bridge));
    await waitFor(() => expect(result.current!.mounted).toBe(true));
    expect(result.current!.open).toBe(false);
  });

  it("is undefined in a normal browser, so no terminal UI renders", () => {
    const { result } = renderHook(() => useDesktopTerminal(() => undefined));
    expect(result.current).toBeUndefined();
    const { container } = render(<TerminalDock state={undefined} cwd="/repo" />);
    expect(container.innerHTML).toBe("");
  });

  it("mounts the panel lazily and opens a new terminal on the menu request", async () => {
    const { bridge, requestNew } = fakeBridge();
    const source = () => bridge;
    function Harness() {
      const state = useDesktopTerminal(source);
      return (
        <>
          <button type="button" onClick={state?.toggle}>
            toggle
          </button>
          <TerminalDock state={state} cwd="/repo" />
        </>
      );
    }
    render(<Harness />);
    expect(screen.queryByRole("region", { name: "终端" })).toBeNull();
    expect(bridge.terminal.create).not.toHaveBeenCalled();

    act(() => requestNew());
    await waitFor(() => expect(bridge.terminal.create).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole("region", { name: "终端" })).hidden).toBe(false);

    // 收起不结束进程
    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    expect(bridge.terminal.kill).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>(".terminal-panel")!.hidden).toBe(true);
  });
});
