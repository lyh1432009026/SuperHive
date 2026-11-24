import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import "./styles/terminal.css";
import { t } from "./i18n";
import { Icon } from "./app-icons";
import { Tooltip } from "./tooltip";
import { IconButton } from "./button";
import type { DesktopBridge } from "./desktop-bridge";
import { applyTerminalTextStyle, prepareCjkFont, terminalFontFamily } from "./terminal-fonts";
import { keyCombo } from "./shortcuts";
import {
  clampTerminalHeight,
  clampTerminalWidth,
  effectivePosition,
  MIN_TERMINAL_HEIGHT,
  MIN_TERMINAL_WIDTH,
  sessionValue,
  setSessionValue,
  TERMINAL_ACTIVE_KEY,
  type TerminalLayout,
} from "./terminal-layout";

/**
 * 桌面端内置终端（只在 SuperHive 桌面端里按需加载，浏览器里不会下载 xterm）。
 * 停靠在对话区底部或右侧，也能最大化铺满对话区；可以开多个标签；收起面板不结束进程，关掉标签才结束。
 * 进程在桌面端主进程里用 node-pty 跑，这里只负责显示和输入；页面刷新后从桌面端接回还在跑的终端。
 */

type Tab = {
  id: string;
  title: string;
  cwd: string;
  exited?: number;
};

type Entry = {
  terminal: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  /** 刷新后接回来的：第一次排版后把尺寸告诉进程（xterm 尺寸没变时不会触发 onResize） */
  syncSize?: boolean;
};

/** 键盘调整尺寸的步长 */
const RESIZE_STEP = 24;

const DARK_ANSI = {
  black: "#1e1e1e",
  red: "#f47067",
  green: "#57ab5a",
  yellow: "#c69026",
  blue: "#539bf5",
  magenta: "#b083f0",
  cyan: "#39c5cf",
  white: "#d1d5da",
  brightBlack: "#768390",
  brightRed: "#ff938a",
  brightGreen: "#6bc46d",
  brightYellow: "#daaa3f",
  brightBlue: "#6cb6ff",
  brightMagenta: "#dcbdfb",
  brightCyan: "#56d4dd",
  brightWhite: "#ffffff",
};

const LIGHT_ANSI = {
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#7d4e00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

function isDark(): boolean {
  return document.documentElement.dataset.theme === "dark";
}

/** 终端配色跟着页面主题：底色、前景色取页面的设计变量，ANSI 16 色按明暗各一套 */
export function terminalTheme(dark: boolean, style?: CSSStyleDeclaration): ITheme {
  const css = style ?? getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const background = read("--bg-code", dark ? "#171717" : "#f7f7f8");
  const foreground = read("--text", dark ? "#ececec" : "#0d0d0d");
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: dark ? "rgba(255,255,255,0.22)" : "rgba(1,105,204,0.22)",
    // 滚动条和页面其他地方一样用半透明细滑块
    scrollbarSliderBackground: read(
      "--scrollbar-thumb",
      dark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.18)",
    ),
    scrollbarSliderHoverBackground: read(
      "--scrollbar-thumb-hover",
      dark ? "rgba(255,255,255,0.34)" : "rgba(0,0,0,0.34)",
    ),
    scrollbarSliderActiveBackground: read(
      "--scrollbar-thumb-hover",
      dark ? "rgba(255,255,255,0.34)" : "rgba(0,0,0,0.34)",
    ),
    ...(dark ? DARK_ANSI : LIGHT_ANSI),
  };
}

const FONT_SIZE = 13;

/** 桌面端菜单里的快捷键（Electron 菜单加速键，xterm 里也能用） */
const MAXIMIZE_KEYS = ["Mod", "Shift", "M"];
const POSITION_KEYS = ["Mod", "Alt", "P"];

function withKeys(label: string, keys: string[]): string {
  return `${label}（${keyCombo(keys)}）`;
}

/** Electron 会给 IPC 抛出的错误加上「Error invoking remote method …: Error: 」前缀 */
function ipcMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "");
}

function baseName(file: string): string {
  return file.split(/[\\/]/).filter(Boolean).at(-1) ?? file;
}

