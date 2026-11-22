# 统一失败分类：借鉴 OAR，改进对上游错误的判断

2026-11-23 · rd-claude2 · 分支 `feat/rd-claude2-failure-taxonomy`

背景见 rd-claude4 的 OAR 评估（结论：不引入依赖，只借鉴设计）。这次借鉴的是它的失败分类：先读运行时给的结构化字段，读不到再看原文；每一类附带固定的处理办法。代码是我们自己写的，类名和语义按我们的产品来定。

## 1. OAR 的分类和我们的取舍

OAR（`@botiverse/oar` 0.129.1，`contracts/failure.d.ts`、`observe/failure-advice.js`）一共 14 类：auth、quota、rate_limited、billing、model_unavailable、input_too_large、model_refused、invalid_request、overloaded、provider、runtime_exited、limit_reached、output_schema、unknown。每类附一条处理建议，写成 `{retry: no|now|later, userAction}`。

我们的分类在 `packages/superhive/src/failure.ts`，protocol 里同步了一份取值（`failure-kind.ts`），两边是否一致由测试核对：

| 我们的分类                                           | 对应 OAR                        | 处理办法（`failurePolicy`）                                     |
| ---------------------------------------------------- | ------------------------------- | --------------------------------------------------------------- |
| `network` 连不上模型服务                             | 无（OAR 归到 provider/unknown） | 按断网的 5 档等待，等网络恢复后接着原会话继续                   |
| `rate_limited` 限流                                  | rate_limited                    | 按限流的 2 档等待，然后自动继续                                 |
| `overloaded` 过载                                    | overloaded                      | 同上                                                            |
| `provider_error` 模型服务其他出错（5xx、响应流断开） | provider                        | 同上                                                            |
| `quota` 额度用完                                     | quota                           | 不自动重试，提示人等额度重置或换账号                            |
| `billing` 余额不足或欠费                             | billing                         | 不自动重试，提示人充值                                          |
| `auth` 未登录、凭证无效、无权限                      | auth                            | 不自动重试，提示人重新登录 CLI 或检查 key                       |
| `model_unavailable` 模型用不了                       | model_unavailable               | 不自动重试，提示换个模型重试（沿用原来的 `bridge.modelFailed`） |
| `context_overflow` 上下文超长                        | input_too_large                 | 不自动重试，提示开个新话题，或换上下文更长的模型                |
| `refused` 模型拒答                                   | model_refused                   | 不自动重试，提示换个说法或换模型                                |
| `invalid_request` 请求被拒                           | invalid_request                 | 不自动重试，提示检查运行时或模型配置                            |
| `session_invalid` 会话坏了                           | 无                              | 沿用原来的处理：没执行过工具就开新会话重跑一次                  |
| `unknown` 说不清                                     | unknown                         | 沿用各运行时原来的处理（多数报「结果未知」）                    |

和 OAR 不同的几处：

- **断网单独成类**。我们有断网 5 档重试，而且合盖睡眠、DNS 失败这类情况很常见；OAR 只做分类，不负责重试。
- **会话失效单独成类**。Codex 换了网关之后，会解不开旧会话里加密的推理内容。这一类开新会话就能好，跟模型服务出错是两回事。
- **runtime_exited 没有收进来**。CLI 进程中途退出，我们靠「结果未知」那一套（FailureClass 的 uncertain）处理，关心的是它可能已经执行过什么，不是失败原因。
- **limit_reached、output_schema 不收**。我们不给运行时设轮数上限，也不要求结构化输出，这两类不会出现。
- **分类和执行安全是两件事**。原来 responder.ts 里的 FailureClass（transient、uncertain、unsafe）回答的是「能不能安全重放」，这次保持不变；新分类回答的是「为什么失败、等不等、等多久、要人做什么」。

判断顺序（`classifyFailure`）是：先看原文里的明确写法，再看结构化的错误类别，再看 HTTP 状态码，最后看原文里带上下文的状态码（比如「API Error: 429」）。原文排在第一位，是因为真实样本里结构化字段经常太宽或者不对：

