import { describe, expect, it } from "vitest";
import { ClaudeCodeResponder } from "./claude-client.js";
import type { CommandRunner } from "./command-runner.js";
import { claudeKeepAliveMs } from "./run.js";

const hive = {
  serverUrl: "http://localhost:8787",
  roomId: "general",
  username: "claude-agent",
  token: "test-token",
};

type FakeProcess = {
  args: string[];
  prompts: string[];
  ended: boolean;
  killed: boolean;
  /** 进程自己退出（崩溃、被外部结束） */
  crash: () => void;
};

/**
 * 假的 Claude 进程：每收到一条用户消息就答一轮（result 带会话 ID）；输入关闭就退出。
 * reply 里写 "fail" 时返回 is_error 的结果。
 */
function fakeClaude(session = "s1") {
  const processes: FakeProcess[] = [];
  const runner: CommandRunner = (_command, args, options) =>
    new Promise((resolve, reject) => {
      const proc: FakeProcess = {
        args,
        prompts: [],
        ended: false,
        killed: false,
        crash: () => reject(new Error("crashed")),
      };
      processes.push(proc);
      const answer = (line: string) => {
        const event = JSON.parse(line) as {
          type: string;
          message?: { content: Array<{ text: string }> };
        };
        if (event.type !== "user") return;
        const text = event.message!.content[0]!.text;
        proc.prompts.push(text);
        setImmediate(() => {
          const out = (value: object) => options.onStdout?.(`${JSON.stringify(value)}\n`);
          out({ type: "system", subtype: "init", session_id: session });
          out(
            text.includes("fail")
              ? { type: "result", is_error: true, result: "boom", session_id: session }
              : { type: "result", is_error: false, result: `re:${text}`, session_id: session },
          );
        });
      };
      options.signal?.addEventListener("abort", () => {
        proc.killed = true;
        reject(new Error("killed"));
      });
      options.onStdin?.({
        write: (text) => answer(text),
        end: () => {
          proc.ended = true;
          setImmediate(() => resolve({ stdout: "", stderr: "" }));
        },
      });
      if (options.input) answer(options.input);
    });
  return { runner, processes };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("ClaudeCodeResponder 常驻进程", () => {
  it("一轮结束后留着进程，下一轮同一会话直接写进去，不再新起进程", async () => {
    const { runner, processes } = fakeClaude();
    const responder = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/w",
      hive,
      runner,
      keepAliveMs: 60_000,
    });
    const first = await responder.reply({ instructions: "r", prompt: "一" });
    expect(first).toMatchObject({ text: "re:一", threadId: "s1" });
    const second = await responder.reply({ instructions: "r", prompt: "二", threadId: "s1" });
    expect(second.text).toBe("re:二");
    expect(processes).toHaveLength(1);
    expect(processes[0]!.prompts).toEqual(["一", "二"]);
    expect(processes[0]!.ended).toBe(false);
    // 第一轮没有会话可接，参数里也就没有 --resume
    expect(processes[0]!.args).not.toContain("--resume");
    await responder.close();
    expect(processes[0]!.ended).toBe(true);
  });

  it("规则、模型或要接的会话变了就结束旧进程，新起一个并 --resume", async () => {
    const { runner, processes } = fakeClaude();
    const responder = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/w",
      hive,
      runner,
      keepAliveMs: 60_000,
    });
    await responder.reply({ instructions: "r", prompt: "一" });
    await responder.reply({ instructions: "r", prompt: "二", threadId: "s1", model: "opus" });
    expect(processes).toHaveLength(2);
    expect(processes[0]!.ended).toBe(true);
    expect(processes[1]!.args.join(" ")).toContain("--resume s1");
    expect(processes[1]!.args.join(" ")).toContain("--model opus");
    await responder.reply({ instructions: "新规则", prompt: "三", threadId: "s1", model: "opus" });
    expect(processes).toHaveLength(3);
    // 会话换了（例如开了新话题）：不能接着旧进程里的对话
    await responder.reply({ instructions: "新规则", prompt: "四", model: "opus" });
    expect(processes).toHaveLength(4);
    expect(processes[3]!.args).not.toContain("--resume");
    await responder.close();
  });

  it("出错的一轮不留进程，下一轮重新拉起", async () => {
    const { runner, processes } = fakeClaude();
    const responder = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/w",
      hive,
      runner,
      keepAliveMs: 60_000,
    });
    await expect(responder.reply({ instructions: "r", prompt: "fail" })).rejects.toThrow();
    expect(processes[0]!.ended).toBe(true);
    await responder.reply({ instructions: "r", prompt: "好", threadId: "s1" });
    expect(processes).toHaveLength(2);
    await responder.close();
  });

  it("空闲超时后结束进程，下一轮照旧新起并接上会话", async () => {
    const { runner, processes } = fakeClaude();
    const responder = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/w",
      hive,
      runner,
      keepAliveMs: 20,
    });
    await responder.reply({ instructions: "r", prompt: "一" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(processes[0]!.ended).toBe(true);
    await responder.reply({ instructions: "r", prompt: "二", threadId: "s1" });
    expect(processes).toHaveLength(2);
    expect(processes[1]!.args.join(" ")).toContain("--resume s1");
    await responder.close();
  });

  it("常驻进程意外退出后，下一轮新起进程", async () => {
    const { runner, processes } = fakeClaude();
    const responder = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/w",
      hive,
      runner,
      keepAliveMs: 60_000,
    });
    await responder.reply({ instructions: "r", prompt: "一" });
    processes[0]!.crash();
    await tick();
    await responder.reply({ instructions: "r", prompt: "二", threadId: "s1" });
    expect(processes).toHaveLength(2);
    await responder.close();
  });

  it("不开常驻（默认）时每轮跑完就关输入，进程退出", async () => {
    const { runner, processes } = fakeClaude();
    const responder = new ClaudeCodeResponder({ command: "claude", cwd: "/w", hive, runner });
    await responder.reply({ instructions: "r", prompt: "一" });
    await responder.reply({ instructions: "r", prompt: "二", threadId: "s1" });
    expect(processes).toHaveLength(2);
    expect(processes.every((proc) => proc.ended)).toBe(true);
  });

  it("常驻进程里停下这一轮：请 Claude 中断后关掉进程", async () => {
    const written: string[] = [];
    let emit: (line: object) => void = () => undefined;
    let ended = 0;
    let spawned = 0;
    const runner: CommandRunner = (_command, _args, options) =>
      new Promise((resolve) => {
        spawned++;
        emit = (line) => options.onStdout?.(`${JSON.stringify(line)}\n`);
        options.onStdin?.({
          write: (text) => {
            written.push(text);
            const event = JSON.parse(text) as { type: string; request_id?: string };
            if (event.type === "control_request") {
              const id = (JSON.parse(text) as { request_id: string }).request_id;
              setImmediate(() => {
                emit({
                  type: "control_response",
                  response: { subtype: "success", request_id: id },
                });
                emit({
                  type: "result",
                  subtype: "error_during_execution",
                  is_error: true,
                  session_id: "s1",
                });
              });
            }
          },
          end: () => {
            ended++;
            setImmediate(() => resolve({ stdout: "", stderr: "" }));
          },
        });
        setImmediate(() =>
          emit({ type: "result", is_error: false, result: "ok", session_id: "s1" }),
        );
      });
    const responder = new ClaudeCodeResponder({
      command: "claude",
      cwd: "/w",
      hive,
      runner,
      keepAliveMs: 60_000,
    });
    await responder.reply({ instructions: "r", prompt: "一" });
    expect(ended).toBe(0);
    const controller = new AbortController();
    const second = responder.reply({
      instructions: "r",
      prompt: "二",
      threadId: "s1",
      signal: controller.signal,
    });
    await tick();
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: "AgentCancelledError" });
    expect(spawned).toBe(1);
    expect(ended).toBe(1);
    expect(written.some((line) => line.includes('"interrupt"'))).toBe(true);
  });
});

describe("claudeKeepAliveMs", () => {
  it("默认 10 分钟，0 关闭，乱填按默认", () => {
    expect(claudeKeepAliveMs(undefined)).toBe(600_000);
    expect(claudeKeepAliveMs("0")).toBe(0);
    expect(claudeKeepAliveMs("30000")).toBe(30_000);
    expect(claudeKeepAliveMs("abc")).toBe(600_000);
    expect(claudeKeepAliveMs("-1")).toBe(600_000);
  });
});
