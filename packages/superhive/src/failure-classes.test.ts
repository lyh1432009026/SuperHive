import { describe, expect, it } from "vitest";
import { CodexAppServerUnsupportedError } from "./codex-app-server-client.js";
import { codexStartupFailure } from "./codex-errors.js";
import {
  AgentCancelledError,
  AgentExecutionUncertainError,
  AgentNonRetryableError,
  AgentTransientError,
  failureClassOf,
  type FailureClass,
} from "./responder.js";
import { TaskWorkspaceBusyError } from "./task-workspace.js";

function timeout(): Error {
  return Object.assign(new Error("Codex app-server initialize 超时（10ms）。"), {
    name: "CodexRequestTimeoutError",
  });
}

/**
 * 运行时客户端与任务目录里各个抛点产生的错误归到哪一类。Bridge 那边的抛点（回合后复核目录、
 * 切目录、引导）在 bridge-behavior.test.ts 的「failure classes by throw site」里按上报结果核对。
 */
const sites: Array<[site: string, error: () => unknown, expected: FailureClass | undefined]> = [
  [
    "codexStartupFailure: handshake / session timeout",
    () => codexStartupFailure("app-server initialize", timeout()),
    "transient",
  ],
  [
    "codexStartupFailure: codex command missing",
    () =>
      codexStartupFailure(
        "app-server initialize",
        Object.assign(new Error("spawn"), { code: "ENOENT" }),
      ),
    "unsafe",
  ],
  [
    "codexStartupFailure: interactive TTY",
    () =>
      codexStartupFailure("mcp-server initialize", new Error("closed"), "stdin is not a terminal"),
    "unsafe",
  ],
  [
    "codexStartupFailure: incompatible config",
    () =>
      codexStartupFailure("app-server initialize", new Error("x"), "Error loading configuration"),
    "unsafe",
  ],
  [
    "codexStartupFailure: JSON-RPC error code",
    () =>
      codexStartupFailure("app-server 会话准备", Object.assign(new Error("x"), { code: -32000 })),
    "unsafe",
  ],
  [
    "codexStartupFailure: passes an already-classified transient through",
    () => codexStartupFailure("app-server 会话准备", new AgentTransientError("busy")),
    "transient",
  ],
  [
    "CodexAppServerUnsupportedError: initialize -32601",
    () => new CodexAppServerUnsupportedError("unsupported"),
    "unsafe",
  ],
  [
    "TaskWorkspaceBusyError: Server busy picking the workspace",
    () => new TaskWorkspaceBusyError("503"),
    "transient",
  ],
  [
    "AgentExecutionUncertainError: turn reported failed / interrupted",
    () => new AgentExecutionUncertainError("x", { settled: true }),
    "uncertain",
  ],
  [
    "AgentExecutionUncertainError: connection lost mid-turn",
    () => new AgentExecutionUncertainError("x"),
    "uncertain",
  ],
  [
    "AgentNonRetryableError: session locked / identity mismatch",
    () => new AgentNonRetryableError("x"),
    "unsafe",
  ],
  ["AgentCancelledError is a stop, not a failure", () => new AgentCancelledError(), undefined],
  ["unclassified errors fall back to the generic retry path", () => new Error("boom"), undefined],
];

describe("failure classes", () => {
  it.each(sites)("%s", (_site, error, expected) => {
    expect(failureClassOf(error())).toBe(expected);
  });

  it("never leaks stderr into a transient startup message", () => {
    const error = codexStartupFailure("app-server initialize", timeout(), "Bearer TOP_SECRET");
    expect(error.message).not.toContain("TOP_SECRET");
    expect(error.message).toContain("未发送执行请求");
  });
});
