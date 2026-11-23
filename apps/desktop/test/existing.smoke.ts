/**
 * 已经有 `hive start` 起的 Hive 在跑：桌面端直接连上它，不再起第二个；退出桌面端也不停它。
 */
import { _electron as electron, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { desktopDir, serverAlive } from "./flows.js";

const cli = path.join(desktopDir, ".stage/app/superhive/dist/cli.js");

test("connects to the Hive that hive start is already running", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "superhive-desktop-existing-"));
  const port = 18_500 + Math.floor(Math.random() * 90);
  const env = { ...process.env, HIVE_NO_OPEN: "1" };
  execFileSync(
    process.execPath,
    [cli, "start", "--data-dir", dataDir, "--port", String(port), "--no-open"],
    {
      env,
      stdio: "ignore",
    },
  );
  try {
    expect(await serverAlive(port)).toBe(true);
    const app = await electron.launch({
      args: [path.join(desktopDir, ".stage/app")],
      // 首选端口故意给另一个：要按 server.json 找到 hive start 起的那个
      env: {
        ...env,
        SUPERHIVE_DESKTOP_DATA_DIR: dataDir,
        SUPERHIVE_DESKTOP_PORT: String(port + 1),
      } as Record<string, string>,
    });
    let url = "";
    await expect
      .poll(
        () => {
          url =
            app
              .windows()
              .find((win) => win.url().startsWith("http://127.0.0.1:"))
              ?.url() ?? "";
          return url;
        },
        { timeout: 60_000 },
      )
      .not.toBe("");
    expect(new URL(url).port).toBe(String(port));
    expect(await serverAlive(port + 1)).toBe(false);
    await app.close();
    // 不是桌面端起的，退出时不停
    expect(await serverAlive(port)).toBe(true);
  } finally {
    execFileSync(process.execPath, [cli, "stop", "--data-dir", dataDir], { env, stdio: "ignore" });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
