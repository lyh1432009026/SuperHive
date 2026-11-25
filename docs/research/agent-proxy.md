# 本机 Agent 的网络代理

2026-11-25，rd #5882：有用户反馈 SuperHive 里的 agy（Antigravity CLI）调不通，怀疑是服务在海外、要走代理。这里记录各 CLI 对代理的支持、Hive 自己的出网请求、别的应用怎么做，以及最后的方案。

## 结论

- **agy 确实要代理**，而且用环境变量就能走代理。agy 是 Go 写的单文件程序（`go1.28`），用 Go 标准库 `net/http` 的 `ProxyFromEnvironment`，认 `HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY`（大小写都认），`HTTPS_PROXY` 写 `socks5://` 也能用。本机实测（见下表）：直连 60 秒后报 `context canceled`；设了代理以后，几秒内就收到 Google 的应答。
- 问题出在 SuperHive 的启动方式上：**从访达或开始菜单打开客户端时，Agent 拿不到用户在终端里设的代理变量**。`shell-env.ts` 以前只从登录 shell 里读 PATH。另外，Go、Node、Bun 写的 CLI 都不会自己去读 macOS 或 Windows 的系统代理设置。
- 方案：在设置 →「这台电脑」→「网络代理」里提供三种选择，**跟随系统（默认）、手动、不用代理**。Server 按选择算出 Agent 子进程的 `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY`、`NO_PROXY`。只要用了代理，`NO_PROXY` 里就一定带上回环地址和 Hive 自己的地址。

## 各 CLI 认哪些代理变量

本机版本，2026-11-25。「实测」的做法：把代理设成一个没人监听的端口（`http://127.0.0.1:9`），看请求会不会卡住或失败。卡住或失败，说明这个 CLI 读了这个变量；照常成功，说明没读。真代理用本机的 Clash 混合端口 7890，出口在 SG。实测时去掉了本机原有的 `NO_PROXY`，因为它把本机用的模型网关排除在代理之外。

| CLI      | 版本 / 运行时             | 认的变量                                                                                 | socks                                      | 实测                                                                                                                                                                                                                                                        |
| -------- | ------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agy      | 1.5.14，Go 1.28           | `HTTPS_PROXY` `HTTP_PROXY` `NO_PROXY`（大小写），二进制里还有 `ALL_PROXY`                | 支持（`HTTPS_PROXY=socks5://…`）           | 直连：卡 60 秒后 `context canceled`。走 http 和 socks5 代理：都在几秒内收到 Google 的「not currently available in your location」（账号或出口地区的限制，说明已经连上了）。代理端口不通：刷新登录令牌失败，**退回到要求在浏览器里重新登录**，看起来像没登录 |
| claude   | 2.1.330，Bun 1.4.4 单文件 | `HTTPS_PROXY` `HTTP_PROXY` `NO_PROXY`（大小写）                                          | **不支持**（官方文档也这么写）             | 代理端口不通：卡住直到超时。用 Clash 的 http 代理：成功。写成 `socks5://`：卡住直到超时                                                                                                                                                                     |
| codex    | 0.171.0，Rust             | 二进制里有 `HTTPS_PROXY` `ALL_PROXY` `NO_PROXY`（大小写）和 `socks5h`                    | 二进制里有 socks5                          | **代理端口不通时照样成功**：这台电脑的 codex 连的是自定义网关，请求没走环境变量里的代理。原因没查清，可能是这个传输方式或自定义 provider 不读代理变量。连官方 OpenAI 端点的情况没测                                                                         |
| opencode | 1.19.6，Bun 1.4.4         | `HTTPS_PROXY` `HTTP_PROXY` `ALL_PROXY` `NO_PROXY`（Bun 的 fetch 认）                     | 二进制里有 `SocksProxyAgent`，没测         | 代理端口不通：卡住；直连：成功                                                                                                                                                                                                                              |
| omp      | 19.1.0，Bun 1.4.4         | 同 opencode                                                                              | 二进制里有 `socks5://`、`socks5h://`，没测 | 代理端口不通：卡住；直连：成功                                                                                                                                                                                                                              |
| gemini   | 0.70.0，Node              | `HTTPS_PROXY` `HTTP_PROXY` `NO_PROXY`（undici `EnvHttpProxyAgent`），也有 `--proxy` 参数 | 打包了 `SocksProxyAgent`，没测             | 没测：这台电脑没配 `GEMINI_API_KEY`                                                                                                                                                                                                                         |
| copilot  | 1.0.114，Node SEA         | `HTTPS_PROXY` `NO_PROXY`（`EnvHttpProxyAgent`，二进制里还有 `NODE_USE_ENV_PROXY`）       | 没看到                                     | 没测：这台电脑没登录                                                                                                                                                                                                                                        |

