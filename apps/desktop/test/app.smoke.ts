/**
 * 开发版冒烟：用 Playwright 的 _electron 启动 .stage/app，独立的数据目录和端口，不碰 ~/.superhive。
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  desktopDir,
  enterRoom,
  launchLocalAgent,
  runTerminalCommand,
  serverAlive,
  shotDir,
} from "./flows.js";

let app: ElectronApplication;
let page: Page;
let dataDir: string;
const port = 18_700 + Math.floor(Math.random() * 200);

async function mainWindow(application: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const found = application.windows().find((win) => win.url().startsWith("http://127.0.0.1:"));
    if (found) return found;
    await application.waitForEvent("window", { timeout: 5_000 }).catch(() => undefined);
  }
  throw new Error("main window did not open");
}

test.beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "superhive-desktop-smoke-"));
  app = await electron.launch({
    args: [path.join(desktopDir, ".stage/app")],
    env: {
      ...process.env,
      SUPERHIVE_DESKTOP_DATA_DIR: dataDir,
      SUPERHIVE_DESKTOP_PORT: String(port),
      HIVE_NO_OPEN: "1",
    } as Record<string, string>,
  });
  page = await mainWindow(app);
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app?.close();
  // 退出桌面端要把自己起的 Server 停掉
  expect(await serverAlive(port)).toBe(false);
  rmSync(dataDir, { recursive: true, force: true });
});

test("starts its own Hive and loads the web UI on loopback", async () => {
  expect(new URL(page.url()).origin).toBe(`http://127.0.0.1:${port}`);
  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  expect(health.status).toBe("ok");
});

test("loading animation gets out of the way once the UI is ready", async () => {
  await enterRoom(page);
  // 加载层（主窗口里盖着的一层 WebContentsView）收起后整个拿掉，不留在窗口里
  await expect
    .poll(
      () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((w) => w.contentView.children.length),
        ),
      { timeout: 15_000 },
    )
    .toEqual([0]);
  expect(app.windows().some((win) => win.url().startsWith("data:"))).toBe(false);
  // 浏览器用的首屏占位在桌面端是藏起来的，收起后也移除了
  await expect(page.locator("#boot-splash")).toHaveCount(0);
});

test("opens a terminal from the header and runs a command", async () => {
  await enterRoom(page);
  await page.screenshot({ path: path.join(shotDir, "main-window.png") });
  await runTerminalCommand(page, "terminal.png");
});

test("terminal moves to the right, maximizes and survives a page reload", async () => {
  test.setTimeout(120_000);
  await enterRoom(page);
  const panel = page.locator(".terminal-panel");
  const rows = page.locator(".terminal-panel .xterm-rows");
  const run = async (marker: string) => {
    await page.locator(".terminal-panel .xterm").click();
    await page.keyboard.type(`echo ${marker}-$((40+2))`);
    await page.keyboard.press("Enter");
    await expect(rows).toContainText(`${marker}-42`, { timeout: 20_000 });
  };
  const box = async (selector: string) => (await page.locator(selector).boundingBox())!;

  await page.getByRole("button", { name: /^(终端|Terminal)$/ }).click();
  await expect(page.locator(".terminal-tab")).toHaveCount(1, { timeout: 15_000 });
  await run("bottom");

  // 右侧：和对话左右排，对话还留着
  await page.getByRole("button", { name: /^(移到右侧|Move to the right)$/ }).click();
  await expect(panel).toHaveAttribute("data-position", "right");
  const chat = await box(".chat-main");
  const right = await box(".terminal-panel");
  expect(right.x).toBeGreaterThanOrEqual(chat.x + chat.width - 1);
  expect(chat.width).toBeGreaterThanOrEqual(360);
  await run("right");

  // 菜单「最大化 / 还原终端」：铺满对话区，对话不能被点到
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()?.getMenuItemById("terminal-maximize")?.click(),
  );
  await expect(panel).toHaveAttribute("data-maximized", "");
  const body = await box(".chat-body");
  const full = await box(".terminal-panel");
  expect(Math.abs(full.width - body.width)).toBeLessThan(2);
  expect(Math.abs(full.height - body.height)).toBeLessThan(2);
  await expect(page.locator(".chat-main")).toHaveAttribute("inert", "");
  await run("max");

  // 刷新：终端还在跑，输出回放回来，位置和最大化照旧，还能继续输入
  await page.reload();
  await expect(page.locator("header.chat-header")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".terminal-tab")).toHaveCount(1, { timeout: 15_000 });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-maximized", "");
  await expect(rows).toContainText("max-42", { timeout: 10_000 });
  await run("reloaded");

  // 还原回右侧，再用菜单换回底部，收尾时关掉终端
  await page.getByRole("button", { name: /^(还原终端面板|Restore terminal panel)$/ }).click();
  await expect(panel).toHaveAttribute("data-position", "right");
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()?.getMenuItemById("terminal-position")?.click(),
  );
  await expect(panel).toHaveAttribute("data-position", "bottom");
  await run("back");
  await page.getByRole("button", { name: /关闭这个终端|Close this terminal/ }).click();
  await expect(panel).toBeHidden();
});

test("system title bar is gone; window buttons sit clear of the content", async () => {
  await enterRoom(page);
  const win = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) =>
      x.webContents.getURL().startsWith("http://127.0.0.1:"),
    )!;
    return {
      bounds: w.getBounds(),
      content: w.getContentBounds(),
      buttons: process.platform === "darwin" ? w.getWindowButtonPosition() : null,
    };
  });
  // 网页内容顶到窗口最上面：没有系统标题栏占高度
  expect(win.content.height).toBe(win.bounds.height);
  expect(win.content.y).toBe(win.bounds.y);
  const html = page.locator("html");
  const platform = { darwin: "mac", win32: "win" }[process.platform as string] ?? "linux";
  await expect(html).toHaveAttribute("data-desktop", platform);
  await expect(html).toHaveAttribute(
    "data-titlebar",
    process.platform === "darwin" ? "mac" : "overlay",
  );
  // 顶栏可拖动，里面的按钮不拖
  const region = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region"));
  expect(await region(".chat-header")).toBe("drag");
  expect(await region(".sidebar-header")).toBe("drag");
  expect(await region(".chat-header button")).toBe("no-drag");
  if (process.platform === "darwin") {
    // 红黄绿按钮（三个约 52px 宽）在左侧栏顶部那一行里垂直居中，不压住 logo
    const brand = (await page.locator(".sidebar-header .brand").boundingBox())!;
    const header = (await page.locator(".sidebar-header").boundingBox())!;
    expect(win.buttons!.x + 54).toBeLessThan(brand.x);
    const buttonsCenter = win.buttons!.y + 7;
    expect(Math.abs(buttonsCenter - (header.y + header.height / 2))).toBeLessThanOrEqual(2);
    // 侧栏收起时，聊天顶栏的折叠按钮同样让开
    await page.locator(".rooms-toggle").click();
    const toggle = (await page.locator(".rooms-toggle").boundingBox())!;
    expect(win.buttons!.x + 54).toBeLessThan(toggle.x);
    await page.locator(".rooms-toggle").click();
    await expect(page.locator(".sidebar-header .brand")).toBeVisible();
  }
});

test("local agents launch through the app binary, not a separate Node", async () => {
  await launchLocalAgent(page);
});

test("renderer is locked down", async () => {
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().startsWith("http://127.0.0.1:"),
    )!;
    // 类型声明里没有这个方法，运行时有
    const p = (
      win.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> }
    ).getLastWebPreferences();
    return {
      contextIsolation: p.contextIsolation,
      sandbox: p.sandbox,
      nodeIntegration: p.nodeIntegration,
      webviewTag: p.webviewTag,
    };
  });
  expect(prefs).toEqual({
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webviewTag: false,
  });
  // 页面里没有 Node，只有那个窄接口
  expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe(
    "undefined",
  );
  expect(
    await page.evaluate(() =>
      Object.keys((window as unknown as { superhiveDesktop: object }).superhiveDesktop).sort(),
    ),
  ).toEqual(["platform", "ready", "terminal", "titlebar", "version"]);
  // 同源的 iframe 拿不到能力：preload 只在顶层框架暴露
  const inFrame = await page.evaluate(async () => {
    const frame = document.createElement("iframe");
    frame.src = "/health";
    document.body.appendChild(frame);
    await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
    const value = typeof (frame.contentWindow as unknown as { superhiveDesktop?: unknown })
      .superhiveDesktop;
    frame.remove();
    return value;
  });
  expect(inFrame).toBe("undefined");
  // 跳去别的地方会被拦下，页面留在本机 Hive（用 file: 地址，免得测试时真的打开系统浏览器）
  await page.evaluate(() => {
    window.location.href = "file:///etc/hosts";
  });
  await page.waitForTimeout(500);
  expect(new URL(page.url()).origin).toBe(`http://127.0.0.1:${port}`);
});
