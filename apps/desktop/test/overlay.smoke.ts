/**
 * 窗口按钮安全区冒烟：所有铺满或贴边的面板、弹窗，标题和按钮都不能落进系统窗口按钮那块区域。
 *
 * - Windows / Linux（overlay）：最小化、最大化、关闭浮在右上角，宽约 138px、高等于顶栏，点这里只会点到系统按钮；
 * - macOS（mac）：红黄绿按钮在左上角，约 78px 宽。
 * macOS 上跑时把 html 的 data-titlebar 临时改成 overlay 来模拟 Windows 的布局（拿不到 env(titlebar-area-*)，
 * 按默认 138px 让位）；两种模式、宽窗口、最小窗口（960×640）和窄布局（720px，弹窗变成底部面板）各查一遍。
 * 每个面板还要：Esc 能关；有看得见、点得到的关闭按钮，点了能关。
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { desktopDir, enterRoom, shotDir } from "./flows.js";

let app: ElectronApplication;
let page: Page;
let dataDir: string;
const port = 18_900 + Math.floor(Math.random() * 200);
const mod = process.platform === "darwin" ? "Meta" : "Control";

async function mainWindow(application: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const found = application.windows().find((win) => win.url().startsWith("http://127.0.0.1:"));
    if (found) return found;
    await application.waitForEvent("window", { timeout: 5_000 }).catch(() => undefined);
  }
  throw new Error("main window did not open");
}

async function setWindowSize(width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().startsWith("http://127.0.0.1:"),
      )!;
      if (win.isMaximized()) win.unmaximize();
      // 比最小窗口还窄的尺寸只用来查窄布局的样式（浏览器里会遇到），桌面端拖不到这么小
      win.setMinimumSize(Math.min(size.width, 960), Math.min(size.height, 640));
      win.setContentSize(size.width, size.height);
    },
    { width, height },
  );
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
}

async function setMode(mode: "overlay" | "mac"): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.dataset.titlebar = value;
    delete document.documentElement.dataset.fullscreen;
  }, mode);
}

type Hit = { label: string; rect: string };

/**
 * 找出落进窗口按钮区域、而且在那里确实露在最上面（没被别的层盖住）的按钮、输入框、标题。
 * 区域按 CSS 变量算：overlay 是右上角 --titlebar-inset-right × 顶栏高，mac 是左上角 --titlebar-inset-left × 顶栏高。
 */
async function controlsInButtonArea(): Promise<Hit[]> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    const px = (name: string) => {
      const probe = document.createElement("span");
      probe.style.cssText = `position:absolute;visibility:hidden;width:var(${name})`;
      document.body.appendChild(probe);
      const value = probe.getBoundingClientRect().width;
      probe.remove();
      return value;
    };
    const height = px("--header-height");
    const overlay = root.dataset.titlebar === "overlay";
    const band = overlay
      ? { left: window.innerWidth - px("--titlebar-inset-right"), right: window.innerWidth }
      : { left: 0, right: px("--titlebar-inset-left") };
    void style;
    const hits: { label: string; rect: string }[] = [];
    const selector =
      "button, a[href], input, select, textarea, summary, [role=button], [role=tab], [role=separator], h1, h2, h3, [role=heading]";
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      // 遮罩、拖动边这类又高又大的：窗口按钮只盖住它很小一角，别处照样点得到
      if (rect.height > height * 3) continue;
      const left = Math.max(rect.left, band.left);
      const right = Math.min(rect.right, band.right);
      const top = Math.max(rect.top, 0);
      const bottom = Math.min(rect.bottom, height);
      if (right - left < 1 || bottom - top < 1) continue;
      // 只算在那块区域里真的露在最上面的（被弹窗遮罩盖住的不算）
      const topmost = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      if (!topmost || !(el === topmost || el.contains(topmost) || topmost.contains(el))) continue;
      const label =
        el.getAttribute("aria-label") ||
        el.textContent?.trim().slice(0, 30) ||
        `${el.tagName.toLowerCase()}.${el.className}`;
      hits.push({
        label: `${label} <${el.tagName.toLowerCase()} class="${el.className}">`,
        rect: `${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}×${Math.round(rect.height)}`,
      });
    }
    return hits;
  });
}

type Panel = {
  name: string;
  /** 打开后出现的面板本身 */
  locator: () => Locator;
  open: () => Promise<void>;
  /** 面板里的关闭 / 返回按钮 */
  close: () => Locator;
};