- Claude 把断网也报成 `server_error`；
- Claude 把额度用完也报成 `rate_limit`；
- 模型网关限流时，有时回 400，有时回 403，还带一句「Failed to authenticate」。

原文只认明确的写法，不按任意数字匹配，比如「line 512 failed」「exit code 401」都判成 `unknown`。原文里没有明确写法时，才交给结构化字段，这一点和 OAR 一致。

## 2. 样本从哪来

- **真实 CLI 连假上游**（2026-11-23，本机录制）：起一个假的模型服务，按 Anthropic、OpenAI、Google 各自文档里的错误体格式，返回 429（限流、额度）、529、500、503、401、403、400（余额、上下文超长、参数错）、404，以及网关的「重试渠道均失败」。断网样本是连 `127.0.0.1:9`（连接被拒）和一个不存在的域名。然后让真实 CLI 去连：Claude Code 2.1.283（stream-json）、codex-cli 0.162.1（app-server JSON-RPC）、opencode 1.19.6（`opencode acp`）、Gemini CLI 0.70.0（`--experimental-acp`）。录到的原话和结构化字段原样写进了 `failure.test.ts`。
- **线上日志**：从本机 Agent 日志和 Server 数据库里捞的真实报错，主要是模型网关和 Codex 网关的原话，例如渠道限流、月度额度用完、Bedrock 400、ECONNRESET、ENOTFOUND、`invalid_encrypted_content`。
- **端到端复核**：用真实的 `ClaudeCodeResponder`、OpenCode 和 Gemini 的 AcpResponder 拉起真实 CLI 连假上游，确认抛出的错误类型和分类都对：Claude 6 种、OpenCode 5 种、Gemini 4 种，全部是 `AgentUpstreamError`，分类正确。

**拿不到样本的**（报告里注明，测试里只有按原文写的用例）：

- GitHub Copilot CLI、OpenClaw：都走各自的账号体系，接不上假上游。现在只看它们 stderr 的原话分类，规则和其他运行时共用一套。
- omp、agy：要改各自的模型配置文件才能指向假上游，这次没做。它们走 ACP，和 opencode、Gemini 用同一套 `classifyAcp`。
- Claude 未登录（`authentication_failed`，状态码为空）：本机已经登录，复现不了。规则按 OAR 记录的写法「Not logged in · Please run /login」补上了。
- Gemini 的 429：Gemini CLI 自己会退避重试，150 秒内都没把错误报出来，所以没录到。Google 把每分钟配额超限也写成「Quota exceeded」，这种情况按限流处理。
- Codex 断网：Codex 自己一直在等网络（`willRetry: true`，「Reconnecting... waiting for network」），回合不会失败，我们这边收不到失败。

## 3. 对照表：每类的真实报错、原来怎么判、现在怎么判

「原来」是用 main（d229015）上的 `isSessionInvalid`、`isModelUnavailable`、`isUpstreamFailure` 和各运行时原来的兜底逻辑，对同一批样本逐条跑出来的结果，不是推断。

