#!/usr/bin/env node
/**
 * 由 build/icon.svg 生成各平台的应用图标：icon.png（Linux）、icon.icns（macOS）、icon.ico（Windows）。
 * 图标改了才需要重跑；生成的文件随源码提交，打包时不再依赖这个脚本。
 * icns 用 macOS 自带的 sips + iconutil，只能在 macOS 上生成。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(desktopDir, "build");
const require = createRequire(import.meta.url);
const electron = require("electron");
const png = path.join(buildDir, "icon.png");

execFileSync(
  electron,
  [path.join(desktopDir, "scripts/render-icon.cjs"), path.join(buildDir, "icon.svg"), png],
  {
    stdio: "inherit",
  },
);

if (process.platform !== "darwin") {
  console.log("[icons] icon.png done; icon.icns / icon.ico need macOS (sips, iconutil)");
  process.exit(0);
}

const work = path.join(os.tmpdir(), `superhive-icons-${process.pid}`);
const iconset = path.join(work, "icon.iconset");
mkdirSync(iconset, { recursive: true });
const resize = (size, file) =>
  execFileSync("sips", ["-z", String(size), String(size), png, "--out", file], { stdio: "ignore" });
for (const size of [16, 32, 128, 256, 512]) {
  resize(size, path.join(iconset, `icon_${size}x${size}.png`));
  resize(size * 2, path.join(iconset, `icon_${size}x${size}@2x.png`));
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(buildDir, "icon.icns")]);

// ICO：直接把几张 PNG 打进去（Vista 起支持 PNG 格式的条目）
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => {
  const file = path.join(work, `ico-${size}.png`);
  resize(size, file);
  return readFileSync(file);
});
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, index) => {
  const entry = 6 + index * 16;
  header.writeUInt8(size >= 256 ? 0 : size, entry);
  header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
  header.writeUInt8(0, entry + 2);
  header.writeUInt8(0, entry + 3);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[index].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
});
writeFileSync(path.join(buildDir, "icon.ico"), Buffer.concat([header, ...images]));
rmSync(work, { recursive: true, force: true });
console.log("[icons] wrote build/icon.png, icon.icns, icon.ico");
