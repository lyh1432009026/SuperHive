import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { desktopBridge, type DesktopBridge } from "./desktop-bridge";

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
  toggle: () => void;
  close: () => void;
};

/** 不在桌面端时返回 undefined，调用方据此不显示任何终端入口 */
export function useDesktopTerminal(
  source?: () => DesktopBridge | undefined,
): DesktopTerminalState | undefined {
  const bridge = useMemo(() => (source ?? desktopBridge)(), [source]);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [newRequest, setNewRequest] = useState(0);

  useEffect(() => {
    if (!bridge) return;
    // 菜单「新建终端」（Ctrl+`）：打开面板并新开一个
    return bridge.terminal.onNewRequest(() => {
      setMounted(true);
      setOpen(true);
      setNewRequest((value) => value + 1);
    });
  }, [bridge]);

  const toggle = useCallback(() => {
    setMounted(true);
    setOpen((value) => !value);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  if (!bridge) return undefined;
  return { bridge, open, mounted, newRequest, toggle, close };
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
        onClose={state.close}
      />
    </Suspense>
  );
}
