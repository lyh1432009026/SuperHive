import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dependencyPlan, prepareDependencies, runInstall } from "./worktree-deps.js";

describe("worktree dependencies", () => {
  let root: string;
  let primary: string;
  let worktree: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "hive-deps-")));
    primary = path.join(root, "repo");
    worktree = path.join(root, "repo-wt", "agent-task");
    for (const base of [primary, worktree]) {
      mkdirSync(path.join(base, "packages", "protocol"), { recursive: true });
      mkdirSync(path.join(base, "apps", "server"), { recursive: true });
      writeFileSync(path.join(base, "package.json"), "{}\n");
      writeFileSync(path.join(base, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    }
    // 主目录里 pnpm 装好的样子：第三方包在 .pnpm 里，workspace 包是相对链接
    const modules = path.join(primary, "node_modules");
    mkdirSync(path.join(modules, ".pnpm", "left-pad@1.0.0", "node_modules", "left-pad"), {
      recursive: true,
    });
    symlinkSync(".pnpm/left-pad@1.0.0/node_modules/left-pad", path.join(modules, "left-pad"));
    mkdirSync(path.join(modules, "@types", "node"), { recursive: true });
    mkdirSync(path.join(modules, "@superhive"), { recursive: true });
    symlinkSync("../../packages/protocol", path.join(modules, "@superhive", "protocol"));
    mkdirSync(path.join(modules, ".bin"));
    writeFileSync(path.join(modules, ".modules.yaml"), "layoutVersion: 5\n");
    const server = path.join(primary, "apps", "server", "node_modules", "@superhive");
    mkdirSync(server, { recursive: true });
    symlinkSync("../../../../packages/protocol", path.join(server, "protocol"));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const packageDirs = ["", "apps/server", "packages/protocol"];

  it("picks the lockfile's package manager without touching the lockfile", async () => {
    expect(await dependencyPlan(worktree)).toMatchObject({
      manager: "pnpm",
      args: ["install", "--frozen-lockfile", "--prefer-offline"],
    });
    rmSync(path.join(worktree, "pnpm-lock.yaml"));
    writeFileSync(path.join(worktree, "package-lock.json"), "{}");
    expect(await dependencyPlan(worktree)).toMatchObject({ manager: "npm", command: "npm" });
    writeFileSync(path.join(worktree, "yarn.lock"), "");
    expect(await dependencyPlan(worktree)).toMatchObject({
      manager: "yarn",
      args: ["install", "--frozen-lockfile", "--prefer-offline"],
    });
    writeFileSync(path.join(worktree, ".yarnrc.yml"), "");
    expect((await dependencyPlan(worktree))?.args).toEqual(["install", "--immutable"]);
    for (const file of ["package-lock.json", "yarn.lock"]) rmSync(path.join(worktree, file));
    expect(await dependencyPlan(worktree)).toBeUndefined();
  });

  it("installs in the worktree", async () => {
    const run = vi.fn(async () => ({ code: 0, output: "done" }));
    expect(await prepareDependencies({ worktree, primary, packageDirs, run })).toEqual({
      state: "installed",
      manager: "pnpm",
      command: "pnpm install --frozen-lockfile --prefer-offline",
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ manager: "pnpm" }),
      worktree,
      expect.any(Number),
      undefined,
    );
  });

  it("falls back to linking the primary checkout's modules with workspace packages pointing here", async () => {
    const run = vi.fn(async (_plan, cwd: string) => {
      // 装到一半失败，留下半截目录
      mkdirSync(path.join(cwd, "node_modules", "half"), { recursive: true });
      return { code: 1, output: "ERR_PNPM_OUTDATED_LOCKFILE" };
    });
    const result = await prepareDependencies({ worktree, primary, packageDirs, run });
    expect(result).toMatchObject({
      state: "linked",
      reason: "exit",
      output: "ERR_PNPM_OUTDATED_LOCKFILE",
    });
    const modules = path.join(worktree, "node_modules");
    expect(lstatSync(modules).isSymbolicLink()).toBe(false);
    expect(existsSync(path.join(modules, "half"))).toBe(false);
    expect(realpathSync(path.join(modules, "left-pad"))).toBe(
      path.join(primary, "node_modules", ".pnpm", "left-pad@1.0.0", "node_modules", "left-pad"),
    );
    expect(realpathSync(path.join(modules, "@types", "node"))).toBe(
      path.join(primary, "node_modules", "@types", "node"),
    );
    expect(lstatSync(path.join(modules, "@types")).isSymbolicLink()).toBe(false);
    expect(realpathSync(path.join(modules, ".modules.yaml"))).toBe(
      path.join(primary, "node_modules", ".modules.yaml"),
    );
    // workspace 包指回本任务线，而不是主目录的旧代码
    expect(realpathSync(path.join(modules, "@superhive", "protocol"))).toBe(
      path.join(worktree, "packages", "protocol"),
    );
    expect(readlinkSync(path.join(modules, "@superhive", "protocol"))).toBe(
      path.join("..", "..", "packages", "protocol"),
    );
    expect(
      realpathSync(path.join(worktree, "apps", "server", "node_modules", "@superhive", "protocol")),
    ).toBe(path.join(worktree, "packages", "protocol"));
    // 主目录一个字节都没动
    expect(readlinkSync(path.join(primary, "node_modules", "@superhive", "protocol"))).toBe(
      "../../packages/protocol",
    );
  });

  it("links without installing when there is no lockfile", async () => {
    rmSync(path.join(worktree, "pnpm-lock.yaml"));
    const run = vi.fn();
    expect(await prepareDependencies({ worktree, primary, packageDirs, run })).toEqual({
      state: "linked",
      reason: "noLockfile",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("fails cleanly when nothing can be linked", async () => {
    rmSync(path.join(primary, "node_modules"), { recursive: true });
    const result = await prepareDependencies({
      worktree,
      primary,
      packageDirs,
      run: async () => ({ code: null, output: "", timedOut: true }),
    });
    expect(result).toMatchObject({ state: "failed", reason: "timeout" });
    expect(existsSync(path.join(worktree, "node_modules"))).toBe(false);
  });

  it("does not fall back to linking when the server is closing", async () => {
    const controller = new AbortController();
    const result = await prepareDependencies({
      worktree,
      primary,
      packageDirs,
      signal: controller.signal,
      run: async (_plan, cwd) => {
        mkdirSync(path.join(cwd, "node_modules", "half"), { recursive: true });
        controller.abort();
        return { code: null, output: "" };
      },
    });
    expect(result).toEqual({ state: "failed", reason: "error" });
    expect(existsSync(path.join(worktree, "node_modules"))).toBe(false);
  });

  it("leaves existing dependencies and non-Node projects alone", async () => {
    const run = vi.fn();
    mkdirSync(path.join(worktree, "apps", "server", "node_modules"));
    expect(await prepareDependencies({ worktree, primary, packageDirs, run })).toEqual({
      state: "skipped",
      reason: "present",
    });
    rmSync(path.join(worktree, "package.json"));
    expect(await prepareDependencies({ worktree, primary, packageDirs, run })).toEqual({
      state: "skipped",
      reason: "notNode",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("kills an install that runs past its time limit or when the server closes, and reports a missing command", async () => {
    const slow = await runInstall(
      { manager: "npm", command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"] },
      worktree,
      200,
    );
    expect(slow).toMatchObject({ code: null, timedOut: true });
    const missing = await runInstall(
      { manager: "pnpm", command: "hive-no-such-package-manager", args: [] },
      worktree,
      5000,
    );
    expect(missing.code).toBeNull();
    expect(missing.timedOut).toBeUndefined();
    const controller = new AbortController();
    const started = Date.now();
    const stopped = runInstall(
      { manager: "npm", command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"] },
      worktree,
      60_000,
      controller.signal,
    );
    controller.abort();
    expect(await stopped).toMatchObject({ code: null });
    expect(Date.now() - started).toBeLessThan(5000);
    const ok = await runInstall(
      { manager: "npm", command: process.execPath, args: ["-e", "console.log(process.cwd())"] },
      worktree,
      5000,
    );
    expect(ok).toMatchObject({ code: 0 });
    expect(ok.output.trim()).toBe(worktree);
  });
});