export function TerminalPanel({
  bridge,
  cwd,
  open,
  newRequest,
  layout,
  onClose,
  onTogglePosition,
  onToggleMaximized,
  onResize,
}: {
  bridge: DesktopBridge;
  /** 新终端的工作目录：当前房间的工作区，没有就交给桌面端用主目录 */
  cwd: string | null;
  open: boolean;
  /** 每加 1 就新开一个终端（菜单「新建终端」、顶栏按钮） */
  newRequest: number;
  layout: TerminalLayout;
  onClose: () => void;
  onTogglePosition: () => void;
  onToggleMaximized: () => void;
  onResize: (size: Partial<Pick<TerminalLayout, "height" | "width">>) => void;
}) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string>();
  /** 拖动中的尺寸：松手才记进偏好 */
  const [dragSize, setDragSize] = useState<number>();
  /** 对话区（面板的父元素）的尺寸：决定右侧放不放得下、尺寸上限 */
  const [body, setBody] = useState({ width: 0, height: 0 });
  /** 刷新后从桌面端接回终端的过程结束了（老版本桌面端直接算结束） */
  const [restored, setRestored] = useState(!bridge.terminal.list || !bridge.terminal.attach);
  const [error, setError] = useState<string>();
  const panel = useRef<HTMLElement>(null);
  const entries = useRef(new Map<string, Entry>());
  /** 终端还没建好（create 还没返回）时先到的输出 */
  const early = useRef(new Map<string, string[]>());
  const viewport = useRef<HTMLDivElement>(null);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const creating = useRef(false);

  const fitActive = useCallback(() => {
    if (!activeId) return;
    const entry = entries.current.get(activeId);
    if (!entry || entry.host.offsetParent === null) return;
    try {
      entry.fit.fit();
      if (entry.syncSize) {
        entry.syncSize = false;
        bridge.terminal.resize(activeId, entry.terminal.cols, entry.terminal.rows);
      }
    } catch {
      /* 面板还没布局好 */
    }
  }, [activeId, bridge]);

  const buildTerminal = useCallback(async (): Promise<Entry> => {
    // 先注册放大的 CJK 字体，xterm 第一次量字宽时就能用上（本机字体，几毫秒）
    const scaledCjk = await prepareCjkFont(bridge.platform, FONT_SIZE);
    const terminal = new Terminal({
      // Unicode 11 宽度表要用 terminal.unicode（xterm 仍标为实验接口）
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: terminalFontFamily(bridge.platform, scaledCjk),
      fontSize: FONT_SIZE,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: terminalTheme(isDark()),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    // 默认的 Unicode 6 宽度表把 ✅ ⚠️ 🚀 这类 emoji 算成一格，和 shell、CLI（按新版 wcwidth 算两格）对不上，
    // 光标和后面的字会错位；换成 Unicode 11，和 VS Code 终端一致
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    // 链接交给系统浏览器：桌面端会拦下新窗口并用默认浏览器打开
    terminal.loadAddon(
      new WebLinksAddon((_event, uri) => {
        window.open(uri, "_blank", "noopener,noreferrer");
      }),
    );
    // 面板的快捷键（最大化、换位置）交给桌面端菜单，xterm 不要把它们当成输入
    terminal.attachCustomKeyEventHandler((event) => {
      const mod = bridge.platform === "darwin" ? event.metaKey : event.ctrlKey;
      if (!mod) return true;
      return !(
        (event.shiftKey && event.code === "KeyM") ||
        (event.altKey && event.code === "KeyP")
      );
    });
    const host = document.createElement("div");
    host.className = "terminal-host";
    // xterm 量字宽和画字都在 host 里面，标点挤压、中英自动空隙要在 open 之前关掉
    applyTerminalTextStyle(host);
    return { terminal, fit, host };
  }, [bridge]);

  const register = useCallback(
    (id: string, entry: Entry) => {
      entries.current.set(id, entry);
      entry.terminal.onData((data) => bridge.terminal.write(id, data));
      entry.terminal.onResize(({ cols, rows }) => bridge.terminal.resize(id, cols, rows));
    },
    [bridge],
  );

  const createTerminal = useCallback(async () => {
    if (creating.current) return;
    creating.current = true;
    setError(undefined);
    const entry = await buildTerminal();
    try {
      const created = await bridge.terminal.create({
        cwd: cwdRef.current,
        cols: entry.terminal.cols,
        rows: entry.terminal.rows,
      });
      register(created.id, entry);
      for (const chunk of early.current.get(created.id) ?? []) entry.terminal.write(chunk);
      early.current.delete(created.id);
      const title = baseName(created.shell).replace(/\.exe$/i, "");
      setTabs((current) => [...current, { id: created.id, title, cwd: created.cwd }]);
      setActiveId(created.id);
    } catch (cause) {
      entry.terminal.dispose();
      setError(t("终端启动失败：{0}", { 0: ipcMessage(cause) }));
    } finally {
      creating.current = false;
    }
  }, [bridge, buildTerminal, register]);

  // 页面刷新后：把桌面端还留着的终端接回来，回放最近的输出，标签顺序和选中的标签照旧
  useEffect(() => {
    const { list, attach } = bridge.terminal;
    if (!list || !attach) return;
    let cancelled = false;
    void (async () => {
      try {
        const sessions = await list();
        const restoredTabs: Tab[] = [];
        for (const session of sessions) {
          if (cancelled) return;
          const entry = await buildTerminal();
          const attached = await attach(session.id).catch(() => null);
          if (cancelled || !attached) {
            entry.terminal.dispose();
            continue;
          }
          register(attached.id, { ...entry, syncSize: true });
          // 接回之前收到的输出已经包含在回放里
          early.current.delete(attached.id);
          if (attached.replay) entry.terminal.write(attached.replay);
          restoredTabs.push({
            id: attached.id,
            title: baseName(attached.shell).replace(/\.exe$/i, ""),
            cwd: attached.cwd,
          });
        }
        if (cancelled || restoredTabs.length === 0) return;
        setTabs((current) => [...restoredTabs, ...current]);
        const remembered = sessionValue(TERMINAL_ACTIVE_KEY);
        setActiveId(
          (active) =>
            active ??
            restoredTabs.find((tab) => tab.id === remembered)?.id ??
            restoredTabs.at(-1)?.id,
        );
      } catch (cause) {
        setError(t("没能接回刷新前的终端：{0}", { 0: ipcMessage(cause) }));
      } finally {
        if (!cancelled) setRestored(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge, buildTerminal, register]);

  useEffect(() => {
    if (restored) setSessionValue(TERMINAL_ACTIVE_KEY, activeId ?? null);
  }, [activeId, restored]);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const closeTab = useCallback(
    (id: string) => {
      bridge.terminal.kill(id);
      entries.current.get(id)?.terminal.dispose();
      entries.current.get(id)?.host.remove();
      entries.current.delete(id);
      const current = tabsRef.current;
      const index = current.findIndex((tab) => tab.id === id);
      const next = current.filter((tab) => tab.id !== id);
      setTabs(next);
      setActiveId((active) =>
        active === id ? next[Math.min(index, next.length - 1)]?.id : active,
      );
      if (next.length === 0) onClose();
    },
    [bridge, onClose],
  );

  // 输出和退出事件：整个面板只订阅一次
  useEffect(() => {
    const offData = bridge.terminal.onData((id, data) => {
      const entry = entries.current.get(id);
      if (entry) entry.terminal.write(data);
      else early.current.set(id, [...(early.current.get(id) ?? []), data]);
    });
    const offExit = bridge.terminal.onExit(({ id, exitCode }) => {
      entries.current
        .get(id)
        ?.terminal.write(`\r\n\x1b[2m${t("进程已退出（代码 {0}）", { 0: exitCode })}\x1b[0m\r\n`);
      setTabs((current) =>
        current.map((tab) => (tab.id === id ? { ...tab, exited: exitCode } : tab)),
      );
    });
    const map = entries.current;
    return () => {
      offData();
      offExit();
      // 面板卸载（离开页面）时结束全部终端；桌面端在页面刷新、窗口关闭时也会兜底清理
      for (const [id, entry] of map) {
        bridge.terminal.kill(id);
        entry.terminal.dispose();
      }
      map.clear();
    };
  }, [bridge]);

  // 新建请求；第一次打开面板、一个终端都没有时自动开一个
  const handledRequest = useRef(0);
  useEffect(() => {
    if (newRequest > handledRequest.current) {
      handledRequest.current = newRequest;
      void createTerminal();
    }
  }, [newRequest, createTerminal]);
  useEffect(() => {
    if (
      open &&
      restored &&
      tabs.length === 0 &&
      newRequest === handledRequest.current &&
      !creating.current
    ) {
      void createTerminal();
    }
    // 只在面板打开（或接回结束）时检查，不随 tabs 变化重复触发
  }, [open, restored]);

  // 把当前标签的 xterm 挂到视口里
  useEffect(() => {
    const container = viewport.current;
    if (!container || !activeId) return;
    const entry = entries.current.get(activeId);
    if (!entry) return;
    for (const child of [...container.children]) {
      if (child !== entry.host) (child as HTMLElement).hidden = true;
    }
    if (entry.host.parentElement !== container) container.appendChild(entry.host);
    entry.host.hidden = false;
    if (!entry.terminal.element) entry.terminal.open(entry.host);
    if (open) {
      requestAnimationFrame(() => {
        fitActive();
        entry.terminal.focus();
      });
    }
  }, [activeId, open, fitActive]);

  // 尺寸变化时重新排版
  useEffect(() => {
    const container = viewport.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fitActive());
    observer.observe(container);
    return () => observer.disconnect();
  }, [fitActive]);

  // 主题切换时更新配色
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const theme = terminalTheme(isDark());
      for (const entry of entries.current.values()) entry.terminal.options.theme = theme;
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  // 对话区尺寸：窗口缩放、侧栏开合时重新判断位置和尺寸上限
  useEffect(() => {
    const parent = panel.current?.parentElement;
    if (!parent) return;
    const measure = () => setBody({ width: parent.clientWidth, height: parent.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  const position = effectivePosition(layout.position, body.width);
  const maximized = layout.maximized;
  const vertical = position === "right";
  const clamp = (value: number) =>
    vertical ? clampTerminalWidth(value, body.width) : clampTerminalHeight(value, body.height);
  const size = clamp(dragSize ?? (vertical ? layout.width : layout.height));
  const commitSize = (value: number) =>
    onResize(vertical ? { width: clamp(value) } : { height: clamp(value) });

  // 换位置、最大化后终端尺寸变了：重新排版
  useEffect(() => {
    if (!open || !activeId) return;
    requestAnimationFrame(() => fitActive());
  }, [position, maximized, open, activeId, fitActive]);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const start = vertical ? event.clientX : event.clientY;
    const startSize = size;
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    let latest = startSize;
    // 底部往上拖变高，右侧往左拖变宽
    const move = (moveEvent: PointerEvent) => {
      latest = clamp(startSize + (start - (vertical ? moveEvent.clientX : moveEvent.clientY)));
      setDragSize(latest);
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      commitSize(latest);
      setDragSize(undefined);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  };

  const positionLabel = position === "right" ? t("移到底部") : t("移到右侧");
  const maximizeLabel = maximized ? t("还原终端面板") : t("最大化终端面板");

  return (
    <section
      ref={panel}
      className="terminal-panel"
      aria-label={t("终端")}
      hidden={!open}
      data-position={position}
      data-maximized={maximized ? "" : undefined}
      style={maximized ? undefined : vertical ? { width: size } : { height: size }}
    >
      {!maximized && (
        <div
          className="terminal-resizer"
          role="separator"
          // 底部时是横向分隔条（调高度），右侧时是竖向分隔条（调宽度）
          aria-orientation={vertical ? "vertical" : "horizontal"}
          aria-label={vertical ? t("拖动调整终端宽度") : t("拖动调整终端高度")}
          aria-valuemin={vertical ? MIN_TERMINAL_WIDTH : MIN_TERMINAL_HEIGHT}
          aria-valuenow={size}
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={(event) => {
            const grow = vertical ? "ArrowLeft" : "ArrowUp";
            const shrink = vertical ? "ArrowRight" : "ArrowDown";
            if (event.key === grow) commitSize(size + RESIZE_STEP);
            else if (event.key === shrink) commitSize(size - RESIZE_STEP);
            else return;
            event.preventDefault();
          }}
        />
      )}
      <div className="terminal-tabs" role="tablist" aria-label={t("终端")}>
        {tabs.map((tab, index) => (
          <div
            key={tab.id}
            className={`terminal-tab${tab.id === activeId ? " active" : ""}${tab.exited !== undefined ? " exited" : ""}`}
          >
            <Tooltip content={tab.cwd}>
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === activeId}
                className="terminal-tab-label"
                onClick={() => setActiveId(tab.id)}
              >
                <span className="terminal-tab-index">{index + 1}</span>
                <span>{tab.title}</span>
                <span className="terminal-tab-cwd">{baseName(tab.cwd)}</span>
              </button>
            </Tooltip>
            <button
              type="button"
              className="terminal-tab-close"
              aria-label={t("关闭这个终端")}
              onClick={() => closeTab(tab.id)}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
        <IconButton size="sm" label={t("新建终端")} onClick={() => void createTerminal()}>
          <Icon name="plus" size={14} />
        </IconButton>
        <span className="terminal-tabs-spacer" />
        {error && (
          <span className="terminal-error" role="alert">
            {error}
          </span>
        )}
        {!maximized && (
          <IconButton
            size="sm"
            label={positionLabel}
            tooltip={withKeys(positionLabel, POSITION_KEYS)}
            data-action="position"
            onClick={onTogglePosition}
          >
            <Icon name={position === "right" ? "panel-bottom" : "panel-right"} size={14} />
          </IconButton>
        )}
        <IconButton
          size="sm"
          label={maximizeLabel}
          tooltip={withKeys(maximizeLabel, MAXIMIZE_KEYS)}
          aria-pressed={maximized}
          data-action="maximize"
          onClick={onToggleMaximized}
        >
          <Icon name={maximized ? "minimize" : "maximize"} size={14} />
        </IconButton>
        <IconButton
          size="sm"
          label={t("收起终端面板")}
          tooltip={t("收起终端面板（终端继续运行）")}
          onClick={onClose}
        >
          <Icon name={vertical && !maximized ? "arrow-right" : "arrow-down"} size={14} />
        </IconButton>
      </div>
      <div className="terminal-viewport" ref={viewport} />
    </section>
  );
}