| 样本           | 运行时：真实报错（节选）                                                                                                                                                                                         | 原来                                                                                                                      | 现在                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 限流 429       | Claude：`error: rate_limit`，`api_error_status: 429`，「API Error: Request rejected (429) · This request would exceed your organization's rate limit…」                                                          | 限流，2 档                                                                                                                | `rate_limited` ✓                                             |
|                | Codex：`responseTooManyFailedAttempts{httpStatusCode:429}`，「exceeded retry limit, last status: 429 Too Many Requests」                                                                                         | 限流                                                                                                                      | `rate_limited` ✓                                             |
|                | opencode：-32603 `APIError`，「Rate limit reached for gpt-5 … (TPM)」                                                                                                                                            | 限流                                                                                                                      | `rate_limited` ✓                                             |
| 额度用完       | Claude：`error: rate_limit`，429，「…You have reached your specified API usage limits. You will regain access on 2026-12-01」                                                                                    | ✗ 结果未知                                                                                                                | `quota`，提示等额度重置                                      |
|                | Codex：`usageLimitExceeded`，「Quota exceeded. Check your plan and billing details.」                                                                                                                            | ✗ 结果未知                                                                                                                | `quota`                                                      |
|                | opencode：「You exceeded your current quota, please check your plan and billing details.」                                                                                                                       | ✗ 普通错误，自动重跑 3 次                                                                                                 | `quota`                                                      |
|                | 线上：网关「重试渠道均失败…You have reached your specified workspace API usage limits…」                                                                                                                         | ✗ 当成限流，重试 2 次                                                                                                     | `quota`                                                      |
|                | 线上：网关里一个渠道额度用完、另一个渠道限流                                                                                                                                                                     | 限流                                                                                                                      | `rate_limited`（等一会儿可能轮到还有额度的渠道，保持原行为） |
| 过载 529/503   | Claude：「API Error: 529 Overloaded…」；Codex：`httpConnectionFailed{529}`、`{503}`；opencode、Gemini：「The server is overloaded」                                                                              | 限流                                                                                                                      | `overloaded` ✓                                               |
| 5xx            | Claude：`server_error`，500，「API Error: 500 Internal server error…」                                                                                                                                           | 限流                                                                                                                      | `provider_error` ✓                                           |
|                | Codex：`internalServerError`，「We're currently experiencing high demand…」                                                                                                                                      | ✗ 结果未知                                                                                                                | `provider_error`，自动继续                                   |
|                | opencode：「The server had an error while processing your request.」；Gemini：code 500，`INTERNAL`                                                                                                               | ✗ 普通错误，重跑 3 次                                                                                                     | `provider_error`                                             |
| key 无效 401   | Claude：`authentication_failed`，401，「Invalid API key · Fix external API key」                                                                                                                                 | ✗ 结果未知                                                                                                                | `auth`，提示重新登录                                         |
|                | Codex：`httpConnectionFailed{401}`，「Incorrect API key provided…」                                                                                                                                              | ✗ 结果未知                                                                                                                | `auth`                                                       |
|                | opencode、Gemini（code 401，`UNAUTHENTICATED`）                                                                                                                                                                  | ✗ 普通错误，重跑 3 次                                                                                                     | `auth`                                                       |
| 无权用模型 403 | Codex、opencode、Gemini：「You are not allowed to sample from this model」                                                                                                                                       | ✗ 结果未知 / 重跑 3 次                                                                                                    | `model_unavailable`                                          |
| 余额不足       | Claude：`billing_error`，400，「Credit balance is too low」；Codex：`other` + `billing_hard_limit_reached`；opencode：「Billing hard limit has been reached」                                                    | ✗ 结果未知 / 重跑 3 次                                                                                                    | `billing`                                                    |
| 上下文超长     | Claude：`terminal_reason: prompt_too_long`，「Prompt is too long · …」；Codex：`other` + `context_length_exceeded`；opencode：`ContextOverflowError`；Gemini：「Your input exceeds the context window…」         | ✗ 结果未知 / 重跑 3 次                                                                                                    | `context_overflow`                                           |
| 模型不存在 404 | Claude：`model_not_found`，「There's an issue with the selected model…」；Codex：`{404}`；opencode                                                                                                               | 模型 ✓                                                                                                                    | `model_unavailable` ✓                                        |
|                | Gemini：code 500，「The model `gpt-nope-9` does not exist…」                                                                                                                                                     | ✗ **会话失效**：AcpRpcError 的说明前缀「session/prompt 失败：」和后面的「does not exist」凑在 40 个字以内，被会话正则误判 | `model_unavailable`（分类改用不带前缀的原话）                |
| 参数错 400     | Claude：`error: unknown`，400，「API Error: 400 messages.0.content…」；Codex：`other` + `invalid_request_error`；Gemini：`INVALID_ARGUMENT`                                                                      | 结果未知 / 重跑 3 次                                                                                                      | `invalid_request`，不自动重试                                |
|                | opencode：「Invalid value for 'input'.」（没有状态码，也没有类别）                                                                                                                                               | 重跑 3 次                                                                                                                 | `unknown`，沿用原行为                                        |
| 网关渠道失败   | 四个运行时：400 +「重试渠道均失败…该渠道已达到请求速率限制」；线上还见过 403 +「Failed to authenticate」开头、Bedrock 400、`No available OAuth *** in pool`                                                      | 限流                                                                                                                      | `rate_limited`（行为不变）                                   |
| 断网           | Claude：`server_error`，状态码为空，「Connection refused…(ECONNREFUSED)」「Can't reach the API server…(ENOTFOUND)」；opencode：「Cannot connect to API: ECONNREFUSED」；Gemini：「fetch failed sending request」 | 断网，5 档                                                                                                                | `network` ✓                                                  |
| 会话失效       | 线上 Codex：`invalid_encrypted_content`                                                                                                                                                                          | 会话失效 ✓                                                                                                                | `session_invalid` ✓                                          |
| 模型拒答       | ACP `stopReason: refusal`                                                                                                                                                                                        | ✗ 普通错误，重跑 3 次                                                                                                     | `refused`，不自动重试                                        |

