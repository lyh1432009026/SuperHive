import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codeVersionAt, type GitRunner } from "./code-version.js";

function packageDir(...segments: string[]): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "hive-code-version-")), ...segments);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
  return dir;
}

describe("codeVersionAt", () => {
  it("源码运行：带上 HEAD 提交和 Agent 两个目录的树指纹", () => {
    const root = packageDir("repo", "packages", "superhive");
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const git: GitRunner = (cwd, args) => {
      calls.push({ cwd, args });
      return `${"a".repeat(40)}\n${"b".repeat(40)}\n${"c".repeat(40)}\n`;
    };
    expect(codeVersionAt(root, git)).toEqual({
      package: "1.2.3",
      commit: "a".repeat(40),
      fingerprint: `${"b".repeat(16)}.${"c".repeat(16)}`,
    });
    expect(calls).toEqual([
      {
        cwd: path.dirname(path.dirname(root)),
        args: ["rev-parse", "HEAD", "HEAD:packages/superhive", "HEAD:packages/protocol"],
      },
    ]);
  });

  it("npm 安装：只报包版本，不去跑 git", () => {
    const root = packageDir("lib", "node_modules", "superhive");
    let called = false;
    expect(
      codeVersionAt(root, () => {
        called = true;
        return "";
      }),
    ).toEqual({ package: "1.2.3" });
    expect(called).toBe(false);
  });

  it("git 不可用时退回只报包版本", () => {
    const root = packageDir("repo", "packages", "superhive");
    expect(
      codeVersionAt(root, () => {
        throw new Error("not a git repository");
      }),
    ).toEqual({ package: "1.2.3" });
  });
});