/** 侧栏里的按钮：窄窗口时侧栏是抽屉，先打开抽屉 */
async function sidebarButton(name: RegExp): Promise<void> {
  const button = page.locator(".rooms-panel").getByRole("button", { name }).first();
  if (!(await button.isVisible()))
    await page.getByRole("button", { name: /^(打开房间列表|Open room list)/ }).click();
  await button.click();
}

const closeName = /^(关闭|Close)|关闭$|返回|Back|^Cancel$|^取消$/;

const panels: Panel[] = [
  {
    name: "产物",
    locator: () => page.locator(".sheet-panel"),
    open: () => page.locator(".artifacts-toggle").click(),
    close: () => page.locator(".sheet-panel .sheet-header-actions button").last(),
  },
  {
    name: "代码",
    locator: () => page.locator(".sheet-panel"),
    open: async () => {
      const button = page.locator(".workspace-toggle");
      if (await button.isVisible()) return button.click();
      await page.locator(".header-more").click();
      await page.getByRole("menuitem", { name: /^(代码|Code)/ }).click();
    },
    close: () => page.locator(".sheet-panel .sheet-header-actions button").last(),
  },
  {
    name: "搜索",
    locator: () => page.locator(".activity-panel"),
    open: () => sidebarButton(/^(搜索消息|Search messages)/),
    close: () => page.locator(".activity-panel").getByRole("button", { name: closeName }).first(),
  },
  {
    name: "Agent 任务",
    locator: () => page.locator(".activity-panel"),
    open: () => sidebarButton(/^(Agent 任务|Agent tasks)/),
    close: () => page.locator(".activity-panel").getByRole("button", { name: closeName }).first(),
  },
  {
    name: "定时任务",
    locator: () => page.locator(".activity-panel"),
    open: () => sidebarButton(/^(定时任务|Scheduled)/),
    close: () => page.locator(".activity-panel").getByRole("button", { name: closeName }).first(),
  },
  {
    name: "提及我",
    locator: () => page.locator(".activity-panel"),
    open: () => sidebarButton(/^(提及我|Mentions)/),
    close: () => page.locator(".activity-panel").getByRole("button", { name: closeName }).first(),
  },
  {
    name: "故障",
    locator: () => page.locator(".activity-panel"),
    open: () => sidebarButton(/^(故障|Incidents)/),
    close: () => page.locator(".activity-panel").getByRole("button", { name: closeName }).first(),
  },
  {
    name: "连接 IM",
    locator: () => page.locator(".room-dialog-layer"),
    open: () => sidebarButton(/^(连接 IM|Connect IM)/),
    close: () =>
      page
        .locator(".room-dialog-layer [role=dialog]")
        .getByRole("button", { name: closeName })
        .first(),
  },
  {
    name: "管理房间",
    locator: () => page.locator(".room-dialog-layer"),
    open: () => sidebarButton(/^(管理房间|Manage room)/),
    close: () =>
      page
        .locator(".room-dialog-layer [role=dialog]")
        .getByRole("button", { name: closeName })
        .first(),
  },
  {
    name: "跳转",
    locator: () => page.locator(".activity-panel"),
    open: () => page.keyboard.press(`${mod}+P`),
    close: () => page.locator(".activity-panel").getByRole("button", { name: closeName }).first(),
  },
  {
    name: "快捷键",
    locator: () => page.locator(".activity-panel"),
    open: () => page.keyboard.press(`${mod}+/`),
    close: () => page.locator(".activity-panel").getByRole("button", { name: closeName }).first(),
  },
  {
    name: "新建房间",
    locator: () => page.locator(".room-dialog-layer"),
    open: () => sidebarButton(/^(新建房间|New room)/),
    close: () =>
      page
        .locator(".room-dialog-layer [role=dialog]")
        .getByRole("button", { name: closeName })
        .first(),
  },
  {
    name: "设置",
    locator: () => page.locator(".settings-dialog-layer"),
    open: async () => {
      const chip = page.locator(".sidebar-user-chip");
      if (!(await chip.isVisible()))
        await page.getByRole("button", { name: /^(打开房间列表|Open room list)/ }).click();
      await chip.hover();
      if (!(await page.locator(".user-menu").isVisible())) await chip.click();
      await page.locator(".user-menu [role=menuitem]", { hasText: /^(设置|Settings)$/ }).click();
    },
    close: () => page.locator(".settings-dialog").getByRole("button", { name: closeName }).first(),
  },
  {
    name: "文件预览",
    locator: () => page.locator(".file-preview-backdrop"),
    open: () => page.locator(".message-file", { hasText: "overlay-note.md" }).last().click(),
    close: () =>
      page.locator(".file-preview-header").getByRole("button", { name: closeName }).last(),
  },
  {
    name: "图片大图",
    locator: () => page.locator(".attachment-lightbox"),
    open: () => page.locator(".message-image img, .message-attachments img").last().click(),
    close: () => page.locator(".attachment-lightbox-close"),
  },
];

