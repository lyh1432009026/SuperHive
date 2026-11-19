import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { packageRootOf } from "./update.js";

/**
 * 本进程运行的代码版本，加入房间时上报给 Server（见协议 agentCodeVersionSchema）。
 * 进程启动时算一次：tsx 跑源码时代码在启动时就加载好了，之后仓库再怎么变，这个进程跑的仍是这一份。
 * 算法要与 Server 端 apps/server/src/code-version.ts 一致，两边的指纹才能直接比较。
 */
export type AgentCodeVersion = { package: string; commit?: string; fingerprint?: string };

export type GitRunner = (cwd: string, args: string[]) => string;

const defaultGit: GitRunner = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });

/** 源码运行时 packageRoot 是 <仓库>/packages/superhive；npm 安装时是 …/node_modules/superhive，没有 git 信息 */
export function codeVersionAt(packageRoot: string, git: GitRunner = defaultGit): AgentCodeVersion {
  let version = "0.0.0";
  try {
    version =
      (
        JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
          version?: string;
        }
      ).version ?? version;
  } catch {
    /* 读不到按 0.0.0 */
  }
  const result: AgentCodeVersion = { package: version };
  if (
    path.basename(packageRoot) !== "superhive" ||
    path.basename(path.dirname(packageRoot)) !== "packages"
  ) {
    return result;
  }
  try {
    const [commit, superhive, protocol] = git(path.dirname(path.dirname(packageRoot)), [
      "rev-parse",
      "HEAD",
      "HEAD:packages/superhive",
      "HEAD:packages/protocol",
    ])
      .trim()
      .split("\n")
      .map((line) => line.trim());
    if (commit && superhive && protocol && /^[0-9a-f]{7,64}$/.test(commit)) {
      result.commit = commit;
      result.fingerprint = `${superhive.slice(0, 16)}.${protocol.slice(0, 16)}`;
    }
  } catch {
    /* 不是 git 仓库或没装 git：只报包版本 */
  }
  return result;
}

let running: AgentCodeVersion | undefined;

/** 本进程的版本（第一次调用时计算并记住；run.ts 在启动时就调用一次） */
export function runningCodeVersion(): AgentCodeVersion {
  running ??= codeVersionAt(packageRootOf(fileURLToPath(import.meta.url)));
  return running;
}