几点要注意：

- **socks**：Claude Code 和 Node 写的 CLI 基本不支持 socks；Go（agy）、Rust（codex）、curl 支持。所以手动模式填 socks 地址时，界面上会提示「Claude Code 和 Node 写的 CLI 连不上，能用 http 就用 http」。Clash 这类代理软件的混合端口同时支持 http 和 socks，填 `http://` 最稳。手动填 socks 地址时，同时写进 `HTTPS_PROXY` 和 `ALL_PROXY`，让 Go、Rust 写的 CLI 能用上。
- **大小写**：Go 和 curl 优先读小写的 `https_proxy`，Node 和 Bun 两种都读。Hive 设的时候大小写两份都写，去掉的时候两种都去掉（Windows 上环境变量名不分大小写，去掉时也不分大小写）。
- **回环地址**：Go 的 `net/http` 本来就不让 `localhost`、`127.0.0.1` 走代理，Node、Bun 不一定。Agent 连 Hive 的 WebSocket、Hive MCP 走的都是 `http://127.0.0.1:端口`，所以 `NO_PROXY` 强制带上 `localhost,127.0.0.1,::1,[::1]` 和 Agent 连 Hive 用的那个主机名。
- **代理端口不通时 agy 的表现像没登录**：排查文档里写明了。

## Hive 自己的出网请求

| 谁发                                   | 去哪                                  | 走不走代理                                                                                                                                                          |
| -------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bridge（`hive join`）                  | Hive Server，`127.0.0.1`              | 不该走。`NO_PROXY` 保证不走                                                                                                                                         |
| Server：检查 CLI 新版本、`hive update` | npm 源（或 `~/.npmrc` 里的镜像）      | 不走。Node 24 的 `fetch` 默认不读 `HTTPS_PROXY`，要设 `NODE_USE_ENV_PROXY=1` 才读。国内一般能直连 npm 或镜像，这次不改                                              |
| Server：飞书                           | `open.feishu.cn` 或 lark              | 飞书 SDK 用的是 axios，Node 里的 axios 会读 `HTTPS_PROXY` 环境变量。这是 Server 进程自己的环境，不受这个设置影响。国内服务直连就行                                  |
| Server：微信                           | 国内服务                              | 同上，直连                                                                                                                                                          |
| 桌面端：检查新版本                     | `api.github.com`、GitHub Release 下载 | 走系统代理：`desktop-in-app-update`（8c6da23）已改用 Electron 的 `net.fetch`（Chromium 网络栈，跟随系统代理）。以前用的全局 `fetch` 是 Node 的 undici，不读系统代理 |

所以「网络代理」设置只管 Hive 拉起的本机 Agent 子进程，以及它们再拉起的 claude、agy 等 CLI。Server 自己的请求都去国内服务或 npm，不受影响。

## 别的应用怎么做

- **VS Code / Cursor**：设置里有 `http.proxy`（手动地址）、`http.noProxy`、`http.proxySupport`（`off`、`on`、`fallback`、`override`），默认跟随系统。界面用 Chromium 的系统代理；扩展进程会把 Node 的 `http`、`https` 打补丁成走系统代理，所以扩展不用自己处理。终端里跑的 CLI 要靠用户自己设的环境变量。
- **Claude Desktop、Chrome 系应用**：跟随系统代理（Chromium 网络栈），没有单独的设置。
- **Claude Code CLI**：只认 `HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY`，不支持 socks；企业环境另外用 `NODE_EXTRA_CA_CERTS` 加证书。
- **JetBrains IDE**：「No proxy / Auto-detect proxy settings / Manual proxy configuration」三选一，手动时可以填 HTTP 或 SOCKS、主机、端口、例外列表，可以填账号密码。

共同点：默认跟随系统，提供手动和直连，例外列表单独填，账号密码不明文显示。我们照这个做。

## 方案

### 三种模式

- **跟随系统（默认）**：
  1. 启动 Hive 的环境里已经有 `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY` 中任意一个（大小写都算），就沿用，只把回环地址补进 `NO_PROXY`。用 npm 或 CLI 方式起 Hive 时，就是终端里的环境变量。
  2. 桌面端启动时，从登录 shell 里跑一次 `env`，读回 PATH 和代理变量（`apps/desktop/src/shell-env.ts`）。只在客户端自己的环境里一个代理变量都没有时才补，避免两套混着用。
  3. 环境里没有代理变量，就读系统代理：
     - macOS 用 `scutil --proxy`，也就是网络设置里「代理」那一页，Clash 等「设为系统代理」写的就是这里；
     - Windows 用 `reg query HKCU\…\Internet Settings`，也就是「设置 → 网络 → 代理」。

     读到 https 或 http 代理就写进 `HTTPS_PROXY`、`HTTP_PROXY`，读到 socks 就写进 `ALL_PROXY`。系统设置里的例外列表转成 `NO_PROXY`（`*.local` 写成 `.local`，CIDR 简写这类各家程序不认的写法去掉）。

  4. 都没有就直连。
