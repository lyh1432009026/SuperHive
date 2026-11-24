/**
 * 打包时裁掉原生模块里用不到的东西：node-pty 和 better-sqlite3 的 npm 包里带着所有平台的预编译、
 * Windows 调试符号（.pdb）和 C++ 源码，原样打进去 Windows 包要多出约 90MB。
 * Forge 的 afterCopy 钩子在复制完应用、打 asar 之前调用，这里只删目标平台以外的文件。
 *
 * 纯函数 nativeExtras() 列出要删的路径（相对 node_modules），方便单测；prune() 真去删。
 */
const fs = require("node:fs");
const path = require("node:path");

/** better-sqlite3 13 的预编译名：<platform>[musl]-<arch>.node */
function betterSqliteKeep(platform, arch) {
  return new Set([`${platform}-${arch}.node`]);
}

/**
 * @param {(dir: string) => string[]} list 列出目录里的条目，目录不存在返回 []
 * @param {string} platform
 * @param {string} arch
 * @returns {string[]}
 */
function nativeExtras(list, platform, arch) {
  const remove = [];
  const target = `${platform}-${arch}`;
  for (const name of list("node-pty/prebuilds")) {
    if (name !== target) remove.push(`node-pty/prebuilds/${name}`);
  }
  for (const name of list(`node-pty/prebuilds/${target}`)) {
    if (name.endsWith(".pdb")) remove.push(`node-pty/prebuilds/${target}/${name}`);
  }
  const keepSqlite = betterSqliteKeep(platform, arch);
  for (const name of list("better-sqlite3/prebuilds")) {
    if (!keepSqlite.has(name)) remove.push(`better-sqlite3/prebuilds/${name}`);
  }
  // 运行时只用 lib/ 和预编译；源码、编译脚本、第三方源码都不需要
  for (const dir of ["node-pty/deps", "node-pty/src", "node-pty/third_party", "node-pty/scripts"]) {
    remove.push(dir);
  }
  for (const dir of ["better-sqlite3/deps", "better-sqlite3/src"]) {
    remove.push(dir);
  }
  return remove;
}

/** Forge packagerConfig.afterCopy 钩子 */
async function prune({ buildPath, platform, arch }) {
  const nodeModules = path.join(buildPath, "node_modules");
  const list = (dir) => {
    try {
      return fs.readdirSync(path.join(nodeModules, dir));
    } catch {
      return [];
    }
  };
  for (const relative of nativeExtras(list, platform, arch)) {
    fs.rmSync(path.join(nodeModules, relative), { recursive: true, force: true });
  }
}

module.exports = { nativeExtras, prune };
