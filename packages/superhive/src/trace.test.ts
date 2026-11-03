import { describe, expect, it } from "vitest";
import { ClaudeStream } from "./claude-stream.js";
import type { TraceStep } from "./hive-protocol.js";
import {
  claudeToolSummary,
  isMutatingStep,
  redactTrace,
  sanitizeTraceStep,
  traceSummary,
} from "./trace.js";
import { isUpstreamFailure } from "./responder.js";

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

describe("isMutatingStep", () => {
  const step = (tool: TraceStep["tool"], summary: string, name?: string): TraceStep => ({
    id: "x",
    kind: "tool",
    tool,
    summary,
    ...(name ? { name } : {}),
    startedAt: new Date().toISOString(),
  });
  it("treats reads, searches and plainly read-only commands as safe to re-run", () => {
    expect(isMutatingStep(step("read", "src/a.ts"))).toBe(false);
    expect(isMutatingStep(step("search", "TODO"))).toBe(false);
    expect(isMutatingStep(step("command", "git status && git log --oneline -3"))).toBe(false);
    expect(isMutatingStep(step("command", "cd apps/web && ls -la | wc -l"))).toBe(false);
    expect(
      isMutatingStep(step("collaboration", "hive_room_read", "mcp__hive__hive_room_read")),
    ).toBe(false);
  });
  it("treats edits, unknown or redirecting commands and messages as side effects", () => {
    expect(isMutatingStep(step("write", "src/a.ts"))).toBe(true);
    expect(isMutatingStep(step("command", "git commit -m x"))).toBe(true);
    expect(isMutatingStep(step("command", "pnpm test"))).toBe(true);
    expect(isMutatingStep(step("command", "echo hi > a.txt"))).toBe(true);
    expect(isMutatingStep(step("command", "sed -i s/a/b/ f"))).toBe(true);
    expect(
      isMutatingStep(step("collaboration", "hive_message_send", "mcp__hive__hive_message_send")),
    ).toBe(true);
    expect(isMutatingStep(step("other", "canva.create"))).toBe(true);
  });
  it("catches multi-line scripts, substitutions, dangerous flags and writing redirects", () => {
    for (const command of [
      "ls\nrm -rf build",
      "echo $(rm a)",
      "echo `rm a`",
      "diff <(cat a) b",
      "find . -delete",
      "find . -exec rm {} +",
      "env rm a",
      "sed 'w out' a",
      "awk 'BEGIN{system(\"rm a\")}'",
      "sort -o f f",
      "date -s 2020",
      "git branch -D x",
      "git remote add o url",
      "git diff --output=x",
      "ls 2>err.txt",
      "sleep 100 &",
      "/bin/zsh -lc 'git commit -m x'",
      "ls & rm a",
      "ls &rm a",
      "rg --pre ./x.sh foo",
      "rg --pre=rm x",
      "git grep -O'rm' foo",
      "git log --output=x",
      "git show --output=x",
      "uniq in.txt out.txt",
      "tree -o out.txt",
      "GIT_EXTERNAL_DIFF=./x git diff",
      "PAGER=./x git log",
    ]) {
      expect(isMutatingStep(step("command", command)), command).toBe(true);
    }
    for (const command of [
      "git branch -a",
      "git remote -v",
      "ls 2>/dev/null",
      "rg TODO src 2>&1 | head",
      "/bin/zsh -lc 'git status && git log --oneline -3'",
      "LANG=C git status",
      "NO_COLOR=1 git diff",
    ]) {
      expect(isMutatingStep(step("command", command)), command).toBe(false);
    }
  });
  it("judges hive tools by name only, not by text in their arguments", () => {
    expect(
      isMutatingStep(
        step(
          "collaboration",
          "hive_message_send  提到 hive_board_read",
          "mcp__hive__hive_message_send",
        ),
      ),
    ).toBe(true);
    expect(
      isMutatingStep(step("collaboration", "hive.hive_board_read", "hive.hive_board_read")),
    ).toBe(false);
  });
});

describe("isUpstreamFailure", () => {
  it("recognises transient upstream errors but not quota, auth or arbitrary numbers", () => {
    for (const text of [
      "API Error: 429 rate limited",
      "API Error: 529 overloaded",
      "https response error StatusCode: 503",
      "rate limit exceeded: token rate limit",
      "API Error: 400 重试渠道均失败（共 4 次尝试）",
      "stream disconnected before completion",
    ]) {
      expect(isUpstreamFailure(text), text).toBe(true);
    }
    for (const text of [
      "insufficient_quota: 429 You exceeded your current quota",
      "API Error: 401 invalid api key",
      "line 512 failed",
      "command timed out after 30s",
    ]) {
      expect(isUpstreamFailure(text), text).toBe(false);
    }
  });
});
