/**
 * SuperHive 桌面端主进程。
 *
 * 两种运行方式：
 * - 正常打开：起（或连上）本机 Hive，窗口里加载现有的网页界面，并提供内置终端；
 * - `--superhive-cli ...`：Server 拉起本机 Agent 时用。桌面端关掉了 RunAsNode，
 *   Electron 不能被当成任意 Node 用，所以由主进程自己加载随包的 superhive CLI 跑 `join`，
 *   不开窗口、不占 Dock，也不抢单实例锁。只会运行包里的 CLI，不执行任意脚本。
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  session,
  shell,
  utilityProcess,
  webContents as allWebContents,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
  type WebPreferences,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  discover,
  startServer,
  superhiveHome,
  type ForkServer,
  type OwnedServer,
} from "./hive-server.js";
import { IPC, ORIGIN_ARG_PREFIX, type TerminalCreateRequest } from "./ipc-contract.js";
import { isLoopbackOrigin, isTrustedSender, originOf } from "./ipc-guard.js";
import { loginShellPath, mergePath } from "./shell-env.js";
import { TerminalManager, type PtySpawn } from "./terminal-manager.js";
import { langFor, text, type Lang, type TextKey } from "./texts.js";
import { loadWindowState, restoreBounds, saveWindowState, MIN_SIZE } from "./window-state.js";

const CLI_FLAG = "--superhive-cli";
const DOCS_URL = "https://wangrongding.github.io/SuperHive/";
const ISSUES_URL = "https://github.com/wangrongding/SuperHive/issues";
const PREFERRED_PORT = Number.parseInt(process.env.SUPERHIVE_DESKTOP_PORT ?? "", 10) || 8787;

/** 打包后的应用根目录（app.asar 或开发时的 .stage/app） */
const appRoot = __dirname;
const superhiveRoot = path.join(appRoot, "superhive");

const cliIndex = process.argv.indexOf(CLI_FLAG);
if (cliIndex >= 0) {
  void runCli(process.argv.slice(cliIndex + 1));
} else {
  runApp();
}

async function runCli(args: string[]): Promise<void> {
  app.dock?.hide();
  const cli = path.join(superhiveRoot, "dist", "cli.js");
  process.argv = [process.execPath, cli, ...args];
  try {
    await import(pathToFileURL(cli).href);
  } catch (error) {
    console.error("[superhive-desktop] failed to run CLI:", error);
    app.exit(1);
  }
}

/** 本机 Agent 的启动命令：开发时 Electron 要带上应用目录 */
function agentCliCommand(): string[] {
  return app.isPackaged
    ? [process.execPath, CLI_FLAG]
    : [process.execPath, app.getAppPath(), CLI_FLAG];
}

