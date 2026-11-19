import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { forbiddenPaths, HOOKS_PATH, installHooks, trackedPaths } from "./git-hooks.mjs";

const workspace = path.resolve(import.meta.dirname, "..");

function repository() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hive-hooks-")));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  // 用本仓库的钩子和脚本
  fs.cpSync(path.join(workspace, HOOKS_PATH), path.join(dir, HOOKS_PATH), { recursive: true });
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(
    path.join(workspace, "scripts", "git-hooks.mjs"),
    path.join(dir, "scripts", "git-hooks.mjs"),
  );
  return { dir, git };
}

test("node_modules 在路径任何一段都算", () => {
  assert.deepEqual(
    forbiddenPaths([
      "node_modules",
      "packages/protocol/node_modules",
      "apps/web/node_modules/react/index.js",
      "apps\\web\\node_modules",
      "src/node_modules_helper.ts",
      "docs/node-modules.md",
    ]),
    [
      "node_modules",
      "packages/protocol/node_modules",
      "apps/web/node_modules/react/index.js",
      "apps\\web\\node_modules",
    ],
  );
});

test("本仓库已提交的文件里没有 node_modules", () => {
  assert.deepEqual(forbiddenPaths(trackedPaths(workspace)), []);
});

test("pre-commit 拒绝暂存的 node_modules 软链，普通文件照常提交", (t) => {
  const { dir, git } = repository();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(installHooks(dir), "installed");
  assert.equal(git("config", "--get", "core.hooksPath").trim(), HOOKS_PATH);
  fs.mkdirSync(path.join(dir, "packages", "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "packages", "lib", "index.js"), "export {};\n");
  fs.symlinkSync(dir, path.join(dir, "packages", "lib", "node_modules"));
  // 2026-11-19 那次：git add 目录把软链一起带进了暂存区（这里用 -f 模拟绕过 .gitignore）
  git("add", "-f", "packages", HOOKS_PATH, "scripts");
  const refused = spawnSync("git", ["commit", "-m", "with node_modules"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /packages\/lib\/node_modules/);
  git("rm", "-q", "--cached", "packages/lib/node_modules");
  git("commit", "-q", "-m", "clean");
  assert.deepEqual(forbiddenPaths(trackedPaths(dir)), []);
});

test("已有自己的钩子或 core.hooksPath 时不覆盖", (t) => {
  const { dir, git } = repository();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git("config", "core.hooksPath", "/somewhere/else");
  assert.equal(installHooks(dir), "custom-hooks-path");
  assert.equal(git("config", "--get", "core.hooksPath").trim(), "/somewhere/else");
  git("config", "--unset", "core.hooksPath");
  fs.writeFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  assert.equal(installHooks(dir), "custom-hooks");
  assert.throws(() => git("config", "--get", "core.hooksPath"));
});

test("不在 Git 仓库里（比如从压缩包安装）时什么都不做", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-hooks-plain-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(installHooks(dir), "not-a-repository");
});
