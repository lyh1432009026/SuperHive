import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Windows 上 Hive Server、本机 Agent 都是没有可见控制台的后台进程：它们拉起控制台程序时只要漏写
 * windowsHide，就会新开一个可见的终端窗口（用户看到一层层黑色空窗口）。这里扫一遍源码，
 * 每处 child_process 调用都得写 windowsHide，确实要开窗口的写进 ALLOWED 并说明原因。
 */
const ALLOWED: Record<string, string> = {
  // 「在终端打开」：本来就是要给房主开一个可见的终端窗口
  "open-terminal.ts": "opens a visible terminal on purpose",
};

const CALL = /(?<![.\w])(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\(/g;

function callText(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("child processes on Windows", () => {
  it("hide the console window of every child process", () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const missing: string[] = [];
    let calls = 0;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("node:child_process")) continue;
      for (const match of source.matchAll(CALL)) {
        const text = callText(source, match.index + match[1]!.length);
        calls += 1;
        const line = source.slice(0, match.index).split("\n").length;
        const where = `${path.relative(root, file)}:${line}`;
        if (text.includes("windowsHide")) continue;
        if (ALLOWED[path.relative(root, file).split(path.sep).join("/")]) continue;
        missing.push(`${where} ${match[1]}`);
      }
    }
    expect(calls).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