function runApp(): void {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // 所有渲染进程都进沙箱
  app.enableSandbox();

  let lang: Lang = "en";
  const t = (key: TextKey, params?: Record<string, string>) => text(lang, key, params);

  let mainWindow: BrowserWindow | undefined;
  let splash: BrowserWindow | undefined;
  /** 当前允许拿到终端能力的页面来源（本机 Hive 的回环地址） */
  let allowedOrigin: string | undefined;
  const trustedIds = new Set<number>();
  let owned: OwnedServer | undefined;
  let quitting = false;
  let shutdownDone = false;
  const dataDir = superhiveHome();

  // ---------- 终端 ----------
  let ptySpawn: PtySpawn | undefined;
  const loadPty = (): PtySpawn => {
    if (!ptySpawn) {
      // 原生模块，按需加载：加载失败只影响终端，不影响主界面
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pty = require("node-pty") as { spawn: PtySpawn };
      ptySpawn = pty.spawn.bind(pty);
    }
    return ptySpawn;
  };
  // 输出按一个事件循环批量发送，避免大量输出时 IPC 消息过多
  const pending = new Map<string, { ownerId: number; chunks: string[] }>();
  let flushScheduled = false;
  const flush = () => {
    flushScheduled = false;
    for (const [id, entry] of pending) {
      const contents = allWebContents.fromId(entry.ownerId);
      if (contents && !contents.isDestroyed())
        contents.send(IPC.terminalData, id, entry.chunks.join(""));
    }
    pending.clear();
  };
  const terminals = new TerminalManager({
    spawn: (file, args, options) => loadPty()(file, args, options),
    env: () => process.env,
    sink: {
      data(ownerId, id, data) {
        const entry = pending.get(id) ?? { ownerId, chunks: [] };
        entry.chunks.push(data);
        pending.set(id, entry);
        if (!flushScheduled) {
          flushScheduled = true;
          setTimeout(flush, 5);
        }
      },
      exit(ownerId, id, exitCode, signal) {
        flush();
        const contents = allWebContents.fromId(ownerId);
        if (contents && !contents.isDestroyed())
          contents.send(IPC.terminalExit, { id, exitCode, ...(signal ? { signal } : {}) });
      },
    },
  });

  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    isTrustedSender(event, { origin: allowedOrigin, webContentsIds: trustedIds });

  ipcMain.handle(IPC.terminalCreate, (event, request: TerminalCreateRequest) => {
    if (!trusted(event)) throw new Error("Forbidden");
    return terminals.create(event.sender.id, request ?? {});
  });
  ipcMain.on(IPC.terminalWrite, (event, id: unknown, data: unknown) => {
    if (trusted(event)) terminals.write(event.sender.id, id, data);
  });
  ipcMain.on(IPC.terminalResize, (event, id: unknown, cols: unknown, rows: unknown) => {
    if (trusted(event)) terminals.resize(event.sender.id, id, cols, rows);
  });
  ipcMain.on(IPC.terminalKill, (event, id: unknown) => {
    if (trusted(event)) terminals.kill(event.sender.id, id);
  });

  // ---------- 安全：所有 webContents 统一限制 ----------
  const sameOriginUrl = (url: string): boolean => {
    if (!allowedOrigin) return false;
    if (url.startsWith("blob:")) {
      try {
        return new URL(url).origin === allowedOrigin;
      } catch {
        return false;
      }
    }
    return originOf(url) === allowedOrigin;
  };
  const openExternal = (url: string) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
  };
  const popupPreferences: WebPreferences = {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webviewTag: false,
    spellcheck: false,
  };
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("will-navigate", (event) => {
      if (sameOriginUrl(event.url)) return;
      event.preventDefault();
      openExternal(event.url);
    });
    contents.on("will-redirect", (event) => {
      if (event.isMainFrame && !sameOriginUrl(event.url)) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      // 同源的新窗口（附件预览、导出）照常打开，但不带 preload，拿不到终端
      if (sameOriginUrl(url)) {
        return {
          action: "allow",
          overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: popupPreferences },
        };
      }
      openExternal(url);
      return { action: "deny" };
    });
  });

  const allowedPermissions = new Set([
    "clipboard-read",
    "clipboard-sanitized-write",
    "notifications",
    "fullscreen",
  ]);
  const permissionOk = (permission: string, origin: string | undefined) =>
    allowedPermissions.has(permission) && Boolean(origin) && originOf(origin!) === allowedOrigin;

  // ---------- 窗口 ----------
  const windowStateFile = () => path.join(app.getPath("userData"), "window-state.json");
  const backgroundColor = () => (nativeTheme.shouldUseDarkColors ? "#111318" : "#ffffff");

  function showSplash(): void {
    if (splash && !splash.isDestroyed()) return;
    splash = new BrowserWindow({
      width: 360,
      height: 200,
      frame: false,
      resizable: false,
      show: false,
      center: true,
      backgroundColor: backgroundColor(),
      webPreferences: { ...popupPreferences },
    });
    const dark = nativeTheme.shouldUseDarkColors;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
      html,body{margin:0;height:100%;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:${dark ? "#111318" : "#ffffff"};color:${dark ? "#d9dce3" : "#1f2329"};-webkit-app-region:drag;user-select:none}
      body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px}
      .bar{width:140px;height:3px;border-radius:3px;background:${dark ? "#2a2e37" : "#e6e8ec"};overflow:hidden}
      .bar i{display:block;width:40%;height:100%;background:linear-gradient(90deg,#3b82f6,#f5a524);animation:s 1.2s ease-in-out infinite}
      @keyframes s{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
      @media (prefers-reduced-motion:reduce){.bar i{animation:none;width:100%}}
      </style></head><body><strong style="font-size:18px">SuperHive</strong><div>${t("starting")}</div><div class="bar"><i></i></div></body></html>`;
    void splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    splash.once("ready-to-show", () => splash?.show());
  }

  function closeSplash(): void {
    if (splash && !splash.isDestroyed()) splash.destroy();
    splash = undefined;
  }

  function createMainWindow(origin: string): BrowserWindow {
    const saved = loadWindowState(windowStateFile());
    const bounds = restoreBounds(
      saved,
      screen.getAllDisplays().map((display) => display.workArea),
    );
    const window = new BrowserWindow({
      ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
      width: bounds.width ?? 1280,
      height: bounds.height ?? 820,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: false,
      title: "SuperHive",
      backgroundColor: backgroundColor(),
      webPreferences: {
        preload: path.join(appRoot, "preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        spellcheck: false,
        additionalArguments: [`${ORIGIN_ARG_PREFIX}${origin}`],
      },
    });
    if (bounds.maximized) window.maximize();
    const contentsId = window.webContents.id;
    trustedIds.add(contentsId);

    let saveTimer: NodeJS.Timeout | undefined;
    const persist = () => {
      if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
      const normal = window.getNormalBounds();
      saveWindowState(windowStateFile(), { ...normal, maximized: window.isMaximized() });
    };
    const schedulePersist = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(persist, 400);
    };
    window.on("resize", schedulePersist);
    window.on("move", schedulePersist);
    window.on("maximize", schedulePersist);
    window.on("unmaximize", schedulePersist);

    // 刷新、跳转或渲染进程崩溃：这个页面开的终端都结束掉
    window.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) terminals.disposeOwner(contentsId);
    });
    window.webContents.on("render-process-gone", () => terminals.disposeOwner(contentsId));
    window.webContents.on("destroyed", () => {
      terminals.disposeOwner(contentsId);
      trustedIds.delete(contentsId);
    });

    window.on("close", (event) => {
      persist();
      // macOS 习惯：关窗口不退出，点 Dock 图标再打开
      if (process.platform === "darwin" && !quitting) {
        event.preventDefault();
        window.hide();
      }
    });
    window.once("ready-to-show", () => {
      closeSplash();
      window.show();
    });
    void window.loadURL(origin);
    return window;
  }

  function showMainWindow(): void {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  // ---------- 连接本机 Hive ----------
  const fork: ForkServer = (entry, env) =>
    new Promise((resolve, reject) => {
      const child = utilityProcess.fork(entry, [], {
        env,
        stdio: "pipe",
        serviceName: "SuperHive Server",
      });
      const onExit = (code: number) => reject(new Error(`Server exited (code ${code})`));
      child.once("exit", onExit);
      child.once("spawn", () => {
        child.removeListener("exit", onExit);
        resolve({
          pid: child.pid,
          kill: () => child.kill(),
          on: (_event, listener) => child.on("exit", listener),
          stdout: child.stdout,
          stderr: child.stderr,
        });
      });
    });

  async function connect(): Promise<string> {
    const found = await discover({ dataDir, preferredPort: PREFERRED_PORT });
    if (found.kind === "existing") {
      console.log(`[superhive-desktop] ${t("connectedExisting", { origin: found.origin })}`);
      return found.origin;
    }
    owned = await startServer({
      fork,
      serverEntry: path.join(superhiveRoot, "dist", "server", "index.js"),
      staticDir: path.join(superhiveRoot, "web"),
      dataDir,
      port: found.port,
      env: process.env,
      agentCli: agentCliCommand(),
      launcher: `SuperHive Desktop ${app.getVersion()}`,
    });
    const server = owned;
    void server.exited.then((code) => {
      if (owned === server) owned = undefined;
      if (quitting) return;
      // 被 hive stop 停掉或者崩溃：问一下要不要重新启动
      void handleServerGone(code);
    });
    return owned.origin;
  }

  async function handleServerGone(code: number): Promise<void> {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      title: "SuperHive",
      message: t("startFailedTitle"),
      detail: t("startFailedDetail", {
        reason: `exit ${code}`,
        log: path.join(dataDir, "server.log"),
      }),
      buttons: [t("retry"), t("openLogs"), t("quit")],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 0) return boot();
    if (response === 1) void shell.openPath(dataDir);
    app.quit();
  }

  async function boot(): Promise<void> {
    showSplash();
    try {
      const origin = await connect();
      if (!isLoopbackOrigin(origin)) throw new Error(`Refusing non-loopback origin ${origin}`);
      allowedOrigin = origin;
      if (mainWindow && !mainWindow.isDestroyed()) {
        // 重连到新的地址：preload 的来源参数是建窗口时定的，换窗口最稳妥
        mainWindow.removeAllListeners("close");
        mainWindow.destroy();
      }
      mainWindow = createMainWindow(origin);
      buildMenu();
    } catch (error) {
      closeSplash();
      const reason = error instanceof Error ? error.message : String(error);
      const { response } = await dialog.showMessageBox({
        type: "error",
        title: "SuperHive",
        message: t("startFailedTitle"),
        detail: t("startFailedDetail", { reason, log: path.join(dataDir, "server.log") }),
        buttons: [t("retry"), t("openLogs"), t("quit")],
        defaultId: 0,
        cancelId: 2,
      });
      if (response === 0) return boot();
      if (response === 1) await shell.openPath(dataDir);
      app.quit();
    }
  }

  // ---------- 菜单 ----------
  function sendNewTerminal(): void {
    showMainWindow();
    const contents: WebContents | undefined = mainWindow?.webContents;
    if (contents && !contents.isDestroyed()) contents.send(IPC.terminalNewRequest);
  }

  function buildMenu(): void {
    const isMac = process.platform === "darwin";
    const template: MenuItemConstructorOptions[] = [
      ...(isMac ? [{ role: "appMenu" as const }] : []),
      {
        label: t("file"),
        submenu: [
          { label: t("newTerminal"), accelerator: "Ctrl+`", click: sendNewTerminal },
          {
            label: t("openInBrowser"),
            enabled: Boolean(allowedOrigin),
            click: () => allowedOrigin && void shell.openExternal(allowedOrigin),
          },
          { type: "separator" },
          isMac ? { role: "close" } : { role: "quit" },
        ],
      },
      { role: "editMenu", label: t("edit") },
      {
        label: t("view"),
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu", label: t("window") },
      {
        role: "help",
        label: t("help"),
        submenu: [
          {
            label: t("docs"),
            click: () => void shell.openExternal(lang === "zh" ? DOCS_URL : `${DOCS_URL}en/`),
          },
          { label: t("issues"), click: () => void shell.openExternal(ISSUES_URL) },
          { label: t("openLogs"), click: () => void shell.openPath(dataDir) },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  // ---------- 生命周期 ----------
  app.on("second-instance", () => showMainWindow());
  app.on("activate", () => showMainWindow());
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    quitting = true;
    if (shutdownDone) return;
    event.preventDefault();
    shutdownDone = true;
    terminals.disposeAll();
    const server = owned;
    owned = undefined;
    void (server ? server.stop().catch(() => undefined) : Promise.resolve()).finally(() =>
      app.quit(),
    );
  });

  void app.whenReady().then(async () => {
    lang = langFor(app.getLocale());
    app.setAboutPanelOptions({
      applicationName: "SuperHive",
      applicationVersion: app.getVersion(),
      website: DOCS_URL,
    });
    session.defaultSession.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        callback(permissionOk(permission, details.requestingUrl ?? contents.getURL()));
      },
    );
    session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
      permissionOk(permission, requestingOrigin),
    );
    buildMenu();
    // 从访达 / Dock 打开时 PATH 不全，本机 Agent 和终端都要用到用户自己的 PATH
    const shellPath = await loginShellPath();
    if (shellPath) process.env.PATH = mergePath(shellPath, process.env.PATH);
    await boot();
  });
}
