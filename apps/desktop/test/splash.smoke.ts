/**
 * 启动加载画面：起不来时停在出错画面上（不弹系统对话框、不永远转下去），点「重试」能接着启动成功。
 * 顺带截加载动画和出错画面（screenshots/ 在 gitignore 里）。
 */
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { desktopDir, shotDir } from "./flows.js";

test("shows an error with Retry when the local Hive can't start, and Retry recovers", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "superhive-desktop-splash-"));
  // Electron 自己的用户目录先建好、可写；数据目录本身只读，Server 建不了数据库，启动失败
  mkdirSync(path.join(dataDir, "desktop-user-data"));
  chmodSync(dataDir, 0o500);
  const port = 18_400 + Math.floor(Math.random() * 90);
  const app = await electron.launch({
    args: [path.join(desktopDir, ".stage/app")],
    env: {
      ...process.env,
      SUPERHIVE_DESKTOP_DATA_DIR: dataDir,
      SUPERHIVE_DESKTOP_PORT: String(port),
      HIVE_NO_OPEN: "1",
      LANG: "zh_CN.UTF-8",
    } as Record<string, string>,
  });
  try {
    let splash: Page | undefined;
    await expect
      .poll(() => (splash = app.windows().find((win) => win.url().startsWith("data:text/html"))), {
        timeout: 30_000,
      })
      .toBeTruthy();
    const body = splash!.locator("body");
    await expect(body).toHaveAttribute("data-state", "error", { timeout: 60_000 });
    await expect(splash!.locator("#error-title")).toHaveText(/没能启动|couldn't start/);
    await expect(splash!.locator("#error-detail")).not.toBeEmpty();
    await expect(splash!.locator("#error-log")).toContainText("server.log");
    // 动画停下了（logo 变灰的过渡播完后，一个在跑的动画都没有）
    await expect
      .poll(() =>
        splash!.evaluate(
          () => document.getAnimations().filter((a) => a.playState === "running").length,
        ),
      )
      .toBe(0);
    await splash!.screenshot({ path: path.join(shotDir, "splash-error.png") });

    // 修好之后点「重试」：同一个窗口接着启动，加载层收起，露出主界面
    chmodSync(dataDir, 0o700);
    await splash!.getByRole("button", { name: /重试|Retry/ }).click();
    await expect
      .poll(
        () =>
          app
            .windows()
            .find((win) => win.url().startsWith("http://127.0.0.1:"))
            ?.url(),
        {
          timeout: 60_000,
        },
      )
      .toContain(`127.0.0.1:${port}`);
    await expect
      .poll(
        () =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().map((w) => w.contentView.children.length),
          ),
        { timeout: 20_000 },
      )
      .toEqual([0]);
  } finally {
    chmodSync(dataDir, 0o700);
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
