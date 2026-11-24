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
  WebContentsView,
  webContents as allWebContents,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
  type WebPreferences,
} from "electron";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  discover,
  startServer,
  superhiveHome,
  type ForkServer,
  type OwnedServer,
} from "./hive-server.js";
import { IPC, type TerminalCreateRequest, type TerminalLayoutAction } from "./ipc-contract.js";
import { createPickFilesHandler, createWorkspaceLookup, readPickedFiles } from "./file-picker.js";
import { isLoopbackOrigin, isTrustedSender, originAnswer, originOf } from "./ipc-guard.js";
import { loginShellPath, mergePath } from "./shell-env.js";
import {
  loadSplashTheme,
  parseSplashAction,
  resolveDark,
  saveSplashTheme,
  SPLASH_BACKGROUND,
  SplashController,
  splashHtml,
  splashUpdateScript,
  splashVariant,
  themeFromAppearance,
  type SplashPhase,
  type SplashTheme,
} from "./splash.js";
import { cliUserDataName } from "./cli-mode.js";
import { handleSquirrelEvent } from "./squirrel.js";
import { TerminalManager, type PtySpawn } from "./terminal-manager.js";
import { langFor, text, type Lang, type TextKey } from "./texts.js";
import {
  defaultAppearance,
  macButtonPosition,
  acceptAppearance,
  overlayOptions,
  titlebarMode,
  titlebarWindowOptions,
  type TitlebarAppearance,
} from "./titlebar.js";
import { TITLEBAR_ARG_PREFIX } from "./titlebar-dom.js";
import { loadWindowState, restoreBounds, saveWindowState, MIN_SIZE } from "./window-state.js";

const CLI_FLAG = "--superhive-cli";
const DOCS_URL = "https://wangrongding.github.io/SuperHive/";
const ISSUES_URL = "https://github.com/wangrongding/SuperHive/issues";
/** 网页载入完多久还没说「画好了」就直接收起加载画面 */
const READY_FALLBACK_MS = 6_000;
const PREFERRED_PORT = Number.parseInt(process.env.SUPERHIVE_DESKTOP_PORT ?? "", 10) || 8787;

/** 打包后的应用根目录（app.asar 或开发时的 .stage/app） */
const appRoot = __dirname;
const superhiveRoot = path.join(appRoot, "superhive");

const cliIndex = process.argv.indexOf(CLI_FLAG);
if (cliIndex >= 0) {
  void runCli(process.argv.slice(cliIndex + 1));
} else if (
  !handleSquirrelEvent({
    platform: process.platform,
    argv: process.argv,
    execPath: process.execPath,
    run: runUpdateExe,
    quit: () => app.quit(),
  })
) {
  runApp();
}

/** Windows 安装 / 卸载时跑 Update.exe 建删快捷方式；最多等 10 秒，跑不起来也照样退出 */
function runUpdateExe(command: string, args: string[], done: () => void): void {
  const timer = setTimeout(done, 10_000);
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => {
      clearTimeout(timer);
      done();
    });
    child.once("close", () => {
      clearTimeout(timer);
      done();
    });
  } catch {
    clearTimeout(timer);
    done();
  }
}