test.beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "superhive-desktop-overlay-"));
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

test("login page fits the window without scrollbars", async () => {
  await expect(page.getByRole("textbox", { name: /你的用户名|Your username/ })).toBeVisible({
    timeout: 30_000,
  });
  // 最小窗口拖不到更小；Windows 的滚动条占地方，出现一条就会连带出另一条
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
    [1280, 720],
    [1100, 700],
    [960, 640],
  ] as const) {
    await setWindowSize(width, height);
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => {
      const doc = document.scrollingElement!;
      const scrollers = Array.from(document.querySelectorAll<HTMLElement>("*"))
        .filter((el) => {
          const style = getComputedStyle(el);
          return (
            (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1) ||
            (/(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1)
          );
        })
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
      return {
        x: doc.scrollWidth - doc.clientWidth,
        y: doc.scrollHeight - doc.clientHeight,
        scrollers,
      };
    });
    expect(overflow, `login ${width}×${height}`).toEqual({ x: 0, y: 0, scrollers: [] });
  }
  // 最小窗口确实生效
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().startsWith("http://127.0.0.1:"))!
      .setContentSize(400, 300),
  );
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([960, 640]);
  await setWindowSize(1280, 800);
});

test("every large panel keeps its title and buttons clear of the window buttons", async () => {
  test.setTimeout(300_000);
  await enterRoom(page, "overlay");
  // 发一条带 Markdown 和图片附件的消息，给预览和大图用
  const files = path.join(dataDir, "fixtures");
  rmSync(files, { recursive: true, force: true });
  mkdirSync(files);
  writeFileSync(path.join(files, "overlay-note.md"), "# 标题\n\n预览正文。\n");
  // 1×1 PNG
  writeFileSync(
    path.join(files, "overlay-dot.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  await page
    .locator(".composer input[type=file]")
    .setInputFiles([path.join(files, "overlay-note.md"), path.join(files, "overlay-dot.png")]);
  const send = page.locator(".composer").getByRole("button", { name: /^(发送|Send)$/ });
  await expect(send).toBeEnabled({ timeout: 20_000 });
  await send.click();
  await expect(page.locator(".message-file", { hasText: "overlay-note.md" })).toBeVisible({
    timeout: 20_000,
  });
  await checkPanels();
});

test.afterAll(async () => {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function checkPanels(): Promise<void> {
  const problems: string[] = [];
  const sizes = [
    { width: 1280, height: 800 },
    // 桌面端的最小窗口
    { width: 960, height: 640 },
    // 窄布局：侧栏变抽屉、弹窗变底部面板
    { width: 720, height: 480 },
  ];
  for (const size of sizes) {
    await setWindowSize(size.width, size.height);
    for (const mode of ["overlay", "mac"] as const) {
      await setMode(mode);
      for (const panel of panels) {
        await panel.open();
        await expect(panel.locator().first(), `${panel.name} opens`).toBeVisible();
        await page.waitForTimeout(350);
        for (const hit of await controlsInButtonArea())
          problems.push(`${size.width}px ${mode} ${panel.name}: ${hit.label} @ ${hit.rect}`);
        if (process.env.OVERLAY_SHOTS)
          await page.screenshot({
            path: path.join(shotDir, `overlay-${mode}-${size.width}-${panel.name}.png`),
          });
        // 关闭按钮看得见、点得到
        const close = panel.close();
        await expect(close, `${panel.name} close button`).toBeVisible();
        await close.click();
        await expect(
          panel.locator().filter({ visible: true }),
          `${panel.name} closes by its button`,
        ).toHaveCount(0);
        // Esc 也能关
        await panel.open();
        await expect(panel.locator().first()).toBeVisible();
        await page.waitForTimeout(200);
        await page.keyboard.press("Escape");
        await expect(
          panel.locator().filter({ visible: true }),
          `${panel.name} closes on Escape`,
        ).toHaveCount(0);
      }
    }
  }
  expect(problems, problems.join("\n")).toEqual([]);
}
