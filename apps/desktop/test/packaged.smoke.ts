/**
 * 打包版冒烟：启动 electron-forge 打出来的应用（fuses 已开：不能 --inspect，也不能当 Node 用），
 * 用 Chromium 的远程调试端口连上窗口，走一遍进房间、开终端执行命令、接入本机 Agent。
 *
 *   SUPERHIVE_DESKTOP_APP=out/SuperHive-darwin-arm64/SuperHive.app/Contents/MacOS/SuperHive pnpm test:smoke
 *
 * 没设 SUPERHIVE_DESKTOP_APP 时跳过。
 */
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  desktopDir,
  enterRoom,
  launchLocalAgent,
  runTerminalCommand,
  serverAlive,
} from "./flows.js";

const executable = process.env.SUPERHIVE_DESKTOP_APP;
test.skip(!executable, "set SUPERHIVE_DESKTOP_APP to a packaged SuperHive executable");

let child: ChildProcess;
let browser: Browser;
let page: Page;
let dataDir: string;
const port = 18_900 + Math.floor(Math.random() * 90);
const debugPort = 19_300 + Math.floor(Math.random() * 90);

test.beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "superhive-desktop-packaged-"));
  child = spawn(path.resolve(desktopDir, executable!), [`--remote-debugging-port=${debugPort}`], {
    env: {
      ...process.env,
      SUPERHIVE_DESKTOP_DATA_DIR: dataDir,
      SUPERHIVE_DESKTOP_PORT: String(port),
      HIVE_NO_OPEN: "1",
    },
    stdio: "ignore",
  });
  await expect.poll(() => serverAlive(port), { timeout: 60_000 }).toBe(true);
  await expect
    .poll(
      () =>
        fetch(`http://127.0.0.1:${debugPort}/json/version`).then(
          () => true,
          () => false,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  await expect
    .poll(
      () =>
        browser
          .contexts()
          .flatMap((context) => context.pages())
          .some((p) => p.url().startsWith(`http://127.0.0.1:${port}`)),
      { timeout: 30_000 },
    )
    .toBe(true);
  page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((p) => p.url().startsWith(`http://127.0.0.1:${port}`))!;
});

test.afterAll(async () => {
  await browser?.close().catch(() => undefined);
  // 正常退出（等同菜单里的退出）：要把自己起的 Server 和本机 Agent 一起停掉
  child?.kill("SIGTERM");
  await expect.poll(() => serverAlive(port), { timeout: 20_000 }).toBe(false);
  rmSync(dataDir, { recursive: true, force: true });
});

test("packaged app: terminal and local agents work with fuses on", async () => {
  expect(
    await page.evaluate(
      () => typeof (window as unknown as { superhiveDesktop?: unknown }).superhiveDesktop,
    ),
  ).toBe("object");
  await enterRoom(page);
  // 没有系统标题栏：网页内容就是整个窗口的高度，顶栏可拖动
  if (process.platform !== "linux") {
    const size = await page.evaluate(() => ({ inner: innerHeight, outer: outerHeight }));
    expect(size.inner).toBe(size.outer);
  }
  await expect(page.locator("html")).toHaveAttribute(
    "data-titlebar",
    process.platform === "darwin" ? "mac" : "overlay",
  );
  expect(
    await page
      .locator(".chat-header")
      .evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region")),
  ).toBe("drag");
  await runTerminalCommand(page, "packaged-terminal.png");
  await launchLocalAgent(page, "packaged-agent");
});
