import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
// fileURLToPath：Windows 上 URL.pathname 是 /C:/...，不能当本机路径用
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

async function runCli(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", cliPath, ...args]);
  return stdout;
}

// 每个用例都要冷启动 node + tsx，Windows 上单次要 3–4 秒
describe("service CLI", { timeout: 60_000 }, () => {
  it("lists restart in the top-level help", async () => {
    await expect(runCli("--help")).resolves.toContain("hive restart [选项]");
  });

  it("starts the server when run bare or with only options, and accepts off for stop", async () => {
    // npx superhive / npx superhive --port 9000：走 start（这里带 -h 只看它进了 start 的说明）
    await expect(runCli("--port", "9000", "-h")).resolves.toContain("--no-open");
    await expect(runCli("--help")).resolves.toContain("hive [选项]");
    await expect(runCli("off", "--help")).resolves.toContain("--data-dir");
  });

  it("lists the skill subcommands in the top-level help", async () => {
    await expect(runCli("--help")).resolves.toContain("hive skill install [claude|codex|openclaw]");
  });

  it("documents restart configuration reuse and overrides", async () => {
    const output = await runCli("restart", "--help");
    expect(output).toContain("默认沿用上次启动时的 host、port 和 public-url");
    expect(output).toContain("--foreground");
  });

  it("prints the bundled SKILL.md for --skill", async () => {
    const output = await runCli("--skill");
    expect(output.startsWith("---\nname: superhive\n")).toBe(true);
    expect(output).toContain("hive join");
    // 房间规则与 /agent.md 同源
    expect(output).toContain("只有被明确 @ 时才回复");
  });

  it("documents the all-rooms default for join", async () => {
    const output = await runCli("join", "--help");
    expect(output).toContain("省略时加入服务器上所有未归档房间");
  });
});
