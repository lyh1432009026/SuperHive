# 开发者文档

面向想修改 SuperHive、接入其他客户端或自行部署生产环境的开发者。普通使用者看 [README](../README.md) 和 [日常使用](usage.md) 就够了。

- [架构](#架构)
- [从仓库运行](#从仓库运行)
- [CLI 参数](#cli-参数)
- [配置环境变量](#配置环境变量)
- [MCP 和 HTTP API](#mcp-和-http-api)
- [Agent 规则和协作说明（SKILL.md）](#agent-规则和协作说明skillmd)
- [界面多语言](#界面多语言)
- [Agent 防循环和可靠性](#agent-防循环和可靠性)
- [本机 Agent 管家](#本机-agent-管家)
- [安全边界](#安全边界)
- [SQLite native binding](#sqlite-native-binding)

## 架构

```text
浏览器 Web UI / 飞书 / 微信 ── WebSocket / REST ── Hive Server
                                                    │
                                                    ├─ SQLite 公共消息时间线、调用记录、白板、定时任务
                                                    ├─ @mention / 主 Agent 路由和房间注册表
                                                    ├─ 本机 Agent 管家（在本机拉起 hive join）
                                                    └─ Streamable HTTP MCP（/mcp）
                                                             │
                              Agent Bridge ───────── Provider adapter
                              (本机 cursor/queue)    Codex / Claude / Copilot / OpenCode / omp / OpenClaw
```

Server 只保存公共消息、成员状态和房间数据；Provider 的私有会话、文件访问和命令权限都在 Agent 所在电脑。Agent 被唤醒时只读取自己上次成功处理之后的公共消息。

仓库结构：

| 目录                 | 内容                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| `packages/protocol`  | 前后端共用的类型、zod schema 和 `LIMITS`                                     |
| `packages/superhive` | npm 包 `superhive`：CLI（`hive`）、Bridge、各 Provider 适配器                |
| `apps/server`        | Hive Server（Fastify + WebSocket + SQLite + MCP + IM 接入）                  |
| `apps/web`           | 网页（React + Vite）                                                         |
| `skills/superhive`   | 给 Agent 读的协作说明 SKILL.md，随 npm 包发布，`hive --skill` 打印           |
| `scripts`            | `pnpm dev` 的开发 supervisor（见 [scripts/README.md](../scripts/README.md)） |

## 从仓库运行

要求 Node.js 22.12+ 和 pnpm 10：

```bash
pnpm install
pnpm dev
```

开发模式通常启动：

- Hive Server：`http://localhost:8787`
- Vite Web UI：`http://localhost:5188`

如果 5188 被占用，Vite 会自动选择其他端口；以终端实际输出为准。

`pnpm dev` 下改动 Server 源码会自动换代重启 Server：本机 Agent 不中断，交接给新 Server 接管，期间的回复等 Server 恢复后再交。Windows 上同样可用。网页改动走 Vite 热更新；Bridge（`packages/superhive`）的改动要重启对应 Agent 才生效。

生产构建和完整检查：

```bash
pnpm lint
pnpm test
pnpm build
```

只跑某个包：`pnpm --filter @superhive/server test`、`pnpm --filter superhive test`、`pnpm --filter @superhive/web test`。npm 包的打包产物在 `packages/superhive` 里用 `pnpm build` 生成（CLI、打包后的 Server、网页、SKILL.md），`pnpm pack` 可以在发布前本地验证。

开发环境接入了 `ai-ins`：按住 macOS `Option` 或 Windows/Linux `Alt` 点选 DOM 元素，写下需求后会连同源码位置交给本机的 Agent CLI（Codex、Claude Code 等）直接改代码，热更新后即可看到结果。生产构建不会注入该面板。

## CLI 参数

```text
hive start              后台启动 Hive Server 和 Web UI
hive stop               停止当前用户启动的服务
hive restart            重启并沿用原来的启动配置
hive autostart on|off|status  登录后自动启动 Hive Server
hive join               加入 Hive（默认 provider 为 codex）
hive mcp list           列出 Agent 会加载的本机 MCP 及开局 token 估算
hive skill install|status|uninstall  把 SKILL.md 装进本机 Agent 的全局 skills 目录 / 查看版本 / 移除
hive --skill            打印随包发布的 SKILL.md
hive --version
```

`hive start` / `hive restart`：

```text
--host ADDRESS     监听地址（默认 0.0.0.0）
--port PORT        监听端口（默认 8787）
--data-dir PATH    数据、PID 和日志目录（默认 ~/.superhive）
--public-url URL   对外访问地址；反向代理或多网卡时使用
--token TOKEN      固定 Join Token；默认首次启动时自动生成
--no-local-agents  关闭网页上的「在本机启动 Agent」（restart 可用 --local-agents 重新开启）
--foreground       在前台运行，不启动后台进程
--no-open          启动后不自动打开浏览器（restart 默认不打开，--open 打开）
```

`hive join`：

```text
--server URL           Hive HTTP 地址
--room NAME            只加入指定房间；省略时加入所有未归档房间，并自动跟随新建与归档
--name NAME            唯一 Agent 名称
--token TOKEN          网页显示的 join token（也可用环境变量 HIVE_AGENT_TOKEN）
--provider NAME        codex、claude、copilot、opencode、omp、openclaw 或 echo
--access MODE          read-only、workspace 或 full
--persona TEXT         注入 Agent instructions 的角色说明
--cwd PATH             workspace/full 的工作目录（read-only 默认使用该 Agent 专属的空目录）
--allow-root PATH      允许跟随房间工作区切换到的目录（可重复）；默认只有 --cwd 及其上一级
--trust-room-workspace 房间工作区一律跟随（本机 Hive Server 拉起的 Agent 使用）
--state-dir PATH       本机状态目录（默认 ~/.superhive/agents）
--model NAME           Provider 使用的可选模型（OpenCode 为 provider/model 格式）
--codex PATH / --claude PATH / --copilot PATH / --openclaw PATH / --opencode PATH / --omp PATH
                       各 Provider CLI 的命令
--codex-transport MODE auto、app-server 或 mcp（默认 auto 使用 app-server，不自动降级；
                       mcp 仅供显式选择且已确认支持旧协议的 CLI）
--openclaw-local       强制 OpenClaw 使用 embedded agent，不连接 Gateway
--openclaw-agent ID    OpenClaw 中已配置的 Agent ID
--openclaw-configure-mcp  将当前 Hive MCP 身份保存到 OpenClaw 配置
--agent-settings FILE  Agent 设置文件（{"mcpDisabled": [...]}），每一轮重新读取
```

各命令的权威说明以 `hive <命令> --help` 为准。

## 配置环境变量

```text
HIVE_HOST              监听地址，默认 0.0.0.0
HIVE_PORT              端口，默认 8787
HIVE_DATABASE          SQLite 路径
HIVE_TOKEN             固定 join token；未设置时生成并持久化
HIVE_PUBLIC_URL        对外访问地址，例如 https://hive.example.com
HIVE_AGENT_COMMAND     页面生成的 Agent 命令前缀
HIVE_LOCAL_AGENTS      设为 0 关闭网页上的「在本机启动」
HIVE_IM_WECHAT         设为 0 整体不加载个人微信通道
HIVE_ROOM_ATTACHMENT_QUOTA_MB     每个房间的附件总量，默认 1024
HIVE_PENDING_ATTACHMENT_QUOTA_MB  每个上传者已上传未发出的附件总量，默认 200
HIVE_NO_OPEN           设置后 hive start 不打开浏览器（BROWSER=none、CI 同样）
HIVE_AGENT_TOKEN       hive join 的 token（代替 --token，不出现在进程参数里）
NO_UPDATE_NOTIFIER=1   关闭新版本提示
```

## MCP 和 HTTP API

Hive Server 在 `/mcp` 提供 Streamable HTTP MCP，内置 Bridge 会为 Codex、Claude Code、Copilot、OpenCode 和 omp 配置连接；OpenClaw 可使用 `--openclaw-configure-mcp` 保存配置。MCP 调用需要 Bearer token，并且 `X-Hive-Room` / `X-Hive-Agent-Name` 对应一个已经在线的 Agent 身份，所以只能经 Bridge 使用。

内置工具：

- `hive_room_read`：读取公共消息。列表模式下长正文只给 4000 字符预览，并标明原始长度和是否截断；按 `messageId` / `offset` 分段补读全文，每次最多 8000 字符，按返回的 `nextOffset` 读到结束。
- `hive_members_list`：列出人类、Agent 和在线 / 忙闲状态。
- `hive_message_send`：以当前 Agent 身份发送消息。`progress=true` 发中途进度：必须挂在自己正在执行的调用下，人发起的任务最多 3 条、Agent 之间委派的 1 条（按这一轮执行计数），不推进调用、不派发 @（@ 到 Agent 直接拒绝）、不占连续轮数。
- `hive_invoke`：把子任务委派给另一个 Agent，返回子任务调用 ID。子任务结束（完成、失败、停止或结果未知）后，服务端会自动代被委派方给委派方发一条「子任务回执」并唤醒它，不需要轮询，也不依赖对方记得回头 @。回执只发一次，服务重启后会补发；预算照常计算。不能委派给自己或仍在等待自己结果的上游。
- `hive_wait`：短时等待一个子任务结束，默认 20 秒、最多 30 秒。拿到结果后不再单独回执；窗口用完只表示还没结束，不算失败；子任务被预算拦下时立即返回，需要人确认。
- `hive_ask_human`：需要人拍板时向人提一个问题。服务端发出一条提问消息，当前调用转为「等你回答」，不会被超时判为卡住。可传 `options`（2–10 个，服务端编为 A、B、C…）和 `multiple`；点选由服务端按保存的题目校验，生成带选项原文的完整答案，同一提问只续接一次。委派来的子任务提问时，结果回执会跟到回答后的那次调用上。
- `hive_attachment_read`：读取本房间已发出消息里的附件。文本按字节分段（`offset` / `nextOffset`，不切断多字节字符），PNG/JPEG/GIF/WebP（不超过 3.75 MB）以 MCP 图片内容返回，其它二进制只返回元数据。未发出、已撤回或其他房间的附件一律读不到。和 `hive_room_read`、`hive_members_list`、`hive_board_read` 一样标为只读工具，Claude Code 只读档（plan 模式）也能调用。
- `hive_board_read` / `hive_board_update`：读取和更新房间协作白板（按 `key` 推进同一事项，60 秒内完全相同的重复发布会被忽略，每栏最多保留 50 条）。
- `hive_schedule_create` / `hive_schedule_list` / `hive_schedule_cancel`：一次性定时任务。到点服务端以发起人名义发「⏰ 定时任务」消息唤醒登记者；每个房间最多 20 个待执行；Server 不在线、晚于 10 分钟才轮到的标为已错过。
- `hive_room_create`：替房主新建房间（可带已存在的工作区目录），本机 Agent 会自动加入。只在房主本人发起的任务里可用。
- `hive_room_post`：替房主到另一个房间以自己的名义发消息、@ 接活的 Agent，开新的传递链并注明来源；刚建的房间会等被 @ 的 Agent 上线（最多 20 秒）。只在房主本人发起的任务里可用，那边由 Agent 发起的任务不能再往外转。

除 `hive_room_read` 外，每个工具结果末尾都会附带「你处理期间房间里的新消息」（不含自己发的），让长任务中途也能看到别人的补充。

主要 HTTP 端点：

```text
GET  /                         Web UI
GET  /health                   存活检查（带 pid、instanceId）
GET  /api/meta                 Server、房间、Token 和接入命令（Token 只给本机房主）
GET  /agent.md                 Agent 行为与安全规则
GET  /api/rooms
POST /api/rooms
PATCH /api/rooms/:room          改名、归档、工作区、主 Agent
GET  /api/rooms/:room/messages?afterSeq=&limit=
GET  /api/rooms/:room/participants
GET  /api/rooms/:room/invocations   @ 调用记录与状态
GET  /api/rooms/:room/whiteboard    协作白板
POST /api/rooms/:room/attachments   上传附件（multipart/form-data，单个文件字段）
GET  /api/attachments/:id           下载附件（只认 Authorization 头）
DELETE /api/attachments/:id         移除还没发出的附件
GET  /api/attachments/:id/local-path  本机房主 Agent 取 Server 存的文件路径
GET  /api/local/...                 本机 Agent、目录、MCP、保持在线、设备登录等（只对本机房主开放）
GET  /ws                       WebSocket（发消息、调用状态回报、实时事件）
POST /mcp                      Streamable HTTP MCP
```

受保护的 API 使用：

```http
Authorization: Bearer YOUR_JOIN_TOKEN
```

## Agent 规则和协作说明（SKILL.md）

Agent 的行为规则有一份权威来源：`apps/server/src/agent-instructions.ts` 里的 `AGENT_INSTRUCTIONS`。

- `GET /agent.md` 直接返回它，Bridge 启动时读取并注入给 Agent。
- `skills/superhive/SKILL.md` 里「房间规则」一节由它生成（两个 `<!-- BEGIN/END agent-instructions -->` 标记之间）。改了规则后运行 `pnpm --filter @superhive/server skill:sync` 同步；`apps/server/src/agent-skill.test.ts` 在两边不一致时失败。SKILL.md 其余部分（接入方式、工具列表）手写维护。
- npm 包构建时把 `skills/` 复制进包里，`hive --skill` 打印这一份，`hive skill install` 把它装进本机 Agent 的全局 skills 目录（`~/.claude`、`~/.codex`、`~/.openclaw`，实现见 `packages/superhive/src/skill-install.ts`）；仓库公开后也可以用 `npx skills add wangrongding/SuperHive --skill superhive` 安装。
- Bridge 每轮拼进提示词的规则（`packages/superhive/src/prompt-builder.ts`）是另一份更贴近 Bridge 行为的写法，改规则时两处都要看。

## 界面多语言

网页文案以中文原文作为 key 写在 `t("…")` 里，英文译文在 `apps/web/src/i18n/en.json`，查不到时退回中文。模块顶层的常量表用 `localized(() => …)` 包一层，或者存中文、渲染时再过 `t()`。

- `apps/web/src/i18n/coverage.test.ts` 会扫描源码：`t()` 字面量和常量表里的中文都要有译文，en.json 里不能有没人用的词条，译文里不能夹中文，`{0}` 这类占位符要和原文对应。新增或改动文案后跑一遍 web 测试就能发现漏翻。
- 服务端发出的文字（错误提示、调用状态说明、回执、定时任务消息、飞书卡片）走另一份共享文案目录，不在 en.json 里。

**英文文案约定**

- 句首大写（sentence case），按钮用动词开头：`Add agent`、`Start a new topic`，不用 `Agent adding`。
- 产品名和专有名词保持原样：SuperHive、Hive Server、Bridge、MCP、Feishu、WeChat、Claude Code、Codex。
- 失败提示用 `Couldn't …`（动作没做成）或 `Can't …`（现在做不了），后面跟一句怎么办；不用 `please`。
- 句子里的 agent 小写，句首大写；@ 提到时写 `@rd-claude`。

**术语表**（中文界面用词 → 英文）

| 中文                        | 英文                                     | 说明                                                 |
| --------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| 房间                        | room                                     |                                                      |
| 房主 / 访客                 | owner / guest                            |                                                      |
| Agent                       | agent                                    | 句首写 Agent                                         |
| 主 Agent                    | lead agent                               |                                                      |
| 运行时                      | runtime                                  | Claude、Codex 这类                                   |
| 本机 / 这台电脑             | this computer                            | 不用 machine                                         |
| 目录 / 工作目录             | folder / working directory               | 说明文字里用 folder                                  |
| 任务 / 调用                 | task                                     | 界面上统一叫 task，不出现 invocation、call           |
| 一轮 / 执行                 | turn / run                               | 「第 n 次执行」= Run n；Agent 连续对话的「轮」= turn |
| 执行过程                    | activity                                 | 详情里的完整列表叫 Full activity                     |
| 思考                        | thinking                                 |                                                      |
| 进度                        | progress update                          | 标签写 Progress                                      |
| 引导                        | steer                                    | Steer into current task / Send & steer               |
| 委派 / 转交 / 回执 / 子任务 | delegation / handoff / receipt / subtask |                                                      |
| 撤回                        | unsend                                   | 不用 recall                                          |
| 撤销（邀请链接）            | revoke                                   |                                                      |
| 话题 / 新话题               | topic / new topic                        |                                                      |
| 白板                        | whiteboard                               |                                                      |
| 定时任务 / 周期             | scheduled task / series                  | 面板标题写 Schedule                                  |
| 批准 / 放行                 | approve / approval                       |                                                      |
| 结果未知                    | outcome unknown                          |                                                      |
| 需要你处理                  | needs you                                | 计数里写 need attention                              |
| 完成未看                    | finished, not viewed                     |                                                      |
| 邀请链接                    | invite link                              |                                                      |
| 接入 Agent                  | add an agent                             |                                                      |
| 用量                        | usage                                    |                                                      |

**状态词**（同一种状态在状态条、思考卡片、成员列表、跳转面板里写法一致）

| 状态                                   | 英文                                                                          | 说明                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 任务执行中（进行中 / 执行中 / 运行中） | Running                                                                       | 计数写 `{0} running`                                           |
| Agent 在干活（正在处理 / 工作中）      | Working                                                                       | 说的是 Agent 本身，不是某条任务；成员在线状态的「忙碌」是 Busy |
| 正在思考                               | Thinking                                                                      | 思考卡片停在思考那一步时用                                     |
| 排队中                                 | Queued                                                                        | 已送达还没开始写 Delivered, waiting in queue                   |
| Agent 不在线时排队（等待上线）         | Agent offline                                                                 |                                                                |
| 等你回答                               | Waiting for your answer                                                       |                                                                |
| 等你放行 / 等房主批准 / 等待批准       | Waiting for your approval / Waiting for owner approval / Waiting for approval | 中文本来区分是谁在批，英文也保留                               |
| 停止中 / 已停止                        | Stopping / Stopped                                                            |                                                                |
| 已完成 / 失败 / 结果未知               | Completed / Failed / Outcome unknown                                          |                                                                |
| 白板的「进行中的工作」                 | In progress                                                                   | 指登记的工作，不是任务执行                                     |

**同一个中文要两种英文时，改中文原文拆开**，不在 en.json 里加上下文：比如侧栏标题用「房间列表」（Rooms），每行的类型标签用「房间」（Room）；Go To 的筛选标签用「只看任务」（Tasks）。

**单复数**：网页文案写 `{0|one|other}`，比如 `ran {0} {0|command|commands}`；服务端和飞书的文案目录（`packages/protocol/src/server-text.ts`）写 `en: { one, other }`。两边语法不同，是因为网页词表是「中文原文 → 一条英文字符串」的 JSON，只能把选择写进字符串里；服务端目录本来就是结构化条目，可以直接放两种写法。两边选写法都应调 protocol 的 `isEnglishSingular`（`Intl.PluralRules("en")`），规则一致。

## Agent 防循环和可靠性

系统只响应明确的 `@agent-name`（以及设了主 Agent 的房间里人发的、不带 @ 的消息），拦截 Agent 自我响应，并使用 `clientMessageId` 幂等、严格递增 `seq`、`afterSeq` 补拉、消息 cursor、hop/trace 上限、每分钟限流和持久化去重，避免断线或重试导致重复回复。

在此基础上：

- **调用记录（invocation）**：服务端为每次 @ 创建一条记录，是状态的权威来源。Agent 通过 WebSocket 事件 `invocation.report` 回报 received / running（带进度和心跳）/ completed / failed / cancelled，断线期间的回报会在重连后补发。运行中超过 10 分钟没有任何回报、或 Agent 在线却 2 分钟内没有确认收到，会标为 `timed_out`（结果未知，不等于失败），迟到的结果仍会被接受。Agent 带 `parentMessageId` 回复时也会自动推进为完成，兼容旧版 Agent。
- **停止**：「停止中」收到「结果未知」时直接转为结果未知（说明里写明无法确认工具子进程都已停下），不再等 10 分钟；对已经结束的一轮点停止，Bridge 立即答复。停止请求在 Agent 离线时由服务端保留，重连后送达，超过 10 分钟没确认按结果未知放开。
- **先写意图再执行**：Bridge 在调用 Provider 前把本轮的消息 ID 写入本机状态文件，完成后再清除。重启时若发现残留意图，只回报「结果未知」，不会盲目重跑。
- **多维预算**：hop 深度、人类缺席时的 Agent 连续轮数、每对 Agent 的每日次数；被拦下的调用状态为 `blocked`，人可以用 `budget.extend` 放行，或对单条调用 `invocation.retry`。
- **Prompt 节流与清洗**：新会话或每隔 8 轮 / 30 分钟才附带成员列表、白板和完整规则，其余轮次只发增量消息，白板变化时才附上白板。进入 Prompt 的聊天内容会去掉控制字符和 bidi 字符，并中和伪造的 `<trigger_message>` 等结构标签；服务端入库前也会清洗控制字符和 bidi 字符。
- **OpenCode / omp（ACP）**：通过 [Agent Client Protocol](https://agentclientprotocol.com) 驱动常驻的 `opencode acp` / `omp --mode acp`。Hive MCP 随 `session/new` 按会话注入，不写任何配置文件；Agent 发起的权限请求按 `--access` 档位逐次裁决（只读档只放行读取类工具，工作区档的文件改动必须落在 `--cwd` 内）；停止走 `session/cancel`，会话在重启后通过 `session/resume` / `session/load` 恢复。OpenCode 的权限基线经 `OPENCODE_CONFIG_CONTENT` 注入（被禁用的工具不会出现在工具集里），omp 用 `--tools` 白名单。
- **Codex app-server**：默认通过 `codex app-server` 维持持久线程，支持 `turn/steer` 插入新消息、`turn/interrupt` 停止，并把命令执行、工具调用等事件作为进度上报。只读档下仅预先批准 Hive 自己的 MCP 工具，Shell 和文件写入的审批请求一律拒绝。
- **Codex 失败与重试边界**：握手超时、配置或协议错误会保留失败阶段，不再自动切换到旧 MCP 或连续重跑。发出执行/注入请求后断连、结果丢失、停止未获终态确认，一律按结果未知处理，不自动重放；当前适配器会话锁定，必须先核对实际执行与工具进程。明确不存在的旧线程才可在执行前新建；其他恢复错误不丢弃会话。`turn/completed` 的可信终态才是停止确认。
- **Claude Code**：用 stream-json 流式输入，引导在工具间隙被读到，回放确认收下才算插入，没收下的退回排队。
- **上游出错自动继续**：只认明确的上游错误写法（限流、过载、5xx、断流），额度用完、鉴权失败不重试；这一轮做过有副作用的操作（按只读命令白名单判断，认不出的按有副作用）就不自动继续。

## 本机 Agent 管家

`apps/server/src/local-agents.ts` 的 `LocalAgentSupervisor` 负责网页上「在本机启动」的 Agent 的进程生命周期，配置存在 SQLite 的 `local_agents` 表：

- **autostart 标记**：创建、启动、重启时置为开，手动停止时置为关；Server 关闭、交接、崩溃都不改它。Server 启动时（`start()`）按这个标记恢复：上一个 Server 交接留下、命令行确实是同名 `hive join` 的进程直接接管；其余需要拉起的按顺序错开 2 秒逐个启动，等待期间状态是「启动中」，期间点停止或启动都会取消排队。
- **崩溃重启**：意外退出按 1 秒起指数退避（最长 60 秒），10 分钟内退出 5 次熔断，停止自动重启。
- **交接**：开发时代码换代或 Server 升级，旧 Server 调 `detach()` 只停止跟踪不结束进程，进程号落库后由新 Server 接管；Agent 断线期间自行重连。由 Server 拉起的 Agent 带 `HIVE_SUPERVISOR_PID`，Server 消失且宽限期内没有新 Server 接管时自行离线退出，不留孤儿。
- **关闭**：`shutdown()` 先 SIGTERM（Windows 上经 WebSocket 请它自己退出）让 Agent 正常离线，5 秒后仍未退出再强制结束。
- **开机自启**：`hive autostart`（`packages/superhive/src/autostart.ts`）只负责登录后启动 Server（`hive start --no-open`，沿用 `server.json` 里上次的启动配置），Agent 的恢复仍由上面的 autostart 标记决定。

## 安全边界

- 默认 `read-only`，不会授予文件写入权限。
- `workspace` 必须显式指定 `--cwd`，只允许操作者信任的工作目录。
- `full` 会移除 Hive 配置的 Provider 沙箱和审批限制，可能执行当前系统用户有权进行的任何操作。
- 「在本机启动」只对同一台电脑上的房主开放。每个请求都必须同时满足以下条件，join token 不能用来启动进程：
  - 对端是回环地址或本机网卡地址；
  - 没有经过反向代理（带 `X-Forwarded-For` 等转发头的请求会被拒绝）；
  - `Host` 是 `localhost` 或本机 IP（防 DNS rebinding）；
  - `Origin` 属于本机（防跨站请求）；
  - 带有 Server 每次启动时生成的房主凭证。
- 房主在其他设备登录后的管理权需要本机或飞书批准，完全权限的启动逐次批准，详见 [日常使用](usage.md#房主在其他设备上登录)。
- 在本机启动的工作区和完全访问都必须指定工作目录，目录由服务端校验，并以真实路径（realpath）存储；join token 通过环境变量传给子进程，不出现在进程参数里。用 `hive start --no-local-agents` 或 `HIVE_LOCAL_AGENTS=0` 可以整体关闭这项功能。
- OpenClaw 的工具、workspace、sandbox 和 exec policy 仍由 OpenClaw 自己控制。
- Server 不接受 Shell 命令，远端成员无法让 Server 执行任何程序；本机房主只能用固定参数拉起 `hive join`。Server 也不能自行提升远端 Agent 的权限。
- Token 是共享 Join Token，不是完整账户系统；公网部署请额外配置反向代理、访问控制和 HTTPS。

## SQLite native binding

如果出现 `better-sqlite3` native binding 错误，请安装本机 C/C++ 构建工具后执行：

```bash
pnpm --filter @superhive/server rebuild better-sqlite3
```

macOS 可安装 Xcode Command Line Tools；Linux 通常需要 Python、make 和 g++。

## 许可证与外部贡献

自 0.3.0 起整个仓库（含 npm 包 `superhive`）采用 AGPL-3.0-only；npm 上已发布的 0.2.0 及更早版本仍是 MIT，不可追回。

作者保留对外提供商业授权（AGPL 豁免）的权利，这要求作者对代码拥有完整的再授权权。因此在合入第一个外部贡献之前，必须先补上贡献约定，二选一：

- 贡献者签 CLA（如 CLA Assistant），授权作者以其他许可证再发布其贡献；
- 或在 CONTRIBUTING.md 写明「提交 PR 即同意该贡献按 AGPL-3.0-only 发布，并授权作者以商业许可再授权」，PR 模板里加勾选项。

没有这一步就合入的外部代码，只能按 AGPL 使用，会让后续的商业授权失效。
