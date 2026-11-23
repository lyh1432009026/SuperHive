import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { desktopBridge, type DesktopBridge } from "./desktop-bridge";
import {
  loadTerminalLayout,
  saveTerminalLayout,
  sessionValue,
  setSessionValue,
  TERMINAL_OPEN_KEY,
  type TerminalLayout,
} from "./terminal-layout";

/** xterm 只在桌面端第一次打开终端时才下载；浏览器里永远不会加载 */
const TerminalPanel = lazy(() =>
  import("./terminal-panel").then((module) => ({ default: module.TerminalPanel })),
);

export type DesktopTerminalState = {
  bridge: DesktopBridge;
  open: boolean;
  /** 打开过一次之后才挂载面板；收起时保持挂载，终端进程继续跑 */
  mounted: boolean;
  newRequest: number;
  layout: TerminalLayout;
  toggle: () => void;
  close: () => void;
  /** 底部 ↔ 右侧；最大化时先还原再换位置。面板收着时顺便打开 */
  togglePosition: () => void;
  /** 最大化 ↔ 还原。面板收着时打开并最大化 */
  toggleMaximized: () => void;
  /** 拖动或键盘调整尺寸后记下（底部记高度、右侧记宽度） */
  resize: (size: Partial<Pick<TerminalLayout, "height" | "width">>) => void;
};

/** 不在桌面端时返回 undefined，调用方据此不显示任何终端入口 */
export function useDesktopTerminal(
  source?: () => DesktopBridge | undefined,
): DesktopTerminalState | undefined {
  const bridge = useMemo(() => (source ?? desktopBridge)(), [source]);
  const [open, setOpenState] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [newRequest, setNewRequest] = useState(0);
  const [layout, setLayoutState] = useState(loadTerminalLayout);

  // 用 ref 记当前值再整体写回：状态更新函数里不放副作用（StrictMode 会调两次）
  const openRef = useRef(open);
  const layoutRef = useRef(layout);

  const setOpen = useCallback((next: boolean | ((value: boolean) => boolean)) => {
    const resolved = typeof next === "function" ? next(openRef.current) : next;
    openRef.current = resolved;
    setSessionValue(TERMINAL_OPEN_KEY, resolved ? "1" : "0");
    setOpenState(resolved);
  }, []);

  const updateLayout = useCallback((change: (value: TerminalLayout) => TerminalLayout) => {
    const next = change(layoutRef.current);
    layoutRef.current = next;
    saveTerminalLayout(next);
    setLayoutState(next);
  }, []);

  useEffect(() => {
    if (!bridge) return;
    // 菜单「新建终端」（Ctrl+`）：打开面板并新开一个
    return bridge.terminal.onNewRequest(() => {
      setMounted(true);
      setOpen(true);
      setNewRequest((value) => value + 1);
    });
  }, [bridge, setOpen]);

  // 页面刷新后：桌面端还留着这个窗口的终端，挂上面板接回去，开合状态照刷新前
  useEffect(() => {
    const list = bridge?.terminal.list;
    if (!list) return;
    let cancelled = false;
    list()
      .then((sessions) => {
        if (cancelled || sessions.length === 0) return;
        setMounted(true);
        setOpen(sessionValue(TERMINAL_OPEN_KEY) !== "0");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge, setOpen]);

  const toggle = useCallback(() => {
    setMounted(true);
    setOpen((value) => !value);
  }, [setOpen]);
  const close = useCallback(() => setOpen(false), [setOpen]);

  const showPanel = useCallback(() => {
    setMounted(true);
    setOpen(true);
  }, [setOpen]);

  const togglePosition = useCallback(() => {
    showPanel();
    updateLayout((value) => ({
      ...value,
      maximized: false,
      position: value.maximized ? value.position : value.position === "right" ? "bottom" : "right",
    }));
  }, [showPanel, updateLayout]);

  const toggleMaximized = useCallback(() => {
    // 收着时按快捷键：打开并最大化，而不是在看不见的面板上切换
    const wasOpen = openRef.current;
    showPanel();
    updateLayout((value) => ({ ...value, maximized: wasOpen ? !value.maximized : true }));
  }, [showPanel, updateLayout]);

  const resize = useCallback(
    (size: Partial<Pick<TerminalLayout, "height" | "width">>) =>
      updateLayout((value) => ({ ...value, ...size })),
    [updateLayout],
  );

  // 菜单「最大化 / 还原终端」「终端移到右侧 / 底部」
  useEffect(() => {
    const subscribe = bridge?.terminal.onLayoutRequest;
    if (!subscribe) return;
    return subscribe((action) => {
      if (action === "maximize") toggleMaximized();
      else togglePosition();
    });
  }, [bridge, toggleMaximized, togglePosition]);

  if (!bridge) return undefined;
  return {
    bridge,
    open,
    mounted,
    newRequest,
    layout,
    toggle,
    close,
    togglePosition,
    toggleMaximized,
    resize,
  };
}

export function TerminalDock({
  state,
  cwd,
}: {
  state: DesktopTerminalState | undefined;
  cwd: string | null | undefined;
}) {
  if (!state?.mounted) return null;
  return (
    <Suspense fallback={null}>
      <TerminalPanel
        bridge={state.bridge}
        cwd={cwd ?? null}
        open={state.open}
        newRequest={state.newRequest}
        layout={state.layout}
        onClose={state.close}
        onTogglePosition={state.togglePosition}
        onToggleMaximized={state.toggleMaximized}
        onResize={state.resize}
      />
    </Suspense>
  );
}
