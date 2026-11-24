import { describe, expect, it } from "vitest";
import { ClaudeStream } from "./claude-stream.js";
import type { RuntimeEvent, TraceStep } from "./hive-protocol.js";

describe("Claude stream diagnostics", () => {
  it("marks only explicit Hive progress calls for setup handoff", () => {
    const steps: TraceStep[] = [];
    const stream = new ClaudeStream(
      () => undefined,
      (step) => steps.push(step),
    );
    stream.push(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "progress",
              name: "mcp__hive__hive_message_send",
              input: { progress: true },
            },
            {
              type: "tool_use",
              id: "ordinary",
              name: "mcp__hive__hive_message_send",
              input: { content: "progress: true" },
            },
            {
              type: "tool_use",
              id: "external",
              name: "mcp__evil__hive_message_send",
              input: { progress: true },
            },
          ],
        },
      }) + "\n",
    );
    stream.push(
      JSON.stringify({
        type: "user",
        message: {
          content: ["progress", "ordinary", "external"].map((id) => ({
            type: "tool_result",
            tool_use_id: id,
            content: "ok",
          })),
        },
      }) + "\n",
    );
    expect(steps.map((step) => step.hiveProgress)).toEqual([
      true,
      undefined,
      undefined,
      true,
      undefined,
      undefined,
    ]);
  });
  it("parses fragmented JSON, returns only the final result and emits no private content", () => {
    const events: RuntimeEvent[] = [];
    const stream = new ClaudeStream((e) => events.push(e));
    const lines = [
      { type: "stream_event", event: { type: "message_start" } },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "PRIVATE_THOUGHT" },
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "1", name: "Bash", input: { command: "SECRET_COMMAND" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "1", content: "SECRET_FILE", is_error: true },
          ],
        },
      },
      { type: "result", is_error: false, result: "public reply", session_id: "session" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    for (let i = 0; i < lines.length; i += 7) stream.push(lines.slice(i, i + 7));
    expect(stream.finish()).toEqual({
      result: "public reply",
      session_id: "session",
      is_error: false,
    });
    expect(events).toContainEqual({ kind: "activity", phase: "tool_running", tool: "command" });
    expect(events).toContainEqual({ kind: "activity", phase: "tool_completed", tool: "command" });
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|SECRET|session|public reply/);
  });

  it("keeps an API error until model recovery evidence, not a tool result", () => {
    const events: RuntimeEvent[] = [];
    const stream = new ClaudeStream((e) => events.push(e));
    const push = (event: object) => stream.push(JSON.stringify(event) + "\n");
    push({
      type: "system",
      subtype: "api_retry",
      error_status: 429,
      attempt: 2,
      retry_delay_ms: 500,
      error: "SECRET",
    });
    push({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } });
    expect(events).not.toContainEqual({ kind: "recovered" });
    push({ type: "assistant", error: "rate_limit", message: { content: [] } });
    expect(events).not.toContainEqual({ kind: "recovered" });
    push({ type: "stream_event", event: { type: "message_start" } });
    expect(events).toContainEqual({
      kind: "provider_error",
      code: 429,
      retryAttempt: 2,
      retryInMs: 500,
    });
    expect(events.at(-2)).toEqual({ kind: "recovered" });
  });

  it("notes when Claude Code compacted the conversation during the turn", () => {
    const stream = new ClaudeStream(() => {});
    expect(stream.compacted()).toBe(false);
    stream.push(
      `${JSON.stringify({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 400000 } })}\n`,
    );
    expect(stream.compacted()).toBe(true);
  });

  it("ignores malformed, oversized and unknown events without replaying the task", () => {
    const events: RuntimeEvent[] = [];
    const stream = new ClaudeStream((e) => events.push(e));
    stream.push("not-json\n" + "x".repeat(1_100_000));
    stream.push('\n{"type":"private_event","payload":"SECRET"}\n');
    stream.push(
      '{"type":"system","subtype":"api_retry","error_status":999,"attempt":-1,"retry_delay_ms":"secret"}\n',
    );
    stream.push('{"type":"result","result":"ok"}\n');
    expect(stream.finish()?.result).toBe("ok");
    expect(events[0]).toEqual({ kind: "provider_error" });
    expect(events).toHaveLength(2);
  });

  it("never treats partial assistant text as a completed reply", () => {
    const stream = new ClaudeStream(() => {});
    stream.push('{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}\n');
    expect(stream.finish()).toBeUndefined();
  });

  it("从 init 的 mcp_servers 里认出 hive MCP 连上没有", () => {
    const seen: Array<[string, string | undefined]> = [];
    const sessions: string[] = [];
    const stream = new ClaudeStream(
      () => undefined,
      () => undefined,
      (id) => sessions.push(id),
    );
    stream.onHiveTools = (status, detail) => seen.push([status, detail]);
    const init = (servers: unknown) =>
      stream.push(
        `${JSON.stringify({ type: "system", subtype: "init", session_id: "s1", mcp_servers: servers })}\n`,
      );
    init([
      { name: "figma", status: "failed" },
      { name: "hive", status: "failed" },
    ]);
    init([{ name: "hive", status: "connected" }]);
    init([{ name: "hive", status: "pending" }]);
    init(undefined);
    expect(seen).toEqual([
      ["unavailable", "Claude Code 报告 hive MCP 状态为 failed"],
      ["connected", undefined],
    ]);
    // 会话 ID 照旧交出
    expect(sessions).toContain("s1");
  });
});
