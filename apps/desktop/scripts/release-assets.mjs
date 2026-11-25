#!/usr/bin/env node
/**
 * 发版时把这台机器打出来的安装包和应用内更新包收到一个目录里，算好 sha256，
 * 并打印上传到 GitHub Release 的命令（只打印，不上传）。
 *
 *   pnpm --filter @superhive/desktop make        # 先打包
 *   node apps/desktop/scripts/release-assets.mjs # 再收集
 *
 * Mac 上收：SuperHive-<版本>-arm64.dmg（第一次安装）和 SuperHive-darwin-arm64-<版本>.zip（应用内更新）；
 * Windows 上收：SuperHive-<版本>-win-x64-Setup.exe（第一次安装）、RELEASES 和 SuperHive-<版本>-full.nupkg（应用内更新）。
 * 少了应用内更新要用的文件时报错退出：没传它们，客户端只能退回「打开下载页」。
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8"));
const make = path.join(desktopDir, "out/make");
const platform = process.argv[2] ?? process.platform;

/** 每个平台要上传的文件：[打包产物路径, 是否应用内更新要用] */
export function expectedAssets(platformName, ver) {
  if (platformName === "darwin") {
    return [
      [`dmg/arm64/SuperHive-${ver}-arm64.dmg`, false],
      [`zip/darwin/arm64/SuperHive-darwin-arm64-${ver}.zip`, true],
    ];
  }
  if (platformName === "win32") {
    return [
      [`squirrel.windows/x64/SuperHive-${ver}-win-x64-Setup.exe`, false],
      ["squirrel.windows/x64/RELEASES", true],
      [`squirrel.windows/x64/SuperHive-${ver}-full.nupkg`, true],
    ];
  }
  return [];
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function main() {
  const assets = expectedAssets(platform, version);
  if (!assets.length) {
    console.error(`${platform} 现在没有要发的安装包（只发 mac arm64 和 Windows x64）`);
    process.exit(1);
  }
  const missing = assets.filter(([file]) => !existsSync(path.join(make, file)));
  if (missing.length) {
    console.error(`缺少这些打包产物（先运行 pnpm --filter @superhive/desktop make）：`);
    for (const [file, forUpdate] of missing)
      console.error(`  out/make/${file}${forUpdate ? "  ← 应用内更新要用" : ""}`);
    process.exit(1);
  }
  const outDir = path.join(desktopDir, "out/release", version);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const names = [];
  for (const [file] of assets) {
    const name = path.basename(file);
    const dest = path.join(outDir, name);
    copyFileSync(path.join(make, file), dest);
    names.push(name);
    console.log(`${await sha256(dest)}  ${name}`);
  }
  console.log(`\n已收集到 ${path.relative(process.cwd(), outDir) || "."}`);
  console.log("确认无误后上传（会覆盖同名文件）：");
  const quoted = names.map((name) => JSON.stringify(path.join(outDir, name))).join(" ");
  console.log(`  gh release upload v${version} ${quoted} --clobber`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
