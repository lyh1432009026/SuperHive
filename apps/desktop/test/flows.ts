/** 冒烟测试里开发版和打包版共用的操作步骤 */
import { expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const shotDir = path.join(desktopDir, "screenshots");

/** 全新的数据目录：过登录页、跳过新用户引导，进到房间 */
export async function enterRoom(page: Page, username = "smoke"): Promise<void> {
  const name = page.getByRole("textbox", { name: /你的用户名|Your username/ });
  const header = page.locator("header.chat-header");
  await expect(name.or(header)).toBeVisible({ timeout: 30_000 });
  if (await name.isVisible()) {
    // 页面刚渲染完时输入可能被重置，确认值留住了再提交
    await expect(async () => {
      await name.fill(username);
      await expect(name).toHaveValue(username, { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await name.press("Enter");
  }
  await expect(header).toBeVisible({ timeout: 30_000 });
  const skip = page.getByRole("button", { name: /跳过，以后再说|Skip for now/ });
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
}

/** 从顶栏打开终端、执行一条命令、确认输出，再关掉标签（结束 shell） */
export async function runTerminalCommand(page: Page, screenshot?: string): Promise<void> {
  await page.getByRole("button", { name: /^(终端|Terminal)$/ }).click();
  const panel = page.locator(".terminal-panel");
  await expect(panel).toBeVisible();
  await expect(page.locator(".terminal-tab")).toHaveCount(1, { timeout: 15_000 });
  await page.locator(".terminal-panel .xterm").click();
  await page.keyboard.type("echo superhive-smoke-$((40+2))");
  await page.keyboard.press("Enter");
  await expect(page.locator(".terminal-panel .xterm-rows")).toContainText("superhive-smoke-42", {
    timeout: 20_000,
  });
  // 中文走放大过的系统 CJK 字体（填满两个单元格，不出现字间空隙），macOS 上 PingFang 一定在
  if (process.platform === "darwin") {
    const loaded = await page.evaluate(() => {
      const faces: FontFace[] = [];
      document.fonts.forEach((face) => faces.push(face));
      return faces
        .filter((face) => face.family.replace(/"/g, "") === "SuperHive Terminal CJK")
        .map((face) => `${face.weight}:${face.status}`);
    });
    expect(loaded).toContain("400:loaded");
  }
  if (screenshot) await page.screenshot({ path: path.join(shotDir, screenshot) });
  await page.getByRole("button", { name: /关闭这个终端|Close this terminal/ }).click();
  await expect(panel).toBeHidden();
}

async function ownerFetch(page: Page, url: string, init?: { method: string; body: unknown }) {
  return page.evaluate(
    async ({ url, init }) => {
      // 和网页一样：本机会话发一个房主口令，管理本机 Agent 时带上
      const session = (await (await fetch("/api/local/session")).json()) as { ownerToken?: string };
      const response = await fetch(url, {
        ...(init ? { method: init.method, body: JSON.stringify(init.body) } : {}),
        headers: { "content-type": "application/json", "x-hive-owner": session.ownerToken ?? "" },
      });
      return { status: response.status, body: (await response.json()) as unknown };
    },
    { url, init },
  );
}

/** 在本机接入一个 Agent，确认它跑起来、在成员列表上线，并且进程是桌面端自己（--superhive-cli） */
export async function launchLocalAgent(page: Page, name = "smoke-agent"): Promise<void> {
  const created = await ownerFetch(page, "/api/local/agents", {
    method: "POST",
    body: { provider: "claude", name, access: "read-only" },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  await expect
    .poll(
      async () => {
        const { body } = await ownerFetch(page, "/api/local/agents");
        return (body as { agents: Array<{ name: string; status: string }> }).agents.find(
          (agent) => agent.name === name,
        )?.status;
      },
      { timeout: 60_000 },
    )
    .toBe("running");
  await expect(page.locator(".side-panel, aside").getByText(name).first()).toBeVisible({
    timeout: 60_000,
  });
  if (process.platform !== "win32") {
    const processes = execFileSync("ps", ["-axo", "command"], { encoding: "utf8" });
    const line = processes
      .split("\n")
      .find((cmd) => cmd.includes("--superhive-cli") && cmd.includes(name));
    expect(line, "agent process").toBeTruthy();
    expect(line).toContain("join");
  }
}

/**
 * 新建本机 Agent 时工作目录的默认值（网页取 /api/local/directories 的 defaults.launch 填进表单）是主目录：
 * 桌面端自己的 cwd 是安装目录或 /，不能拿来当默认值。
 */
export async function expectDefaultCwdIsHome(page: Page): Promise<void> {
  const home = realpathSync(os.homedir());
  const { status, body } = await ownerFetch(page, "/api/local/directories");
  expect(status, JSON.stringify(body)).toBe(200);
  const listing = body as { path: string; defaults: { launch: string; home: string } };
  expect(listing.defaults.launch).toBe(home);
  expect(listing.defaults.home).toBe(home);
  expect(listing.path).toBe(home);
}

export async function serverAlive(port: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) }).then(
    () => true,
    () => false,
  );
}

/**
 * 在当前终端里打印中英混排样例（含折行后写满右边界的长行），检查每一行画出来的字都没有超出终端区域：
 * xterm 量到的字宽和实际画出来的对不上时，越往右越错位，最右边的字会被切掉半个。
 */
export async function expectCjkRowsInside(page: Page, label: string): Promise<void> {
  const sample = path.join(desktopDir, "test/fixtures/cjk-sample.sh");
  const marker = `cjk-${label}-done`;
  await page.locator(".terminal-panel .xterm").click();
  await page.keyboard.type(`clear; sh ${JSON.stringify(sample)}; echo ${marker}`);
  await page.keyboard.press("Enter");
  const rows = page.locator(".terminal-panel .xterm-rows");
  await expect(rows).toContainText(`${marker}`, { timeout: 20_000 });
  await expect(rows).toContainText("写满到右边界");
  // 折行、重排在下一帧画完
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => {
    const screen = document.querySelector(".terminal-panel .xterm-screen")!.getBoundingClientRect();
    const lines = Array.from(document.querySelectorAll(".terminal-panel .xterm-rows > div")).map(
      (row) => {
        const spans = Array.from(row.querySelectorAll("span"));
        const right = Math.max(
          screen.left,
          ...spans.map((span) => span.getBoundingClientRect().right),
        );
        return { text: row.textContent ?? "", right };
      },
    );
    return { left: screen.left, right: screen.right, lines };
  });
  const clipped = result.lines
    .filter((line) => line.right > result.right + 1)
    .map((line) => `${line.text} (+${(line.right - result.right).toFixed(1)}px)`);
  expect(clipped, `${label}: rows drawn past the terminal's right edge`).toEqual([]);
  // 长行确实写到了右边界附近（含中文和全角标点），不然上面的检查没意义
  const reaching = result.lines.filter(
    (line) =>
      /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(line.text) && line.right > result.right - 20,
  );
  expect(reaching.length, `${label}: no CJK row reaches the right edge`).toBeGreaterThan(0);
}