async function runCli(args: string[]): Promise<void> {
  app.dock?.hide();
  // 命令行模式不画界面：关掉硬件加速；Chromium 的缓存放到单独目录，不和桌面端、别的 Agent 抢
  app.disableHardwareAcceleration();
  app.setPath("userData", path.join(app.getPath("userData"), "cli", cliUserDataName(args)));
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
  // 指定了别的数据目录（测试、并排跑第二份）时，Electron 自己的用户目录也跟着分开：
  // 单实例锁、窗口位置都按用户目录算，不然会被正在用的那份桌面端挡住直接退出
  if (process.env.SUPERHIVE_DESKTOP_DATA_DIR) {
    app.setPath("userData", path.join(superhiveHome(), "desktop-user-data"));
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // 所有渲染进程都进沙箱
  app.enableSandbox();

  let lang: Lang = "en";
  const t = (key: TextKey, params?: Record<string, string>) => text(lang, key, params);

  let mainWindow: BrowserWindow | undefined;
  /** 启动加载画面：主窗口里盖在网页上面的一层 */
  let splash: { view: WebContentsView; controller: SplashController } | undefined;
  /** 网页加载完还没说「画好了」时的兜底计时（老版本网页没有 ready 接口） */
  let readyFallback: NodeJS.Timeout | undefined;
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
  ipcMain.handle(IPC.terminalList, (event) => {
    if (!trusted(event)) throw new Error("Forbidden");
    return terminals.list(event.sender.id);
  });
  ipcMain.handle(IPC.terminalAttach, (event, id: unknown) => {
    if (!trusted(event)) throw new Error("Forbidden");
    const result = terminals.attach(event.sender.id, id);
    // 还没发出去的输出已经包含在回放里，别再发一遍
    if (result) pending.delete(result.id);
    return result ?? null;
  });

  // ---------- 输入框「添加附件」：系统选文件窗口默认打开房间工作区 ----------
  // 网页只给房间 ID；起始目录由主进程自己向本机 Hive 查，选中的文件按上传上限读回去
  const roomWorkspace = createWorkspaceLookup({ origin: () => allowedOrigin, fetch });
  ipcMain.handle(
    IPC.pickFiles,
    createPickFilesHandler<IpcMainInvokeEvent>({
      trusted,
      roomWorkspace,
      home: homedir,
      isDirectory: async (target) => (await stat(target)).isDirectory(),
      title: () => t("pickAttachments"),
      showDialog: (event, { title, defaultPath, multiple }) => {
        const options: Electron.OpenDialogOptions = {
          title,
          defaultPath,
          properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
        };
        const owner = BrowserWindow.fromWebContents(event.sender);
        return owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options);
      },
      readFiles: (paths) =>
        readPickedFiles(paths, {
          stat,
          readFile: async (file) => new Uint8Array(await readFile(file)),
        }),
    }),
  );

  // preload 问自己能不能拿到桌面端能力：只回答主窗口的顶层框架，而且页面已经在本机 Hive 上
  ipcMain.on(IPC.originQuery, (event) => {
    event.returnValue = originAnswer(event, { origin: allowedOrigin, webContentsIds: trustedIds });
  });
  ipcMain.on(IPC.appReady, (event) => {
    if (trusted(event)) splash?.controller.ready();
  });

  // ---------- 标题栏 ----------
  const titlebar = titlebarMode(process.platform, process.env);
  let appearance: TitlebarAppearance | undefined;
  /** 上次网页的主题（深 / 浅 / 跟随系统），启动加载画面和窗口底色第一帧就用它 */
  let splashTheme: SplashTheme = "system";
  const splashThemeFile = () => path.join(app.getPath("userData"), "splash-theme.json");
  const prefersDark = () => resolveDark(splashTheme, nativeTheme.shouldUseDarkColors);
  const currentAppearance = () => appearance ?? defaultAppearance(prefersDark());
  /** 把网页的顶栏外观套到窗口上：macOS 挪红黄绿按钮，Windows / Linux 改 overlay 配色和高度 */
  const applyAppearance = (window: BrowserWindow) => {
    if (window.isDestroyed()) return;
    const current = currentAppearance();
    if (titlebar === "mac") {
      window.setWindowButtonPosition(macButtonPosition(current.height));
    } else if (titlebar === "overlay") {
      try {
        window.setTitleBarOverlay(overlayOptions(current, window.isFocused()));
      } catch {
        // 个别 Linux 窗口管理器不支持 overlay：按钮仍是 Electron 自己画的默认样式，不影响使用
      }
    }
  };
  ipcMain.on(IPC.titlebarAppearance, (event, input: unknown) => {
    const parsed = acceptAppearance(event, input, {
      origin: allowedOrigin,
      webContentsIds: trustedIds,
    });
    if (!parsed) return;
    appearance = parsed;
    const theme = themeFromAppearance(parsed.color, nativeTheme.shouldUseDarkColors);
    if (theme !== splashTheme) {
      splashTheme = theme;
      saveSplashTheme(splashThemeFile(), theme);
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) applyAppearance(window);
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
  const backgroundColor = () => SPLASH_BACKGROUND[prefersDark() ? "dark" : "light"];
  const variant = splashVariant(process.env);
  const logFile = () => path.join(dataDir, "server.log");

  // ---------- 启动加载画面 ----------
  /** 把加载层铺满窗口内容区；窗口改大小、进出全屏时跟着变 */
  const fitSplash = () => {
    if (!splash || !mainWindow || mainWindow.isDestroyed()) return;
    const [width = 0, height = 0] = mainWindow.getContentSize();
    splash.view.setBounds({ x: 0, y: 0, width, height });
  };

  function renderSplash(model: Parameters<typeof splashUpdateScript>[0]): void {
    const contents = splash?.view.webContents;
    if (contents && !contents.isDestroyed())
      void contents.executeJavaScript(splashUpdateScript(model)).catch(() => undefined);
  }

  function removeSplash(): void {
    clearTimeout(readyFallback);
    const current = splash;
    splash = undefined;
    if (!current) return;
    current.controller.dispose();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.contentView.removeChildView(current.view);
      mainWindow.off("resize", fitSplash);
      // 加载层拿掉后焦点交还网页，键盘直接能用
      mainWindow.webContents.focus();
    }
    if (!current.view.webContents.isDestroyed()) current.view.webContents.close();
  }

  /** 在主窗口上盖一层加载动画（已经盖着就从头再来）。窗口要等这一层画出第一帧再显示，不闪白 */
  function showSplash(window: BrowserWindow, phase: SplashPhase): void {
    if (splash) {
      splash.controller.restart(phase);
      renderSplash(splash.controller.model());
      return;
    }
    const view = new WebContentsView({ webPreferences: { ...popupPreferences } });
    // 退场时页面底色渐变成透明，露出下面已经画好的主界面
    view.setBackgroundColor("#00000000");
    const controller = new SplashController({
      lang,
      render: renderSplash,
      done: removeSplash,
    });
    controller.restart(phase);
    splash = { view, controller };
    window.contentView.addChildView(view);
    fitSplash();
    window.on("resize", fitSplash);
    // 按钮经改标题告诉主进程：页面本身没有任何 IPC 能力
    view.webContents.on("page-title-updated", (event, title) => {
      event.preventDefault();
      const action = parseSplashAction(title);
      if (action === "retry") void boot();
      else if (action === "logs") void shell.openPath(dataDir);
      else if (action === "quit") app.quit();
    });
    view.webContents.once("did-finish-load", () => {
      // 载入期间状态可能已经变了（比如很快就出错）：按当前状态再画一次
      if (splash?.view === view) renderSplash(controller.model());
      if (!window.isDestroyed() && !window.isVisible()) window.show();
    });
    const html = splashHtml({ lang, theme: splashTheme, variant, initial: controller.model() });
    void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }

  function failSplash(window: BrowserWindow, detail: string): void {
    if (!splash) showSplash(window, "starting");
    splash!.controller.fail(detail, text(lang, "splashLog", { log: logFile() }));
    if (!window.isVisible()) window.show();
  }

  /** 主窗口：一打开就按上次的位置大小显示加载动画，本机 Hive 好了再在下面加载网页 */
  function createMainWindow(): BrowserWindow {
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
      ...titlebarWindowOptions(titlebar, currentAppearance()),
      webPreferences: {
        preload: path.join(appRoot, "preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        spellcheck: false,
        additionalArguments: [`${TITLEBAR_ARG_PREFIX}${titlebar}`],
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

    // 全屏时 macOS 的红黄绿按钮会藏起来，网页把给它们让出的位置收回；刷新后也要重新告诉页面
    const sendFullscreen = () => {
      if (!window.isDestroyed())
        window.webContents.send(IPC.windowFullscreen, window.isFullScreen());
    };
    window.on("enter-full-screen", sendFullscreen);
    window.on("leave-full-screen", sendFullscreen);
    window.webContents.on("dom-ready", sendFullscreen);
    // Windows / Linux：失焦时按钮图标变淡，和系统其他窗口一致
    if (titlebar === "overlay") {
      window.on("focus", () => applyAppearance(window));
      window.on("blur", () => applyAppearance(window));
    }

    // 刷新或渲染进程崩溃：终端先留着，新页面在宽限期内接回去（回放最近的输出），没接回的才结束；
    // 窗口销毁时全部结束
    window.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) terminals.detachOwner(contentsId);
    });
    window.webContents.on("render-process-gone", () => terminals.detachOwner(contentsId));
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
    // 网页载入完一般很快就会说「画好了」；老版本网页没有这个接口，等一会儿也收起加载画面
    window.webContents.on("did-finish-load", () => {
      clearTimeout(readyFallback);
      readyFallback = setTimeout(() => splash?.controller.ready(), READY_FALLBACK_MS);
    });
    window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      // -3 是被新的导航顶掉（比如重试时重新加载），不算出错
      if (!isMainFrame || code === -3 || !allowedOrigin || originOf(url) !== allowedOrigin) return;
      failSplash(window, text(lang, "pageFailed", { reason: `${description} (${code})` }));
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      if (splash && !splash.controller.isFinished)
        failSplash(window, text(lang, "pageFailed", { reason: details.reason }));
    });
    return window;
  }

  function showMainWindow(): void {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  // ---------- 连接本机 Hive ----------
  const fork: ForkServer = (entry, env, cwd) =>
    new Promise((resolve, reject) => {
      const child = utilityProcess.fork(entry, [], {
        env,
        cwd,
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

  async function connect(onPhase: (phase: SplashPhase) => void): Promise<string> {
    const found = await discover({ dataDir, preferredPort: PREFERRED_PORT });
    if (found.kind === "existing") {
      onPhase("connecting");
      console.log(`[superhive-desktop] ${t("connectedExisting", { origin: found.origin })}`);
      return found.origin;
    }
    onPhase("starting");
    owned = await startServer({
      fork,
      serverEntry: path.join(superhiveRoot, "dist", "server", "index.js"),
      staticDir: path.join(superhiveRoot, "web"),
      dataDir,
      port: found.port,
      env: process.env,
      agentCli: agentCliCommand(),
      launcher: `SuperHive Desktop ${app.getVersion()}`,
      home: homedir(),
    });
    const server = owned;
    void server.exited.then((code) => {
      if (owned === server) owned = undefined;
      if (quitting) return;
      // 被 hive stop 停掉或者崩溃：在窗口上盖出错画面，可以重试
      handleServerGone(code);
    });
    return owned.origin;
  }

  function handleServerGone(code: number): void {
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
    failSplash(mainWindow, t("serverStopped", { code: String(code) }));
    showMainWindow();
  }

  let booting = false;
  /** 起（或连上）本机 Hive，再在主窗口里加载网页；出错时停在加载画面上，点「重试」再来一遍 */
  async function boot(): Promise<void> {
    if (booting) return;
    booting = true;
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
    const window = mainWindow;
    showSplash(window, "starting");
    try {
      const origin = await connect((phase) => splash?.controller.setPhase(phase));
      if (!isLoopbackOrigin(origin)) throw new Error(`Refusing non-loopback origin ${origin}`);
      if (window.isDestroyed()) return;
      allowedOrigin = origin;
      splash?.controller.setPhase("loading");
      buildMenu();
      // 网页在加载层下面载入；preload 载入时向主进程要地址，换了地址也不用重建窗口
      void window.loadURL(origin).catch(() => undefined);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!window.isDestroyed()) failSplash(window, reason);
    } finally {
      booting = false;
    }
  }

  // ---------- 菜单 ----------
  function sendNewTerminal(): void {
    showMainWindow();
    const contents: WebContents | undefined = mainWindow?.webContents;
    if (contents && !contents.isDestroyed()) contents.send(IPC.terminalNewRequest);
  }

  function sendTerminalLayout(action: TerminalLayoutAction): void {
    showMainWindow();
    const contents: WebContents | undefined = mainWindow?.webContents;
    if (contents && !contents.isDestroyed()) contents.send(IPC.terminalLayoutRequest, action);
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
          {
            id: "terminal-maximize",
            label: t("toggleTerminalMaximized"),
            accelerator: "CmdOrCtrl+Shift+M",
            click: () => sendTerminalLayout("maximize"),
          },
          {
            id: "terminal-position",
            label: t("toggleTerminalPosition"),
            accelerator: "CmdOrCtrl+Alt+P",
            click: () => sendTerminalLayout("position"),
          },
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
    splashTheme = loadSplashTheme(splashThemeFile());
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
