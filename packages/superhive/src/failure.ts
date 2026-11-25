/**
 * 统一失败分类：这一轮为什么失败（失败原因）。和 responder.ts 里的 FailureClass（transient / uncertain /
 * unsafe，失败后能不能安全重放）是两件事：原因决定等不等、等多久、要人做什么，能否重放仍按执行安全判断。
 *
 * 各运行时把原生报错先映射到这里（classifyClaude、classifyCodex、classifyAcp），Bridge 只看分类，
 * 不再自己读报错文本。判断顺序参考 OAR（botiverse/oar）的做法：运行时给的结构化字段（错误类别、HTTP 状态码、
 * 服务商错误码）优先；只有它们说不清时才看报错原文，原文只认明确的写法，不按任意数字匹配。
 * 例外是网关：有的网关限流时回 400 / 403，甚至写「Failed to authenticate」，原因写在后面，这时原文比状态码可信。
 *
 * 对照表与真实样本见 docs/research/failure-taxonomy.md；样本测试在 failure.test.ts。
 * 新增分类要同步 @superhive/protocol 的 failureKindSchema（failure.test.ts 核对）。
 */
export const FAILURE_KINDS = [
  /** 连不上模型服务：断网、合盖睡眠、DNS、连接被拒或被重置。请求没送到模型 */
  "network",
  /** 短时限流（429、网关渠道限流）：等一会儿就好 */
  "rate_limited",
  /** 模型服务过载（529、503） */
  "overloaded",
  /** 模型服务其他出错（5xx、响应流中断） */
  "provider_error",
  /** 用量额度用完（套餐周期、组织月度上限）：到重置时间才恢复，自动重试没用 */
  "quota",
  /** 余额不足、欠费、付费上限 */
  "billing",
  /** 没登录、凭证无效或过期、没有权限 */
  "auth",
  /** 选的模型用不了（不存在、下线、没开通） */
  "model_unavailable",
  /** 输入超出模型的上下文长度 */
  "context_overflow",
  /** 模型拒绝回答 */
  "refused",
  /** 请求本身被模型服务拒绝（400 且说不出更具体的原因） */
  "invalid_request",
  /** 会话坏了续不下去（解不开旧会话的加密内容、找不到之前的会话）：换个新会话就好 */
  "session_invalid",
  /** 说不清 */
  "unknown",
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** 交给 AgentUpstreamError 的分类：会话失效另走 AgentSessionInvalidError，说不清的不算上游出错 */
export type UpstreamFailureKind = Exclude<FailureKind, "session_invalid" | "unknown">;

/**
 * 每类怎么处理：
 * - retry：network=断网那几档（等得久，直到网络回来）；upstream=限流过载那几档；none=不自动重试
 * - fix：要人做什么才会好，对应 bridge-text 里 bridge.fix.* 的提示；没有的表示点「继续」即可。
 *   模型用不了另有专门的说明和「换个模型重试」（bridge.modelFailed），不走这里
 */
export type FailurePolicy = {
  retry: "network" | "upstream" | "none";
  fix?: "login" | "quota" | "billing" | "context" | "refused" | "request";
};

const POLICIES: Readonly<Record<UpstreamFailureKind, FailurePolicy>> = {
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
};

export function failurePolicy(kind: UpstreamFailureKind): FailurePolicy {
  return POLICIES[kind];
}

export function isUpstreamKind(kind: FailureKind): kind is UpstreamFailureKind {
  return kind !== "session_invalid" && kind !== "unknown";
}

/** 运行时报出的失败证据：status=服务商的 HTTP 状态码；code=运行时或服务商给的错误类别；text=原文 */
export type FailureEvidence = {
  status?: number | null | undefined;
  code?: string | null | undefined;
  text?: string | null | undefined;
};

/**
 * 服务商与运行时的错误类别 → 分类：OpenAI 的 error.code、Anthropic 的 error.type、
 * Claude Code 合成错误消息上的 error、Codex 的 codexErrorInfo、Gemini 的 error.status、opencode 的 errorName。
 * 只收真实见过的；server_error、invalid_request_error 这类宽泛的类别先看原文再落到这里。
 */
const CODES: Readonly<Record<string, FailureKind>> = {
  // OpenAI
  invalid_api_key: "auth",
  model_not_found: "model_unavailable",
  rate_limit_exceeded: "rate_limited",
  insufficient_quota: "quota",
  usage_limit_reached: "quota",
  usage_not_included: "quota",
  billing_hard_limit_reached: "billing",
  context_length_exceeded: "context_overflow",
  server_is_overloaded: "overloaded",
  server_error: "provider_error",
  invalid_encrypted_content: "session_invalid",
  previous_response_not_found: "session_invalid",
  // Anthropic error.type
  authentication_error: "auth",
  permission_error: "auth",
  not_found_error: "model_unavailable",
  rate_limit_error: "rate_limited",
  billing_error: "billing",
  overloaded_error: "overloaded",
  api_error: "provider_error",
  invalid_request_error: "invalid_request",
  // Claude Code 合成错误消息（assistant 帧的 error 字段，2.1.283 实测）
  authentication_failed: "auth",
  rate_limit: "rate_limited",
  invalid_request: "invalid_request",
  // Claude Code result 的 terminal_reason
  prompt_too_long: "context_overflow",
  // Codex codexErrorInfo（0.162.1 实测，另见 app-server 协议定义）
  unauthorized: "auth",
  modelNotFound: "model_unavailable",
  usageLimitExceeded: "quota",
  rateLimitExceeded: "rate_limited",
  serverOverloaded: "overloaded",
  internalServerError: "provider_error",
  contextWindowExceeded: "context_overflow",
  // Gemini（Google API 的 error.status）
  RESOURCE_EXHAUSTED: "rate_limited",
  UNAVAILABLE: "overloaded",
  INTERNAL: "provider_error",
  UNAUTHENTICATED: "auth",
  PERMISSION_DENIED: "auth",
  NOT_FOUND: "model_unavailable",
  INVALID_ARGUMENT: "invalid_request",
  // opencode（JSON-RPC error.data.errorName）
  ContextOverflowError: "context_overflow",
};

/** HTTP 状态码本身的意思（各家 API 文档一致的部分）；说不出的返回 undefined */
function statusKind(status: number): FailureKind | undefined {
  if (status === 400) return "invalid_request";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "billing";
  if (status === 404) return "model_unavailable";
  if (status === 413) return "context_overflow";
  if (status === 429) return "rate_limited";
  if (status === 503 || status === 529) return "overloaded";
  if (status >= 500 && status <= 599) return "provider_error";
  return undefined;
}

// —— 原文里的明确写法。顺序有讲究：前面的说法比后面的可信 ——

const SESSION_INVALID =
  /invalid_encrypted_content|encrypted content[^.]*could not be (?:verified|decrypted)|previous_response_not_found|previous response[^.]*not found|no (?:conversation|rollout) found|(?:thread|session|conversation|rollout)[^.]{0,40}(?:not found|does not exist|could not be (?:found|loaded|parsed))|failed to (?:load|parse|read) (?:rollout|session|thread)|corrupt(?:ed)? (?:rollout|session)/i;
const CONTEXT_OVERFLOW =
  /prompt (?:is )?too long|context_length_exceeded|exceeds the context window|maximum context length|context (?:window|length) exceeded|context exceeds model limit|ContextOverflowError|上下文(?:长度)?超(?:出|过|长)/i;
/** 凭证本身不对：写明是 key 无效、没登录 */
const AUTH_CREDENTIAL =
  /invalid[ _-]?(?:x-)?api[ _-]?key|incorrect api key|api key (?:is )?(?:missing|invalid|not valid)|missing api key|authentication_error|authentication required|not (?:logged|signed) in|not authenticated|please (?:run \/login|log ?in|sign ?in)|(?:log|sign) ?in required|(?:missing|no|invalid|expired) credentials?|credentials? (?:are |is )?(?:missing|required|invalid|expired|not found)|UNAUTHENTICATED|令牌已过期|未登录/i;
const BILLING = /billing|credit balance|payment required|余额不足|欠费|账户余额/i;
const QUOTA =
  /insufficient_quota|quota exceeded|exceeded your (?:current )?quota|usage_limit_reached|usage limit (?:reached|exceeded)|reached your (?:specified )?(?:workspace )?API usage limits|usageLimitExceeded|额度已用(?:完|尽)/i;
const PER_MINUTE = /per (?:minute|second)|\b[RT]PM\b/i;
/** 网关把同一请求轮流发给多个渠道都失败了：各渠道原因拼在后面 */
const GATEWAY_ALL_FAILED = /重试渠道均失败/;
const THROTTLED = /速率限制|限流|rate[ _-]?limit|too many requests|RESOURCE_EXHAUSTED/i;
/** 认证没过，但没说是凭证错：网关限流时也会这么写，排在限流之后 */
const AUTH_FAILED = /failed to authenticate|unauthori[sz]ed|authentication failed/i;
const MODEL_UNAVAILABLE =
  /model_not_found|not_found_error[\s\S]{0,80}\bmodel\b|model[^.]{0,40}(?:does not exist|not found|not supported|is not available|unavailable|deprecated|has been (?:deprecated|retired|removed))|unknown model|invalid model|no such model|issue with the selected model|unrecognized_model|not allowed to sample from this model|模型不存在|模型已下线/i;
const FORBIDDEN = /\bforbidden\b|permission_error|PERMISSION_DENIED|does not have permission/i;
/** 连不上：Node 的错误码、各 CLI 的说法，以及 Go 写的 CLI（agy）的 net/http 报错 */
const NETWORK =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN|socket hang up|Connection error|Connection dropped|Can't reach the API server|Cannot connect to API|fetch failed|network (?:error|is unreachable)|getaddrinfo|waiting for network|dial tcp [^\n]*(?:i\/o timeout|connection refused|connection reset)|no such host|TLS handshake timeout|proxyconnect tcp/i;
const OVERLOADED = /overloaded|server overload|service unavailable|服务繁忙/i;
const PROVIDER_ERROR =
  /bad gateway|gateway time-?out|internal server error|stream (?:error|disconnected)|response stream was interrupted|upstream error|server had an error/i;
const INVALID_REQUEST = /invalid_request_error/i;
/** 带上下文的状态码：「API Error: 429」「status 503」「HTTP 502」「Request rejected (429)」 */
const STATUS_IN_TEXT =
  /(?:API Error:?\s*|(?:status|statusCode|status_code|HTTP)[\s:=/]*|Request rejected \()(\d{3})\b/i;

/** 只看原文的明确写法；说不清返回 undefined */
function textKind(text: string): FailureKind | undefined {
  if (!text) return undefined;
  if (SESSION_INVALID.test(text)) return "session_invalid";
  if (CONTEXT_OVERFLOW.test(text)) return "context_overflow";
  if (AUTH_CREDENTIAL.test(text)) return "auth";
  // 额度在前：OpenAI 额度用完的原文是「…please check your plan and billing details」
  if (QUOTA.test(text)) {
    // 网关轮了多个渠道：有的额度用完、有的只是限流，等一会儿可能换到还有额度的渠道；
    // Google 把每分钟的配额也叫 Quota exceeded，那是限流
    if (GATEWAY_ALL_FAILED.test(text) && THROTTLED.test(text)) return "rate_limited";
    return PER_MINUTE.test(text) ? "rate_limited" : "quota";
  }
  if (BILLING.test(text)) return "billing";
  if (THROTTLED.test(text) || GATEWAY_ALL_FAILED.test(text)) return "rate_limited";
  if (AUTH_FAILED.test(text)) return "auth";
  if (MODEL_UNAVAILABLE.test(text)) return "model_unavailable";
  if (FORBIDDEN.test(text)) return "auth";
  if (NETWORK.test(text)) return "network";
  if (OVERLOADED.test(text)) return "overloaded";
  if (PROVIDER_ERROR.test(text)) return "provider_error";
  if (INVALID_REQUEST.test(text)) return "invalid_request";
  return undefined;
}

/**
 * 综合判断：原文的明确写法 → 结构化类别 → HTTP 状态码 → 原文里带上下文的状态码。
 * 原文排第一是因为结构化字段常常太宽（server_error 也可能是断网，rate_limit 也可能是额度用完），
 * 网关还会给错状态码；原文只认明确写法，没有就交给结构化字段。
 */
export function classifyFailure(evidence: FailureEvidence): FailureKind {
  const byText = textKind(evidence.text ?? "");
  if (byText) return byText;
  const byCode = evidence.code ? CODES[evidence.code] : undefined;
  if (byCode) return byCode;
  if (typeof evidence.status === "number") {
    const byStatus = statusKind(evidence.status);
    if (byStatus) return byStatus;
  }
  const quoted = Number(STATUS_IN_TEXT.exec(evidence.text ?? "")?.[1]);
  return (quoted && statusKind(quoted)) || "unknown";
}

/**
 * Claude Code（stream-json）：出错时先写一条合成的 assistant 消息（error 字段是错误类别），
 * 再写 is_error 的 result（api_error_status、terminal_reason、result 原文）。2.1.283 实测见 failure.test.ts。
 */
export function classifyClaude(facts: {
  category?: string | undefined;
  status?: number | null | undefined;
  terminalReason?: string | undefined;
  text?: string | undefined;
}): FailureKind {
  if (facts.terminalReason === "prompt_too_long") return "context_overflow";
  // 「unknown」不是类别；server_error 只说明不是客户端的错，断网、过载、5xx 都这么报，交给原文和状态码
  const category =
    facts.category && facts.category !== "unknown" && facts.category !== "server_error"
      ? facts.category
      : undefined;
  return classifyFailure({ status: facts.status, code: category, text: facts.text });
}

const CODEX_TRANSPORT = [
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
] as const;

/**
 * Codex app-server：失败回合的 turn.error（也是 error 通知的 error）。codexErrorInfo 是具名的类别，
 * 或者带 httpStatusCode 的传输错误；other 时 message 是服务商原样的 JSON 错误体。0.162.1 实测见 failure.test.ts。
 */
export function classifyCodex(error: unknown): FailureKind {
  const record = asRecord(error);
  const message = typeof record?.message === "string" ? record.message : "";
  const details = typeof record?.additionalDetails === "string" ? record.additionalDetails : "";
  const info = record?.codexErrorInfo;
  let code: string | undefined;
  let status: number | undefined;
  if (typeof info === "string" && info !== "other") code = info;
  const transport = asRecord(info);
  for (const variant of CODEX_TRANSPORT) {
    const entry = asRecord(transport?.[variant]);
    if (!entry) continue;
    if (typeof entry.httpStatusCode === "number") status = entry.httpStatusCode;
    // 流断了又没有状态码：没收到服务商的回应，算模型服务出错（断网时原文会写明）
    else code = "server_error";
  }
  const body = providerBody(message);
  return classifyFailure({
    status,
    code: code ?? body?.code ?? body?.type,
    text: [body?.message ?? message, details].filter(Boolean).join(" "),
  });
}

/**
 * ACP 运行时（opencode、Gemini CLI、omp、agy）：session/prompt 的 JSON-RPC 错误。
 * Gemini CLI 把 HTTP 状态码放在 error.code、Google 的错误体放在 message；opencode 用 -32603，
 * 类别在 data.errorName；其余只能看原文。
 */
export function classifyAcp(error: {
  code?: number | undefined;
  message: string;
  data?: unknown;
}): FailureKind {
  const status =
    typeof error.code === "number" && error.code >= 400 && error.code <= 599
      ? error.code
      : undefined;
  const errorName = asRecord(error.data)?.errorName;
  const body = providerBody(error.message.replace(/^.*?(?=[[{])/s, ""));
  return classifyFailure({
    status,
    code: (typeof errorName === "string" ? errorName : undefined) ?? body?.code ?? body?.type,
    text: body?.message ? `${body.message}` : error.message,
  });
}

/** 只看原文：没有结构化字段的运行时（Copilot、OpenClaw 的 stderr）和旧调用方用 */
export function classifyText(text: string): FailureKind {
  return classifyFailure({ text });
}

/**
 * 服务商原样的 JSON 错误体：OpenAI {error:{code,type,message}}、Anthropic {type:"error",error:{type,message}}、
 * Google [{error:{code,status,message}}]。code 取服务商错误码，没有时取 Google 的 status。
 */
function providerBody(
  text: string,
): { code?: string; type?: string; message?: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const error = asRecord(asRecord(Array.isArray(value) ? value[0] : value)?.error);
  if (!error) return undefined;
  const pick = (key: string) =>
    typeof error[key] === "string" ? (error[key] as string) : undefined;
  const code = pick("code") ?? pick("status");
  const type = pick("type");
  const message = pick("message");
  return {
    ...(code ? { code } : {}),
    ...(type ? { type } : {}),
    ...(message ? { message } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