问题汇总：

- **漏判**：额度、余额、认证、上下文超长、403 这几类，原来都没有单独判断。结果是 Claude 报「结果未知」，Codex 报「回合已报告失败」，ACP 运行时则当普通错误走通用重试（间隔 1 秒、2 秒，共 3 次）。这些错误等多久都不会好，ACP 的重跑还会把已经发出去的这一轮再执行一遍。
- **误判**：
  - 月度额度用完被当成限流，白白自动重试 2 次；
  - Codex 的 `internalServerError` 被当成结果未知，本来应该自动继续；
  - ACP 运行时「模型不存在」被当成会话失效，结果开了新会话重跑，换来的是同样的失败。

## 4. 改了什么

- `packages/superhive/src/failure.ts`（新增）：分类定义、处理办法表、`classifyFailure`，以及三个运行时适配：
  - `classifyClaude`：读错误类别、`api_error_status`、`terminal_reason`；
  - `classifyCodex`：读 `codexErrorInfo` 的具名值、带状态码的传输错误，`other` 时解析服务商的 JSON 错误体；
  - `classifyAcp`：Gemini 的 `error.code` 就是 HTTP 状态码，opencode 用 `data.errorName`，另外解析 Google 和 OpenAI 的错误体。

  所有认报错原文的正则都集中在这一个文件里。

- `responder.ts`：删掉 `isNetworkFailure`、`isUpstreamFailure`、`isSessionInvalid`、`isModelUnavailable`。`AgentUpstreamError.kind` 改成上面的分类，原来的 transient、model、network 三种去掉了。新增 `classifiedFailure`，把分好类的失败转成 Bridge 认的错误类型。
- 各运行时：
  - `claude-stream.ts`：把合成 assistant 帧上的错误类别、result 里的 `api_error_status` 和 `terminal_reason` 记下来；
  - `claude-client.ts`、`codex-app-server-client.ts`、`acp-responder.ts`：改用对应的适配函数。`AcpRpcError` 保留不带前缀的原话和 `data`。ACP 的 auth_required 判断也改走分类。ACP 的拒答改为 `refused`；
  - `codex-client.ts`：判断会话是否失效改走分类；
  - `copilot-client.ts`、`openclaw-client.ts`：没有结构化字段，按 CLI 原话分类，认得出的交给 Bridge。会话只在续接已有会话时带上。
