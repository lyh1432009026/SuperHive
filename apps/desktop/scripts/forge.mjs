#!/usr/bin/env node
/**
 * 在 .stage/app 里跑 Electron Forge（package / make）。
 * stage 目录的依赖是用 npm 装的扁平 node_modules；但从 pnpm 仓库里调用时，Forge 会按外层的
 * pnpm 去做「node-linker 必须是 hoisted」的检查。这里明确告诉它这个目录用的是 npm。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const cli = require.resolve("@electron-forge/cli/dist/electron-forge.js");
const npmVersion = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["-v"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
  shell: process.platform === "win32",
}).trim();
const [command = "package", ...rest] = process.argv.slice(2);
const stageDir = path.join(desktopDir, ".stage/app");
// 在 stage 目录里运行：Forge 以当前目录为要打包的项目
const result = spawnSync(process.execPath, [cli, command, ...rest], {
  stdio: "inherit",
  cwd: stageDir,
  env: {
    ...process.env,
    SUPERHIVE_DESKTOP_DIR: desktopDir,
    npm_config_user_agent: `npm/${npmVersion} node/${process.version}`,
  },
});
process.exit(result.status ?? 1);
