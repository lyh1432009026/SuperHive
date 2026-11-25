import { describe, expect, it } from "vitest";
// 这个包不依赖 protocol；测试直接读源码核对两边的分类一致
import { failureKindSchema } from "../../protocol/src/index.js";
import { ClaudeCodeResponder } from "./claude-client.js";
import {
  FAILURE_KINDS,
  classifyAcp,
  classifyCodex,
  classifyText,
  failurePolicy,
  isUpstreamKind,
  type FailureKind,
} from "./failure.js";
import {
  AgentExecutionUncertainError,
  AgentSessionInvalidError,
  AgentUpstreamError,
  classifiedFailure,
} from "./responder.js";

/*
 * 真实样本。四个运行时的样本是真实 CLI 连本机假上游录下来的（2026-11-23）：假上游按各家 API 文档的格式
 * 回 429、529、500、503、401、403、400（余额、上下文超长、参数错）、404 和网关「重试渠道均失败」，
 * 断网样本连 127.0.0.1:9（连接被拒）和不存在的域名。CLI 版本：Claude Code 2.1.283、codex-cli 0.162.1、
 * opencode 1.19.6、Gemini CLI 0.70.0。录制脚本和对照表见 docs/research/failure-taxonomy.md。
 * 线上样本取自本机 Agent 日志（模型网关、Codex 网关的原话），只去掉了请求 ID 以外的无关部分。
 */

