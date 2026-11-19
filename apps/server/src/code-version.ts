import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentCodeVersion } from "@superhive/protocol";
import { slowOps } from "./slow-ops.js";

/**
 * 本机 Agent 那份 superhive 代码「现在」的版本，用来判断在跑的 Agent 是不是旧的。
 * 算法要与 Bridge 端 packages/superhive/src/code-version.ts 一致（包版本 + 源码运行时的 HEAD 与树指纹），
 * 区别只是这里每次现读：合入、git pull、npm 升级之后不重启 Server 也能看出来。
 */
export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

const defaultGit: GitRunner = (cwd, args) =>
  slowOps.track("git rev-parse", { repo: cwd }, () => {
    return new Promise<string>((resolve, reject) =>
      execFile(
        "git",
        ["-C", cwd, ...args],
        { encoding: "utf8", timeout: 5_000, windowsHide: true },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      ),
    );
  });

export async function codeVersionAt(
  packageRoot: string,
  git: GitRunner = defaultGit,
): Promise<AgentCodeVersion | undefined> {
  let version: string | undefined;
  try {
    version = (
      JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as {
        version?: string;
      }
    ).version;
  } catch {
    return undefined;
  }
  if (!version) return undefined;
  const result: AgentCodeVersion = { package: version };
  if (
    path.basename(packageRoot) !== "superhive" ||
    path.basename(path.dirname(packageRoot)) !== "packages"
  ) {
    return result;
  }
  try {
    const [commit, superhive, protocol] = (
      await git(path.dirname(path.dirname(packageRoot)), [
        "rev-parse",
        "HEAD",
        "HEAD:packages/superhive",
        "HEAD:packages/protocol",
      ])
    )
      .trim()
      .split("\n")
      .map((line) => line.trim());
    if (commit && superhive && protocol && /^[0-9a-f]{7,64}$/.test(commit)) {
      result.commit = commit;
      result.fingerprint = `${superhive.slice(0, 16)}.${protocol.slice(0, 16)}`;
    }
  } catch {
    /* 不是 git 仓库或没装 git：只比包版本 */
  }
  return result;
}

/**
 * 本机 Agent CLI 入口（src/cli.ts 或 dist/cli.js）所在的包目录。
 * 命令行参数里最后一个以 cli.ts / cli.js 结尾的就是入口。
 */
export function packageRootOfCli(args: string[]): string | undefined {
  const entry = [...args].reverse().find((arg) => /[\\/]cli\.[jt]s$/.test(arg));
  return entry ? path.dirname(path.dirname(entry)) : undefined;
}