- **手动**：填 `http://`、`https://`、`socks5://`、`socks5h://`、`socks4://` 地址，没写协议的按 http 处理。必须有主机和端口，不能带路径和查询参数；网页和 Server 各校验一次。原有的代理变量全部去掉，换成手填的，`NO_PROXY` 默认是 `localhost,127.0.0.1,::1,.local`。
- **不用代理**：把 8 个代理变量（四个名字，大小写各一份）从子进程环境里全部去掉。

### 为什么由 Server 读系统代理，不用 Electron 的 `session.resolveProxy`

- npm 或 CLI 方式起的 Hive 没有 Electron，`scutil` 和 `reg` 两种方式都能用。
- 每次启动 Agent 时现读，用户开关代理软件之后，重启 Agent 就能跟上。读一次大约几十毫秒，出错就当作没设代理，不影响启动。
- `resolveProxy` 是按网址算的，主要用在 PAC 上；环境变量本来就表达不了 PAC。系统用的是 PAC（自动代理配置）时，界面上说明读不出地址，请改用手动。
- Linux 没有统一的系统代理接口（GNOME、KDE 各有各的设置），所以只看环境变量；界面上写明「这个系统读不了系统代理设置」。

### 生效时机

只在启动 Agent 子进程时设环境变量，已经在跑的 Agent 不受影响。界面上列出设置改过之后还没重启的 Agent 数，旁边有「重启全部本机 Agent」。复用现有的「重启」接口，会等每个 Agent 手上的任务做完再重启，不打断正在做的事。Agent 日志里记一行 `[hive] 网络代理：http://127.0.0.1:7890`，账号密码打码。

### 账号密码

- 保存在本机 Hive 数据库的 settings 表里，和其它本机设置放在一起，没有另外加密。
- 接口返回和 Agent 日志里一律显示成 `***`。网页把打码的地址原样提交回来时（比如只改了 NO_PROXY），Server 换回原来的账号密码。
- 经其他设备修改时，跟其它本机设置一样，推一条审计提醒给房主。

### 诊断

- Bridge 的失败分类（`packages/superhive/src/failure.ts`）里，「连不上」原来就是 `network` 一类，会自动等网络恢复后再试。这次补上 Go 写的 CLI 的报错：`dial tcp … i/o timeout`、`connection refused`、`no such host`、`TLS handshake timeout`、`proxyconnect tcp`。
- 网页上，本机 Agent 的任务因为 `network` 失败，或正在等网络恢复时，状态旁边出现「可能需要配置代理」按钮，点了直接打开设置里的「网络代理」。只有房主能看到，远程电脑接入的 Agent 不显示。

## 经 Hive 的实测

用这个分支在临时数据目录起了一个 Server（端口 4398，启动环境去掉了 `NO_PROXY`），启动一个本机 agy Agent，在房间里 @ 它：

- 手动设成 `http://127.0.0.1:7890`：Bridge 进程和它拉起的 `agy acp` 进程环境里都有 `HTTPS_PROXY`、`https_proxy`、`HTTP_PROXY`、`http_proxy`、`NO_PROXY`，`NO_PROXY` 带着回环地址。Bridge 连 Hive 正常，agy 正常回复。这台电脑的 agy 用的是 `~/.gemini/.env` 里配的本机 LiteLLM 网关（`127.0.0.1`），所以这一步验证的是「设了代理以后，回环地址照样直连」，没有验证经代理到 Google。经代理到 Google 是上面直接跑 CLI 测的。
- 改成「不用代理」再点重启：新的 Bridge 进程环境里一个代理变量都没有。
- 带账号密码的地址：接口返回、网页、Agent 日志里都是 `***`，数据目录里只有数据库存着原文。
- 网页上「重启全部本机 Agent」：重启后「还在用之前的设置」的计数归零。

## 没做的、没测的

- codex 走自定义网关时不读代理变量，原因没查清。连官方 OpenAI 端点时读不读，也没测。
- gemini、copilot 没有实测，这台电脑没配 key、没登录，只看了包里的代码。
- Windows 的 `reg query` 解析只用拼出来的样例测了，没在真机上读过。
- 系统代理是 PAC 时不支持，界面会提示改用手动。
- Server 自己的出网请求（npm、飞书、微信）不受这个设置影响。
