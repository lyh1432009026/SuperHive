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
});

describe("TerminalPanel", () => {
  it("opens a terminal in the room workspace and pipes input and output", async () => {
    const { bridge, emitData } = fakeBridge();
    render(
      <TerminalPanel
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
      <TerminalPanel bridge={bridge} cwd="/repo" open newRequest={0} onClose={() => undefined} />,
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
    render(<TerminalPanel bridge={bridge} cwd={null} open newRequest={0} onClose={onClose} />);
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
      <TerminalPanel bridge={bridge} cwd={null} open newRequest={0} onClose={() => undefined} />,
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
      <TerminalPanel bridge={bridge} cwd={null} open newRequest={0} onClose={() => undefined} />,
    );
    expect((await screen.findByRole("alert")).textContent).toBe("终端启动失败：spawn failed");
    expect(terminals[0]!.disposed).toBe(true);
  });
});

describe("useDesktopTerminal / TerminalDock", () => {
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
