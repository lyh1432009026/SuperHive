import { describe, expect, it } from "vitest";
import { ClaudeStream } from "./claude-stream.js";
import type { TraceStep } from "./hive-protocol.js";
import { claudeToolSummary, redactTrace, sanitizeTraceStep, traceSummary } from "./trace.js";

describe("execution trace", () => {
  it("masks common secrets and the home directory before anything leaves the bridge", () => {
    const text = [
      "curl -H 'Authorization: Bearer abcdefghijklmnop' https://user:hunter2@example.com",
      "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123",
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx npm publish --token npm_abcdefghijklmnopqrstu",
      "cat /Users/alice/.ssh/config password: s3cretvalue",
    ].join("\n");
    const masked = redactTrace(text, "/Users/alice");
    for (const secret of [
      "abcdefghijklmnop",
      "hunter2",
      "abcdefghijklmnopqrstuvwxyz0123",
      "proj-abcdefghijklmnopqrstuvwx",
      "npm_abcdefghijklmnopqrstu",
      "s3cretvalue",
      "/Users/alice",
    ]) {
      expect(masked).not.toContain(secret);
    }
    expect(masked).toContain("~/.ssh/config");
    expect(masked).toContain("Authorization: ***");
  });

  it("keeps one line per tool and clips long text", () => {
    expect(traceSummary("git add .\ngit commit -m x\ngit push")).toBe("git add . …（共 3 行）");
    expect(traceSummary("x".repeat(1000))).toHaveLength(300);
    const step = sanitizeTraceStep({
      id: "1",
      kind: "text",
      text: "y".repeat(5000),
      startedAt: new Date().toISOString(),
    });
    expect(step.text).toHaveLength(2000);
    expect(claudeToolSummary("Grep", { pattern: "TODO", path: "src" })).toBe("TODO  in src");
    expect(claudeToolSummary("mcp__hive__hive_board_update", {})).toBe("hive_board_update");
  });

  it("turns Claude stream-json into ordered steps: thinking, interim text, tool start and result", () => {
    const steps: TraceStep[] = [];
    const stream = new ClaudeStream(
      () => undefined,
      (step) => steps.push(step),
    );
    const lines = [
      { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } },
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      {
        type: "assistant",
        message: { id: "m1", content: [{ type: "text", text: "先看一下改动" }] },
      },
      {
        type: "assistant",
        message: {
          id: "m1",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git status" } }],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }] },
      },
    ];
    stream.push(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    expect(
      steps.map((step) => [step.kind, step.status ?? "", step.text ?? step.summary ?? ""]),
    ).toEqual([
      ["thinking", "running", ""],
      ["thinking", "ok", ""],
      ["text", "", "先看一下改动"],
      ["tool", "running", "git status"],
      ["tool", "error", "git status"],
    ]);
    expect(steps[4]).toMatchObject({ id: "t1", tool: "command", name: "Bash" });
    expect(steps[4]!.endedAt).toBeDefined();
  });
});
