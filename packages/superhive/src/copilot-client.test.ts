import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { CommandRunner } from "./command-runner.js";
import { CopilotResponder, copilotCloudFlag } from "./copilot-client.js";

const hive = {
  serverUrl: "http://localhost:8787",
  roomId: "general",
  username: "copilot-agent",
  token: "test-token",
};

/** 第一次调用是探测 --help，最后一次才是真正的执行 */
function lastRun(runner: { mock: { calls: Parameters<CommandRunner>[] } }) {
  return runner.mock.calls.at(-1);
}

const reply = JSON.stringify({ type: "assistant.message", data: { content: "ok" } });

describe("CopilotResponder", () => {
  it("passes the per-turn reasoning effort with --reasoning-effort only when one is set", async () => {
    const runner = vi.fn<CommandRunner>(async () => ({ stdout: reply, stderr: "" }));
    const responder = new CopilotResponder({ command: "copilot", cwd: "/workspace", hive, runner });
    await responder.reply({ instructions: "r", prompt: "p", effort: "high" });
    const args = lastRun(runner)?.[1] ?? [];
    expect(args[args.indexOf("--reasoning-effort") + 1]).toBe("high");
    await responder.reply({ instructions: "r", prompt: "p" });
    expect(lastRun(runner)?.[1]).not.toContain("--reasoning-effort");
  });

  it("uses a restricted plan session and parses Copilot JSONL", async () => {
    let mcpConfig: { content: string; mode: number } | undefined;
    const runner = vi.fn<CommandRunner>(async (_command, args) => {
      const file = args[args.indexOf("--additional-mcp-config") + 1]!.slice(1);
      mcpConfig = { content: readFileSync(file, "utf8"), mode: statSync(file).mode & 0o777 };
      return {
        stdout: [
          "non-json diagnostic",
          JSON.stringify({
            type: "session.start",
            data: { sessionId: "11111111-1111-4111-8111-111111111111" },
          }),
          JSON.stringify({
            type: "assistant.message",
            data: { content: "来自 Copilot 的回复" },
          }),
        ].join("\n"),
        stderr: "",
      };
    });
    const responder = new CopilotResponder({
      command: "copilot",
      cwd: "/workspace",
      hive,
      model: "gpt-5",
      runner,
    });

    await expect(
      responder.reply({
        instructions: "Hive rules",
        prompt: "Shared context",
        threadId: "00000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toEqual({
      text: "来自 Copilot 的回复",
      threadId: "11111111-1111-4111-8111-111111111111",
    });
    const args = lastRun(runner)?.[1] ?? [];
    expect(args).toContain("--mode");
    expect(args).toContain("plan");
    expect(args).toContain("--deny-tool=write");
    expect(args).toContain("--deny-tool=shell");
    expect(args).toContain("--disable-builtin-mcps");
    expect(args).toContain("--additional-mcp-config");
    expect(args).toContain("--allow-tool=hive");
    // Hive token 只在权限 600 的临时配置文件里（@路径），跑完就删；命令行参数里不能出现
    expect(args.join(" ")).not.toContain("test-token");
    expect(JSON.parse(mcpConfig!.content)).toMatchObject({
      mcpServers: { hive: { headers: { Authorization: "Bearer test-token" } } },
    });
    if (process.platform !== "win32") expect(mcpConfig!.mode).toBe(0o600);
    expect(existsSync(args[args.indexOf("--additional-mcp-config") + 1]!.slice(1))).toBe(false);
    expect(args).toContain("--resume=00000000-0000-4000-8000-000000000001");
    expect(args).toContain("gpt-5");
    // 提示走标准输入，不进命令行（Windows 命令行有长度上限）
    expect(args).not.toContain("--prompt");
    expect(args.join(" ")).not.toContain("Shared context");
    expect(lastRun(runner)?.[2]).toMatchObject({ input: "Shared context" });
  });

  it("只读、工作区档用 --add-dir 放行附件缓存目录，只读档照旧拒绝写和命令", async () => {
    const runner = vi.fn<CommandRunner>(async () => ({
      stdout: JSON.stringify({ type: "assistant.message", data: { content: "ok" } }),
      stderr: "",
    }));
    for (const access of ["read-only", "workspace", "full"] as const) {
      await new CopilotResponder({
        command: "copilot",
        cwd: "/workspace",
        hive,
        access,
        attachmentDir: "/c/att",
        runner,
      }).reply({ instructions: "r", prompt: "p" });
      const args = lastRun(runner)?.[1] ?? [];
      if (access === "full") expect(args.join(" ")).not.toContain("--add-dir");
      else expect(args).toContain("--add-dir=/c/att");
      if (access === "read-only") expect(args).toContain("--deny-tool=write");
    }
  });

  it("starts a new session with --session-id when there is no prior threadId", async () => {
    const runner = vi.fn<CommandRunner>(async () => ({
      stdout: JSON.stringify({ type: "assistant.message", data: { content: "ok" } }),
      stderr: "",
    }));
    const responder = new CopilotResponder({
      command: "copilot",
      cwd: "/workspace",
      hive,
      runner,
    });

    await responder.reply({ instructions: "rules", prompt: "context" });

    const args = lastRun(runner)?.[1] ?? [];
    expect(args.some((arg) => arg.startsWith("--session-id="))).toBe(true);
    expect(args.some((arg) => arg.startsWith("--resume="))).toBe(false);
  });

  it.each(["workspace", "full"] as const)("maps %s access to Copilot", async (access) => {
    const runner = vi.fn<CommandRunner>(async () => ({
      stdout: JSON.stringify({ type: "assistant.message", data: { content: "ok" } }),
      stderr: "",
    }));
    const responder = new CopilotResponder({
      command: "copilot",
      cwd: "/workspace",
      hive,
      access,
      runner,
    });

    await responder.reply({ instructions: "rules", prompt: "context" });

    const args = lastRun(runner)?.[1] ?? [];
    expect(args[args.indexOf("--mode") + 1]).toBe("interactive");
    if (access === "workspace") {
      expect(args).toContain("--allow-tool=write");
      expect(args).toContain("--allow-tool=shell");
      expect(args).toContain("--disallow-temp-dir");
      expect(args).not.toContain("--allow-all");
    } else {
      expect(args).toContain("--allow-all");
      expect(args).not.toContain("--disable-builtin-mcps");
      // 完全访问档不探测、也不加云端相关的参数
      expect(runner).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ["1.0.114", "  --sync-session[=<on|off>]\n  --connect [<sessionId>]", "--sync-session=off"],
    ["1.0.90", "  --no-remote  Disable remote\n  --no-remote-export", "--no-remote"],
    ["unknown", "  --mode <mode>", undefined],
  ])("picks the cloud flag Copilot %s supports", async (_version, help, flag) => {
    const runner = vi.fn<CommandRunner>(async (_command, args) => ({
      stdout: args.includes("--help") ? help : reply,
      stderr: "",
    }));
    const responder = new CopilotResponder({ command: "copilot", cwd: "/w", hive, runner });

    await responder.reply({ instructions: "rules", prompt: "context" });
    await responder.reply({ instructions: "rules", prompt: "again", threadId: "t" });

    const probes = runner.mock.calls.filter(([, args]) => args.includes("--help"));
    expect(probes).toHaveLength(1);
    const args = lastRun(runner)?.[1] ?? [];
    for (const candidate of ["--sync-session=off", "--no-remote"]) {
      expect(args.includes(candidate)).toBe(candidate === flag);
    }
  });

  it("re-probes and retries once when an upgraded Copilot rejects the cached flag", async () => {
    let helpText = "  --no-remote  Disable remote";
    const runner = vi.fn<CommandRunner>(async (_command, args) => {
      if (args.includes("--help")) return { stdout: helpText, stderr: "" };
      if (args.includes("--no-remote")) {
        helpText = "  --sync-session[=<on|off>]";
        throw new Error(
          "error: --no-remote was removed. Use /remote off in a session; manage incoming connections in /environments.",
        );
      }
      return { stdout: reply, stderr: "" };
    });
    const responder = new CopilotResponder({
      command: "copilot",
      cwd: "/w",
      hive,
      access: "workspace",
      runner,
    });
    await expect(responder.reply({ instructions: "r", prompt: "p" })).resolves.toMatchObject({
      text: "ok",
    });
    // 第一次探测拿到老参数被拒，作废后重新探测（这时 CLI 已升级）
    expect(runner.mock.calls.filter(([, args]) => args.includes("--help"))).toHaveLength(2);
    expect(lastRun(runner)?.[1]).toContain("--sync-session=off");
  });

  it("still runs when the --help probe itself fails", async () => {
    const runner = vi.fn<CommandRunner>(async (_command, args) => {
      if (args.includes("--help")) throw new Error("spawn copilot ENOENT");
      return { stdout: reply, stderr: "" };
    });
    const responder = new CopilotResponder({ command: "copilot", cwd: "/w", hive, runner });
    await expect(responder.reply({ instructions: "r", prompt: "p" })).resolves.toMatchObject({
      text: "ok",
    });
  });

  it("parses the cloud flag from real help excerpts", () => {
    expect(copilotCloudFlag("--sync-session[=<on|off>]\n--no-remote")).toBe("--sync-session=off");
    expect(copilotCloudFlag("--no-remote-export")).toBeUndefined();
  });

  it("rejects output without a final assistant message", async () => {
    const responder = new CopilotResponder({
      command: "copilot",
      cwd: "/workspace",
      hive,
      runner: async () => ({ stdout: "{}\n", stderr: "no response" }),
    });
    await expect(responder.reply({ instructions: "rules", prompt: "context" })).rejects.toThrow(
      /没有返回/,
    );
  });
});
