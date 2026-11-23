/**
 * 给交付和文档截图（不算回归测试）：SUPERHIVE_DESKTOP_SHOTS=1 pnpm exec playwright test test/screenshots.smoke.ts
 * 建一个带工作区（本仓库）的房间，深色、浅色各截一张主界面和终端面板，存到 screenshots/（已 gitignore）。
 */
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { desktopDir, enterRoom, shotDir } from "./flows.js";

test.skip(
  !process.env.SUPERHIVE_DESKTOP_SHOTS,
  "set SUPERHIVE_DESKTOP_SHOTS=1 to take screenshots",
);

const repoRoot = path.resolve(desktopDir, "../..");

async function openTerminal(page: Page, command: string) {
  await page.getByRole("button", { name: /^(终端|Terminal)$/ }).click();
  await expect(page.locator(".terminal-tab")).toHaveCount(1, { timeout: 15_000 });
  await page.locator(".terminal-panel .xterm").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1_500);
}

test("desktop screenshots", async () => {
  test.setTimeout(180_000);
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "superhive-desktop-shots-"));
  const port = 18_600 + Math.floor(Math.random() * 90);
  const app = await electron.launch({
    args: [path.join(desktopDir, ".stage/app")],
    env: {
      ...process.env,
      SUPERHIVE_DESKTOP_DATA_DIR: dataDir,
      SUPERHIVE_DESKTOP_PORT: String(port),
      HIVE_NO_OPEN: "1",
      // 终端里不加载用户自己的 shell 配置，截图干净
      SHELL: "/bin/zsh",
      ZDOTDIR: dataDir,
    } as Record<string, string>,
  });
  try {
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.setSize(1440, 900);
    });
    let page: Page | undefined;
    await expect
      .poll(
        () => {
          page = app.windows().find((win) => win.url().startsWith("http://127.0.0.1:"));
          return Boolean(page);
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    const main = page!;
    await enterRoom(main, "rd");
    // 建一个工作区是本仓库的房间，终端会在那里打开
    const created = await main.evaluate(async (workspace) => {
      // 本机打开时 /api/meta 会给出房主的 join token（网页也是这样拿的）
      const meta = (await (await fetch("/api/meta")).json()) as { joinToken?: string };
      const token = meta.joinToken ?? "";
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: "desktop", name: "desktop", workspace }),
      });
      return response.status;
    }, repoRoot);
    expect([200, 201]).toContain(created);
    for (const theme of ["dark", "light"] as const) {
      await main.evaluate((value) => localStorage.setItem("superhive.theme", value), theme);
      await main.goto(`http://127.0.0.1:${port}/#desktop`);
      // 主题在页面加载时读，刷新一次（刷新也会结束上一轮开的终端）
      await main.reload();
      await expect(main.locator("header.chat-header")).toBeVisible({ timeout: 30_000 });
      await main.waitForTimeout(800);
      await main.screenshot({ path: path.join(shotDir, `desktop-main-${theme}.png`) });
      await openTerminal(main, "git --no-pager log --oneline -4 --no-decorate && ls");
      await main.screenshot({ path: path.join(shotDir, `desktop-terminal-${theme}.png`) });
    }
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