/** Claude Code stream-json：出错时的合成 assistant 帧 + is_error 的 result 帧 */
const CLAUDE: Array<[sample: string, expected: FailureKind, frames: unknown[]]> = [
  [
    "rate429",
    "rate_limited",
    [
      {
        type: "assistant",
        error: "rate_limit",
        message: {
          model: "<synthetic>",
          content: [
            {
              type: "text",
              text: "API Error: Request rejected (429) · This request would exceed your organization's rate limit of 50,000 input tokens per minute.",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 429,
        terminal_reason: "api_error",
        result:
          "API Error: Request rejected (429) · This request would exceed your organization's rate limit of 50,000 input tokens per minute.",
        session_id: "ses-sample",
      },
    ],
  ],
  [
    "quota429",
    "quota",
    [
      {
        type: "assistant",
        error: "rate_limit",
        message: {
          model: "<synthetic>",
          content: [
            {
              type: "text",
              text: "API Error: Request rejected (429) · You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 429,
        terminal_reason: "api_error",
        result:
          "API Error: Request rejected (429) · You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.",
        session_id: "ses-sample",
      },
    ],
  ],
  [
    "over529",
    "overloaded",
    [
      {
        type: "assistant",
        error: "server_error",
        message: {
          model: "<synthetic>",
          content: [
            {
              type: "text",
              text: "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:18999).",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 529,
        terminal_reason: "api_error",
        result:
          "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:18999).",
        session_id: "ses-sample",
      },
    ],
  ],
  [
    "e500",
    "provider_error",
    [
      {
        type: "assistant",
        error: "server_error",
        message: {
          model: "<synthetic>",
          content: [
            {
              type: "text",
              text: "API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:18999).",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 500,
        terminal_reason: "api_error",
        result:
          "API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:18999).",
        session_id: "ses-sample",
      },
    ],
  ],
  [
    "auth401",
    "auth",
    [
      {
        type: "assistant",
        error: "authentication_failed",
        message: {
          model: "<synthetic>",
          content: [{ type: "text", text: "Invalid API key · Fix external API key" }],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 401,
        terminal_reason: "api_error",
        result: "Invalid API key · Fix external API key",
        session_id: "ses-sample",
      },
    ],
  ],
  [
    "credit400",
    "billing",
    [
      {
        type: "assistant",
        error: "billing_error",
        message: {
          model: "<synthetic>",
          content: [{ type: "text", text: "Credit balance is too low" }],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 400,
        terminal_reason: "api_error",
        result: "Credit balance is too low",
        session_id: "ses-sample",
      },
    ],
  ],
  [
    "long400",
    "context_overflow",
    [
      {
        type: "assistant",
        error: "invalid_request",
        message: {
          model: "<synthetic>",
          content: [
            {
              type: "text",
              text: "Prompt is too long · the request is ~250000 tokens (limit 200000) but this conversation is only ~2169 tokens — the rest is system prompt, tool definitions, and attachment content. A single-exchange conversation cannot be compacted; reduce attached files/tools or start with less context.",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 400,
        terminal_reason: "prompt_too_long",
        result:
          "Prompt is too long · the request is ~250000 tokens (limit 200000) but this conversation is only ~2169 tokens — the rest is system prompt, tool definitions, and attachment content. A single-exchange conversation cannot be compacted; reduce attached files/tools or start with less context.",
        session_id: "ses-sample",
      },
    ],
  ],
  [
    "model404",
    "model_unavailable",
    [
      {
        type: "assistant",
        error: "model_not_found",
        message: {
          model: "<synthetic>",
          content: [
            {
              type: "text",
              text: "There's an issue with the selected model (claude-sonnet-4-5). It may not exist or you may not have access to it. Run --model to pick a different model.",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 404,
        terminal_reason: "api_error",
        result:
          "There's an issue with the selected model (claude-sonnet-4-5). It may not exist or you may not have access to it. Run --model to pick a different model.",
        session_id: "ses-sample",
      },
    ],
  ],
  [
    "bad400",
    "invalid_request",
    [
      {
        type: "assistant",
        error: "unknown",
        message: {
          model: "<synthetic>",
          content: [
            {
              type: "text",
              text: "API Error: 400 messages.0.content: Input should be a valid list",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 400,
        terminal_reason: "api_error",
        result: "API Error: 400 messages.0.content: Input should be a valid list",
        session_id: "ses-sample",
      },
    ],
  ],
  [
    "gw400",
    "rate_limited",
    [
      {
        type: "assistant",
        error: "unknown",
        message: {
          model: "<synthetic>",
          content: [
            {
              type: "text",
              text: "API Error: 400 重试渠道均失败（共 3 次尝试）: 该渠道已达到请求速率限制，请稍后重试 (request id: 2026112000000000000000000000000)",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 400,
        terminal_reason: "api_error",
        result:
          "API Error: 400 重试渠道均失败（共 3 次尝试）: 该渠道已达到请求速率限制，请稍后重试 (request id: 2026112000000000000000000000000)",
        session_id: "ses-sample",
      },
    ],
  ],
  [
    "refused",
    "network",
    [
      {
        type: "assistant",
        error: "server_error",
        message: {
          model: "<synthetic>",
          content: [
            {
              type: "text",
              text: "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: null,
        terminal_reason: "api_error",
        result:
          "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)",
        session_id: "ses-sample",
      },
    ],
  ],
  [
    "dns",
    "network",
    [
      {
        type: "assistant",
        error: "server_error",
        message: {
          model: "<synthetic>",
          content: [
            {
              type: "text",
              text: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: null,
        terminal_reason: "api_error",
        result: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
        session_id: "ses-sample",
      },
    ],
  ],
];

/** Codex app-server：失败回合的 turn.error（断网时是 willRetry 的 error 通知，Codex 自己一直等网络） */
const CODEX: Array<[sample: string, expected: FailureKind, error: unknown]> = [
  [
    "rate429",
    "rate_limited",
    {
      message: "exceeded retry limit, last status: 429 Too Many Requests",
      codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      additionalDetails: null,
      misalignment: null,
    },
  ],
  [
    "quota429",
    "quota",
    {
      message: "Quota exceeded. Check your plan and billing details.",
      codexErrorInfo: "usageLimitExceeded",
      additionalDetails: null,
      misalignment: null,
    },
  ],
  [
    "over529",
    "overloaded",
    {
      message:
        "unexpected status 529 <unknown status code>: The server is overloaded, please try again later., url: http://127.0.0.1:18999/over529/v1/responses",
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 529 } },
      additionalDetails: null,
      misalignment: null,
    },
  ],
  [
    "e500",
    "provider_error",
    {
      message: "We’re currently experiencing high demand, which may cause temporary errors.",
      codexErrorInfo: "internalServerError",
      additionalDetails: null,
      misalignment: null,
    },
  ],
  [
    "e503",
    "overloaded",
    {
      message:
        "unexpected status 503 Service Unavailable: Service Unavailable, url: http://127.0.0.1:18999/e503/v1/responses",
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
      additionalDetails: null,
      misalignment: null,
    },
  ],
  [
    "auth401",
    "auth",
    {
      message:
        "unexpected status 401 Unauthorized: Incorrect API key provided: sk-fake. You can find your API key at https://platform.openai.com/account/api-keys., url: http://127.0.0.1:18999/auth401/v1/responses",
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
      additionalDetails: null,
      misalignment: null,
    },
  ],
  [
    "perm403",
    "model_unavailable",
    {
      message:
        "unexpected status 403 Forbidden: You are not allowed to sample from this model, url: http://127.0.0.1:18999/perm403/v1/responses",
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } },
      additionalDetails: null,
      misalignment: null,
    },
  ],
  [
    "credit400",
    "billing",
    {
      message:
        '{"error":{"code":"billing_hard_limit_reached","type":"invalid_request_error","message":"Billing hard limit has been reached","param":null}}',
      codexErrorInfo: "other",
      additionalDetails: null,
      misalignment: null,
    },
  ],
  [
    "long400",
    "context_overflow",
    {
      message:
        '{"error":{"code":"context_length_exceeded","type":"invalid_request_error","message":"Your input exceeds the context window of this model. Please adjust your input and try again.","param":null}}',
      codexErrorInfo: "other",
      additionalDetails: null,
      misalignment: null,
    },
  ],
  [
    "model404",
    "model_unavailable",
    {
      message:
        "unexpected status 404 Not Found: The model `gpt-nope-9` does not exist or you do not have access to it., url: http://127.0.0.1:18999/model404/v1/responses",
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 404 } },
      additionalDetails: null,
      misalignment: null,
    },
  ],
  [
    "bad400",
    "invalid_request",
    {
      message:
        '{"error":{"code":null,"type":"invalid_request_error","message":"Invalid value for \'input\'.","param":null}}',
      codexErrorInfo: "other",
      additionalDetails: null,
      misalignment: null,
    },
  ],
  [
    "gw400",
    "rate_limited",
    {
      message:
        '{"error":{"type":"new_api_error","message":"重试渠道均失败（共 3 次尝试）: 该渠道已达到请求速率限制，请稍后重试 (request id: 2026112000000000000000000000000)"}}',
      codexErrorInfo: "other",
      additionalDetails: null,
      misalignment: null,
    },
  ],
  [
    "refused",
    "network",
    {
      message: "Reconnecting... waiting for network",
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      additionalDetails: "Connection failed: error sending request",
      misalignment: null,
      willRetry: true,
    },
  ],
  [
    "dns",
    "network",
    {
      message: "Reconnecting... waiting for network",
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      additionalDetails: "Connection failed: error sending request",
      misalignment: null,
      willRetry: true,
    },
  ],
];

/** opencode acp：session/prompt 的 JSON-RPC 错误（-32603，类别在 data.errorName） */
const OPENCODE: Array<
  [sample: string, expected: FailureKind, error: { code?: number; message: string; data?: unknown }]
> = [
  [
    "rate429",
    "rate_limited",
    {
      code: -32603,
      message:
        "Internal error: Rate limit reached for gpt-5 in organization org-x on tokens per min (TPM): Limit 30000, Used 30000, Requested 100. Please try again in 2s.",
      data: { service: "session", errorName: "APIError" },
    },
  ],
  [
    "quota429",
    "quota",
    {
      code: -32603,
      message:
        "Internal error: You exceeded your current quota, please check your plan and billing details.",
      data: { service: "session", errorName: "APIError" },
    },
  ],
  [
    "over529",
    "overloaded",
    {
      code: -32603,
      message: "Internal error: The server is overloaded, please try again later.",
      data: { service: "session", errorName: "APIError" },
    },
  ],
  [
    "e500",
    "provider_error",
    {
      code: -32603,
      message: "Internal error: The server had an error while processing your request.",
      data: { service: "session", errorName: "APIError" },
    },
  ],
  [
    "e503",
    "overloaded",
    {
      code: -32603,
      message:
        'Internal error: Service Unavailable: {"error":{"code":null,"type":"server_error","message":"Service Unavailable","param":null}}',
      data: { service: "session", errorName: "APIError" },
    },
  ],
  [
    "auth401",
    "auth",
    {
      code: -32603,
      message:
        "Internal error: Incorrect API key provided: sk-fake. You can find your API key at https://platform.openai.com/account/api-keys.",
      data: { service: "session", errorName: "APIError" },
    },
  ],
  [
    "perm403",
    "model_unavailable",
    {
      code: -32603,
      message: "Internal error: You are not allowed to sample from this model",
      data: { service: "session", errorName: "APIError" },
    },
  ],
  [
    "credit400",
    "billing",
    {
      code: -32603,
      message: "Internal error: Billing hard limit has been reached",
      data: { service: "session", errorName: "APIError" },
    },
  ],
  [
    "long400",
    "context_overflow",
    {
      code: -32603,
      message:
        "Internal error: Session too large to compact - context exceeds model limit even after stripping media",
      data: { service: "session", errorName: "ContextOverflowError" },
    },
  ],
  [
    "model404",
    "model_unavailable",
    {
      code: -32603,
      message:
        "Internal error: The model `gpt-nope-9` does not exist or you do not have access to it.",
      data: { service: "session", errorName: "APIError" },
    },
  ],
  [
    "bad400",
    "unknown",
    {
      code: -32603,
      message: "Internal error: Invalid value for 'input'.",
      data: { service: "session", errorName: "APIError" },
    },
  ],
  [
    "gw400",
    "rate_limited",
    {
      code: -32603,
      message:
        "Internal error: 重试渠道均失败（共 3 次尝试）: 该渠道已达到请求速率限制，请稍后重试 (request id: 2026112000000000000000000000000)",
      data: { service: "session", errorName: "APIError" },
    },
  ],
  [
    "refused",
    "network",
    {
      code: -32603,
      message:
        "Internal error: Cannot connect to API: ECONNREFUSED: Unable to connect. Is the computer able to access the url?",
      data: { service: "session", errorName: "APIError" },
    },
  ],
];

/** Gemini CLI --experimental-acp：error.code 是 HTTP 状态码，message 是 Google 的错误体（429 时 CLI 自己退避重试，150 秒内没报出来） */
const GEMINI: Array<
  [sample: string, expected: FailureKind, error: { code?: number; message: string; data?: unknown }]
> = [
  [
    "over529",
    "overloaded",
    {
      code: 529,
      message:
        '[{"error":{"code":529,"message":"The server is overloaded, please try again later.","status":"UNAVAILABLE"}}]',
    },
  ],
  [
    "e500",
    "provider_error",
    {
      code: 500,
      message:
        '[{"error":{"code":500,"message":"The server had an error while processing your request.","status":"INTERNAL"}}]',
    },
  ],
  [
    "auth401",
    "auth",
    {
      code: 401,
      message:
        '[{"error":{"code":401,"message":"Incorrect API key provided: sk-fake. You can find your API key at https://platform.openai.com/account/api-keys.","status":"UNAUTHENTICATED"}}]',
    },
  ],
  [
    "perm403",
    "model_unavailable",
    {
      code: 403,
      message:
        '[{"error":{"code":403,"message":"You are not allowed to sample from this model","status":"PERMISSION_DENIED"}}]',
    },
  ],
  [
    "long400",
    "context_overflow",
    {
      code: 400,
      message:
        '[{"error":{"code":400,"message":"Your input exceeds the context window of this model. Please adjust your input and try again.","status":"INVALID_ARGUMENT"}}]',
    },
  ],
  [
    "model404",
    "model_unavailable",
    {
      code: 500,
      message: "The model `gpt-nope-9` does not exist or you do not have access to it.",
    },
  ],
  [
    "bad400",
    "invalid_request",
    {
      code: 400,
      message:
        '[{"error":{"code":400,"message":"Invalid value for \'input\'.","status":"INVALID_ARGUMENT"}}]',
    },
  ],
  [
    "gw400",
    "rate_limited",
    {
      code: 400,
      message:
        '[{"error":{"code":400,"message":"重试渠道均失败（共 3 次尝试）: 该渠道已达到请求速率限制，请稍后重试 (request id: 2026112000000000000000000000000)","status":"INVALID_ARGUMENT"}}]',
    },
  ],
  [
    "refused",
    "network",
    { code: 500, message: "exception TypeError: fetch failed sending request" },
  ],
];

const hive = {
  serverUrl: "http://localhost:8787",
  roomId: "general",
  username: "claude-agent",
  token: "test-token",
};

async function claudeFailure(frames: unknown[]): Promise<unknown> {
  const responder = new ClaudeCodeResponder({
    command: "claude",
    cwd: "/workspace",
    hive,
    runner: (_command, _args, options) => {
      options.onStdout?.(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""));
      // 真实 CLI 写完 is_error 的结果后以退出码 1 结束
      return Promise.reject(new Error("运行进程异常退出（1）。"));
    },
  });
  return responder.reply({ instructions: "rules", prompt: "hi" }).catch((error: unknown) => error);
}

describe("failure taxonomy: real runtime samples", () => {
  it.each(CLAUDE)("Claude Code %s → %s", async (_sample, expected, frames) => {
    const error = await claudeFailure(frames);
    expect(error).toBeInstanceOf(AgentUpstreamError);
    expect((error as AgentUpstreamError).kind).toBe(expected);
    expect((error as AgentUpstreamError).threadId).toBe("ses-sample");
  });

  it.each(CODEX)("Codex %s → %s", (_sample, expected, error) => {
    expect(classifyCodex(error)).toBe(expected);
  });

  it.each(OPENCODE)("opencode %s → %s", (_sample, expected, error) => {
    expect(classifyAcp(error)).toBe(expected);
  });

  it.each(GEMINI)("Gemini CLI %s → %s", (_sample, expected, error) => {
    expect(classifyAcp(error)).toBe(expected);
  });
});

describe("failure taxonomy: production log samples", () => {
  it.each<[string, FailureKind]>([
    // Claude Code 经模型网关：渠道轮完都限流（自动继续两档）
    [
      "API Error: 400 重试渠道均失败（共 8 次尝试）: 该渠道已达到请求速率限制，请稍后重试 (request id: 202611200516302409112158268d9d6zrbAODNw) | 该渠道已达到请求速率限制，请稍后重试 (request id: 202611200516318537664688268d9d6xU3mBWLy)",
      "rate_limited",
    ],
    // 有的渠道月度额度用完、有的只是限流：等一会儿可能轮到还有额度的渠道，按限流处理
    [
      "API Error: 400 重试渠道均失败（共 8 次尝试）: 重试渠道均失败（共 6 次尝试）: You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC. (request id: 202611200817339775490438268d9d6i8IK7Q3F) | 该渠道已达到请求速率限制，请稍后重试 (request id: ",
      "rate_limited",
    ],
    // 只剩额度用完那一个原因：到 12 月 1 日才恢复，自动重试没用
    [
      "API Error: 400 重试渠道均失败（共 4 次尝试）: 重试渠道均失败（共 1 次尝试）: upstream error: do request failed (request id: 202611220347533484635218268d9d6suH4heok) | 重试渠道均失败（共 1 次尝试）: You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.",
      "quota",
    ],
    [
      "API Error: 400 重试渠道均失败（共 7 次尝试）: 重试渠道均失败（共 1 次尝试）: Upstream response stream was interrupted (request id: 202611200518093118479128268d9d6lAPA922A) | 重试渠道均失败（共 1 次尝试）: 555420: The deployment request could not be completed. Anthropic independe",
      "rate_limited",
    ],
    [
      "API Error: 400 重试渠道均失败（共 7 次尝试）: 重试渠道均失败（共 1 次尝试）: InvokeModelWithResponseStream: operation error Bedrock Runtime: InvokeModelWithResponseStream, https response error StatusCode: 400, RequestID: a99ddfb2-b9a2-4a7b-90e5-0ae0d1196be3, Validat",
      "rate_limited",
    ],
    // 网关限流却回 403 + Failed to authenticate，后面还提到部署不可用（云机浏览器房间）
    [
      "Failed to authenticate. API Error: 403 重试渠道均失败（共 7 次尝试）: 该渠道已达到请求速率限制，请稍后重试 (request id: 20261120151200000000000000000000) | 重试渠道均失败（共 1 次尝试）: 555420: The deployment request could not be completed. The deployment model is not available right now.",
      "rate_limited",
    ],
    ["API Error: Connection dropped (ECONNRESET)", "network"],
    ["API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)", "network"],
    [
      "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)",
      "network",
    ],
    // Go 写的 CLI（agy）直连海外服务、代理没开或开错端口时的 net/http 报错
    [
      'Post "https://cloudcode-pa.googleapis.com/v1internal": dial tcp 142.250.66.106:443: i/o timeout',
      "network",
    ],
    ["proxyconnect tcp: dial tcp 127.0.0.1:7890: connect: connection refused", "network"],
    ['Get "https://oauth2.googleapis.com/token": net/http: TLS handshake timeout', "network"],
    ["dial tcp: lookup generativelanguage.googleapis.com: no such host", "network"],
    // Codex 经网关
    [
      "rate limit exceeded: The system is currently experiencing high demand and cannot process your request. Your request exceeds the maximum usage size allowed during peak load. For improved capacity reliability, consider switching to Provision…",
      "rate_limited",
    ],
    [
      "unexpected status 502 Bad Gateway: 重试渠道均失败（共 1 次尝试）: bad response status code 502 (request id: 202611171150107828106588268d9d60ZOS4VnC)",
      "rate_limited",
    ],
    [
      '{"error":{"code":"invalid_encrypted_content","message":"The encrypted content for item rs_0e5eab65e4a8ffe5016afd415120c481979ed4f59d67bce79d could not be verified. Reason: Encrypted content could not be decrypted or parsed. (x-api-gateway-…',
      "session_invalid",
    ],
    // Claude Code 的真实输出（--model 给了不存在的模型）；Codex 经网关的真实输出
    [
      "There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it. Run --model to pick a different model.",
      "model_unavailable",
    ],
    [
      'unexpected status 404 Not Found: {"error":"Model `gpt-does-not-exist-9` not found"}',
      "model_unavailable",
    ],
  ])("%s → %s", (text, expected) => {
    expect(classifyText(text)).toBe(expected);
  });
});

describe("failure taxonomy: wording rules", () => {
  it("recognizes the ways runtimes report a session that cannot continue", () => {
    for (const text of [
      '{"error":{"code":"invalid_encrypted_content","message":"The encrypted content for item rs_1 could not be verified."}}',
      "Encrypted content could not be decrypted or parsed.",
      "previous_response_not_found",
      "Previous response with id 'resp_1' not found.",
      "No conversation found with session ID: 0b1c",
      "no rollout found for thread id thread-old",
      "Session not found: ses-old",
      "session not found for thread_id: t-1",
      "thread not found",
      "failed to load rollout: unexpected end of file",
      "corrupted session file",
    ]) {
      expect(classifyText(text), text).toBe("session_invalid");
    }
  });

  it("recognizes a model that is missing or retired, but not quota or auth problems", () => {
    for (const text of [
      '{"error":{"code":"model_not_found","message":"The model gpt-old does not exist"}}',
      "The model `gpt-old` does not exist or you do not have access to it.",
      'not_found_error: {"type":"not_found_error","message":"model: claude-old"}',
      "model gpt-4 has been deprecated",
      "Unknown model: foo/bar",
    ]) {
      expect(classifyText(text), text).toBe("model_unavailable");
    }
    expect(
      classifyText("insufficient_quota: You exceeded your current quota for model gpt-main"),
    ).toBe("quota");
    expect(classifyText("401 Unauthorized: model gpt-main")).toBe("auth");
    expect(classifyText("invalid api key for model gpt-main")).toBe("auth");
    expect(classifyText("billing hard limit reached; model unavailable")).toBe("billing");
  });

  it("tells throttling, quota, billing and auth apart", () => {
    for (const [text, expected] of [
      ["API Error: 429 rate limited", "rate_limited"],
      ["rate limit exceeded: token rate limit", "rate_limited"],
      ["API Error: 400 重试渠道均失败（共 4 次尝试）", "rate_limited"],
      // 网关写错了状态码，但原因写明是限流
      ["API Error: 401 Too Many Requests", "rate_limited"],
      // Google 把每分钟的配额也叫 Quota exceeded：那是限流
      [
        "Quota exceeded for quota metric 'Generate Content API requests per minute'",
        "rate_limited",
      ],
      ["insufficient_quota: 429 You exceeded your current quota", "quota"],
      ["insufficient_quota: 403 重试渠道均失败", "quota"],
      ["Quota exceeded. Check your plan and billing details.", "quota"],
      ["Your credit balance is too low to access the Anthropic API.", "billing"],
      ["API Error: 401 invalid api key", "auth"],
      ["API Error: 401 Unauthorized", "auth"],
      // 单纯的鉴权失败：没写限流或渠道失败
      ["Failed to authenticate. API Error: 403 Forbidden", "auth"],
      // 限流字样也挡不住 key 无效
      ["API Error: 403 rate limit: invalid api key", "auth"],
      // ACP 的 auth_required（agy、Gemini CLI 的原话）
      ["Authentication required", "auth"],
      ["API key is missing", "auth"],
      ["Please sign in to continue", "auth"],
      ["Not authenticated. Run agy login first", "auth"],
      ["No credentials found for provider zhipu", "auth"],
    ] as const) {
      expect(classifyText(text), text).toBe(expected);
    }
  });

  it("recognises being offline, overload and other provider errors", () => {
    for (const [text, expected] of [
      ["Connection error.", "network"],
      ["getaddrinfo EAI_AGAIN api.anthropic.com", "network"],
      ["TypeError: fetch failed", "network"],
      ["API Error: 529 overloaded", "overloaded"],
      ["https response error StatusCode: 503", "overloaded"],
      ["stream disconnected before completion", "provider_error"],
      ["API Error: 502", "provider_error"],
    ] as const) {
      expect(classifyText(text), text).toBe(expected);
    }
  });

  it("does not read arbitrary numbers, timeouts or tool errors as a cause", () => {
    for (const text of [
      "line 512 failed",
      "command timed out after 30s",
      "sandbox denied the patch",
      "file not found: src/a.ts",
      "exit code 401",
    ]) {
      expect(classifyText(text), text).toBe("unknown");
    }
  });
});

describe("failure policy", () => {
  it("waits out network and throttling, hands quota, auth and the like to a person", () => {
    const policy = Object.fromEntries(
      FAILURE_KINDS.filter(isUpstreamKind).map((kind) => [kind, failurePolicy(kind)]),
    );
    expect(policy).toEqual({
      network: { retry: "network" },
      rate_limited: { retry: "upstream" },
      overloaded: { retry: "upstream" },
      provider_error: { retry: "upstream" },
      quota: { retry: "none", fix: "quota" },
      billing: { retry: "none", fix: "billing" },
      auth: { retry: "none", fix: "login" },
      model_unavailable: { retry: "none" },
      context_overflow: { retry: "none", fix: "context" },
      refused: { retry: "none", fix: "refused" },
      invalid_request: { retry: "none", fix: "request" },
    });
  });

  it("turns a classified failure into the error the Bridge handles", () => {
    expect(classifiedFailure("session_invalid", "gone", "t1", true)).toEqual(
      new AgentSessionInvalidError("gone", true),
    );
    const upstream = classifiedFailure("quota", "Quota exceeded", "t1", false);
    expect(upstream).toBeInstanceOf(AgentUpstreamError);
    expect(upstream).toMatchObject({ kind: "quota", threadId: "t1" });
    expect(classifiedFailure("unknown", "x", "t1", false)).toBeUndefined();
  });

  it("guesses the kind from the wording when a caller gives none", () => {
    expect(new AgentUpstreamError("API Error: Can't reach the API server (ENOTFOUND)").kind).toBe(
      "network",
    );
    expect(new AgentUpstreamError("API Error: 529 overloaded").kind).toBe("overloaded");
    // 说不清的上游出错按模型服务出错处理（等一会儿再试）
    expect(new AgentUpstreamError("something odd").kind).toBe("provider_error");
  });

  it("keeps an unclassified Claude Code error as an uncertain result", async () => {
    const error = await claudeFailure([
      { type: "result", subtype: "success", is_error: true, result: "Tool execution aborted" },
    ]);
    expect(error).toBeInstanceOf(AgentExecutionUncertainError);
  });

  it("matches the protocol's failure kinds", () => {
    expect([...FAILURE_KINDS]).toEqual(failureKindSchema.options);
  });
});
