#!/usr/bin/env node
/**
 * 仓库的 Git 钩子：提交前拒绝任何 node_modules 路径（2026-11-19 曾把软链的 node_modules
 * 提交进 main，合入后主目录依赖指向自己、网页白屏）。
 *
 *   node scripts/git-hooks.mjs install     pnpm install 时自动跑（package.json 的 prepare）：
 *                                          core.hooksPath 没设过就指向 .githooks，设过的不改
 *   node scripts/git-hooks.mjs pre-commit  .githooks/pre-commit 调用：检查暂存区
 *   node scripts/git-hooks.mjs check       检查已提交的文件（pnpm test 里也会跑）
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOOKS_PATH = ".githooks";

/** 路径里任何一段是 node_modules 就不许进提交（目录、同名软链、里面的文件都算） */
export function forbiddenPaths(paths) {
  return paths.filter((file) => file.split(/[\\/]/).includes("node_modules"));
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function list(output) {
  return output.split("\0").filter(Boolean);
}

export function stagedPaths(cwd) {
  return list(git(cwd, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRT"]));
}

export function trackedPaths(cwd) {
  return list(git(cwd, ["ls-files", "-z"]));
}

function report(found, where) {
  console.error(`✖ ${where}有 node_modules 路径，拒绝提交：`);
  for (const file of found.slice(0, 20)) console.error(`    ${file}`);
  if (found.length > 20) console.error(`    …共 ${found.length} 个`);
  console.error(
    "  依赖目录（包括软链过来的）不能进仓库。用 git restore --staged <路径> 撤出暂存区，只 git add 具体改动文件。",
  );
}

/** 返回要提示的话；没设过 core.hooksPath 才设，用户自己的钩子不覆盖 */
export function installHooks(cwd) {
  if (process.env.HIVE_SKIP_GIT_HOOKS === "1") return "skipped";
  let common;
  try {
    common = path.resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]).trim());
  } catch {
    return "not-a-repository";
  }
  let current = "";
  try {
    current = git(cwd, ["config", "--get", "core.hooksPath"]).trim();
  } catch {
    // 没设过
  }
  if (current === HOOKS_PATH) return "installed";
  if (current) return "custom-hooks-path";
  const hooks = path.join(common, "hooks");
  const own = fs.existsSync(hooks)
    ? fs.readdirSync(hooks).filter((name) => !name.endsWith(".sample"))
    : [];
  if (own.length) return "custom-hooks";
  // 相对路径：每个 worktree 用自己检出的 .githooks
  git(cwd, ["config", "core.hooksPath", HOOKS_PATH]);
  return "installed";
}

function main(command) {
  const cwd = process.cwd();
  if (command === "install") {
    const result = installHooks(cwd);
    if (result === "custom-hooks-path" || result === "custom-hooks")
      console.warn(
        `已有自己的 Git 钩子，没有启用 ${HOOKS_PATH}/pre-commit（提交前拒绝 node_modules）。需要的话在你的钩子里调用 node scripts/git-hooks.mjs pre-commit。`,
      );
    return 0;
  }
  if (command === "pre-commit" || command === "check") {
    const found = forbiddenPaths(command === "check" ? trackedPaths(cwd) : stagedPaths(cwd));
    if (!found.length) return 0;
    report(found, command === "check" ? "仓库里" : "暂存区里");
    return 1;
  }
  console.error("用法：node scripts/git-hooks.mjs install | pre-commit | check");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv[2]);