- `bridge.ts`：`handleUpstreamError` 按 `failurePolicy` 决定走断网档、限流档还是不重试，失败说明里的 `why` 换成对应的 `bridge.fix.*` 提示。上报时带上 `failure`：等待中的进度、等待心跳、最终失败都带。会话失效的上报也带。
- `bridge-text.ts` 和 protocol 的 `server-text.ts`：新增 6 条 `bridge.fix.*` 提示，中英文都有。说明用的仍然是 `bridge.upstreamFailed` 这个键，所以网页上的「继续」按钮、Server 端的续接原会话、需要你处理的提醒、`failureClass`，这些都不用改。
- protocol：新增 `failureKindSchema`。`invocation.report` 和 `Invocation` 加了可选的 `failure` 字段。旧版 Server 会忽略这个字段，旧版 Bridge 不带也没问题。
- Server：
  - invocations 表新增 `failure` 列，和 detail 一起写入、一起清空，重试时会自动清掉；
  - 故障单的指纹加上失败原因，比如 `invocation:bridge.upstreamFailed:quota:claude`，限流和额度用完不再合成一张单；
  - 故障单标题末尾带上原因；
  - 归属按原因判断：`invalid_request` 记为 unknown，只记录、不自动派修，其余都是 external。

**没动的**：

- `codex-errors.ts` 里启动阶段的诊断，比如「CLI 进入了交互终端模式」「Codex 配置不兼容」。这些是安装和配置问题，不是上游出错。
- Server 端 `incidents.ts` 里判断「没能复核任务目录」的正则。它匹配的是我们自己写死的文案，用来把这类问题归给我们自己。

## 5. 行为变化

- 额度用完、余额不足、认证失效、上下文超长、模型拒答、请求被拒：原来是结果未知，或者自动重跑 3 次；现在一次就停，说明里写明要人做什么。点「继续」会接着原会话往下做。
- Codex 的 `internalServerError`，以及 ACP 运行时的 5xx：原来是结果未知或重跑 3 次，现在和其他 5xx 一样，按 2 档自动继续。
- 纯额度用完的网关报错：原来自动重试 2 次，现在直接交给人。网关里多个渠道、只是其中一个额度用完的，仍然按限流处理。
- ACP 的「模型不存在」：原来会开新会话重跑一次，现在直接提示换模型。
- 断网 5 档重试、限流 2 档重试、等待期间的心跳、会话失效重跑一次、结果未知不自动重放：这些都没变，原有测试全部照旧通过。

## 6. 测试

- `failure.test.ts`（新增，72 条）：
  - 四个运行时的真实样本共 48 条，Claude 那部分走真实 `ClaudeCodeResponder` 的解析；
  - 线上日志样本 14 条；
  - 原 `responder.test.ts`、`trace.test.ts` 里的正则用例，按新分类整体搬了过来；
  - 处理办法表、`classifiedFailure`、和 protocol 取值一致性的检查。
- `bridge-behavior.test.ts`：新增 6 种不重试分类的用例，检查不自动重试、提示键正确、点「继续」接着原会话；另外检查等待、心跳、最终失败时都带着 `failure`。
- `claude-client.test.ts`、`acp-responder.test.ts`、`codex-app-server-client.test.ts`：key 无效改为 `auth`，拒答改为 `refused`，`model` 改名为 `model_unavailable`。
- Server：`incidents.test.ts` 检查按失败原因分单、归属判断、旧版 Bridge 兼容；`incidents.integration.test.ts` 检查真实 Server 落库、推送 `failure` 和按原因分单。
- 结果：protocol 75、superhive 566、server 563、web 521，全部通过；全仓 lint 通过。

## 7. 后续可以做

- Codex 的 `error` 通知里 `willRetry: true` 时，可以像 Claude 的 `api_retry` 那样上报 `provider_error`，让网页显示「API 异常，等待恢复」。前提是先补上「已恢复」的判断，这次没做。
- 额度用完时，报错里常带重置时间，比如「regain access on 2026-12-01」、Codex 的 `resets_at`。以后可以解析出来，让网页显示「X 点后可继续」，或者到点自动继续。
- 参照 OAR 的 `docs/spec/runtime-matrix.md`，给每个运行时做一份失败证据矩阵，CLI 升级后用录制脚本重录一遍样本，看各家的说法有没有变。
