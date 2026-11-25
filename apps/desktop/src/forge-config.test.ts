import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const desktopDir = path.resolve(import.meta.dirname, "..");

type Maker = { name: string; config?: unknown };

/** 和 scripts/stage.mjs 一样把配置和它依赖的脚本放到同一个目录再加载（目录放在 apps/desktop 下，依赖才解析得到） */
function loadForgeConfig(): { makers: Maker[] } {
  const stage = mkdtempSync(path.join(desktopDir, ".forge-config-test-"));
  const previous = process.env.SUPERHIVE_DESKTOP_DIR;
  try {
    copyFileSync(path.join(desktopDir, "forge.config.cjs"), path.join(stage, "forge.config.cjs"));
    copyFileSync(
      path.join(desktopDir, "scripts/prune-natives.cjs"),
      path.join(stage, "prune-natives.cjs"),
    );
    process.env.SUPERHIVE_DESKTOP_DIR = desktopDir;
    return createRequire(import.meta.url)(path.join(stage, "forge.config.cjs")) as {
      makers: Maker[];
    };
  } finally {
    if (previous === undefined) delete process.env.SUPERHIVE_DESKTOP_DIR;
    else process.env.SUPERHIVE_DESKTOP_DIR = previous;
    rmSync(stage, { recursive: true, force: true });
  }
}

describe("forge config", () => {
  it("names the Windows installer with the version and architecture", async () => {
    const { version } = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8")) as {
      version: string;
    };
    const squirrel = loadForgeConfig().makers.find(
      (maker) => maker.name === "@electron-forge/maker-squirrel",
    );
    expect(typeof squirrel?.config).toBe("function");
    const config = await (squirrel!.config as (arch: string) => unknown)("x64");
    expect(config).toEqual({
      name: "SuperHive",
      setupExe: `SuperHive-${version}-win-x64-Setup.exe`,
    });
    expect(await (squirrel!.config as (arch: string) => unknown)("arm64")).toMatchObject({
      setupExe: `SuperHive-${version}-win-arm64-Setup.exe`,
    });
  });
});

describe("scripts/release-assets.mjs", () => {
  it("收集的文件名和客户端认的更新包一致", async () => {
    const { pathToFileURL } = await import("node:url");
    const { macZipName, nupkgName, assetPattern } = await import("./update-check.js");
    const script = pathToFileURL(path.join(desktopDir, "scripts/release-assets.mjs")).href;
    const { expectedAssets } = (await import(script)) as {
      expectedAssets: (platform: string, version: string) => [string, boolean][];
    };
    const names = (platform: string) =>
      expectedAssets(platform, "1.2.3").map(([file]) => path.basename(file));
    const mac = names("darwin");
    expect(mac).toContain(macZipName("1.2.3"));
    expect(mac.some((name) => assetPattern("darwin", "arm64")!.test(name))).toBe(true);
    const win = names("win32");
    expect(win).toEqual(expect.arrayContaining(["RELEASES", nupkgName("1.2.3")]));
    expect(win.some((name) => assetPattern("win32", "x64")!.test(name))).toBe(true);
    expect(expectedAssets("linux", "1.2.3")).toEqual([]);
  });
});
