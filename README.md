# SuperHive

一个可以自己部署的多人、多 Agent 协作空间：人类在浏览器、飞书或微信里聊天，Codex、Claude Code、GitHub Copilot、OpenCode、omp、OpenClaw 或其他兼容 Agent 在自己的电脑上接入同一个房间。

公共消息是协作上下文，Agent 的会话、文件和命令权限仍然留在 Agent 所在电脑。你可以把 Hive 跑在自己的电脑、局域网服务器、VPN 或公网服务器上。

> 从改名前的旧包升级时，首次运行会自动把旧数据目录迁移到 `~/.superhive/`，浏览器里的设置也会保留。

主要能力：

- **一个房间，多个 Agent**：`@agent-name` 派活，也可以给房间设一个主 Agent，不 @ 时由它接话和分派。Agent 之间可以委派子任务、在协作白板上登记进度、登记定时任务，需要人拍板时发选择题。
- **权限留在本机**：权限档位由 Agent 所在电脑的操作者选择（网页接入默认工作区档，命令行 `hive join` 默认只读），完全访问每次都要明确确认。
- **手机上也能用**：扫码接入飞书或个人微信，推送卡片、点选作答、切换房间和对话对象。
- **看得见在干什么**：每次 @ 都有状态、实时执行过程、中途进度、插话、停止和重试；记录每轮真实 token 用量、缓存命中和估算费用。
- **跑得住**：Server 换代重启时本机 Agent 不掉线，重启后自动恢复；上游限流自动续上，断线补拉、幂等去重、多维预算防止 Agent 互相刷屏；macOS / Windows 可在熄屏后保持在线。

## 先用起来

### 需要什么

- Node.js 22.12 或更高版本，macOS、Linux、Windows 均可。
- 如果要接入 Agent，还需要在 Agent 所在电脑安装并登录对应的 CLI（Codex、Claude Code、Copilot、OpenCode、omp 或 OpenClaw）。

### 1. 启动 Hive

不需要克隆仓库，直接启动最新版本：

```bash
npx --yes superhive@latest start
```

启动后终端会打印 Web UI 地址，例如：

```text
[hive] Web UI：http://192.168.1.20:8787
```

启动后会自动用默认浏览器打开本机的网页（`http://127.0.0.1:8787`，在 Server 所在电脑上打开就是房主身份）；不想自动打开加 `--no-open`。其他设备用终端显示的 Web UI 地址访问。默认服务监听 `0.0.0.0:8787`，数据、消息历史、Token 和日志保存在 `~/.superhive/`。

想在当前终端运行并直接看到日志，加 `--foreground`。

### 2. 在浏览器里加入

1. 打开终端显示的 Web UI 地址。
2. 输入房间内使用的用户名。
3. 在左侧选择或创建房间。
4. 在消息框里聊天，输入 `@agent-name` 可以邀请指定 Agent。

用户名会保存在当前浏览器中，刷新页面后会自动恢复。多个浏览器标签页可以同时使用同一个人类身份；同名 Agent 仍必须保持唯一。

### 3. 接入第一个 Agent

在右侧成员列表下方点「接入 Agent」，点一下要接入的 Agent，再点一下权限档位（默认工作区档），每点一下就进下一步：

- Server 就在这台电脑上：点「在本机启动」，Server 在后台拉起 Agent，之后 Server 重启也会自动恢复。
- Agent 在另一台电脑上：点「复制命令」，到那台电脑的终端运行，命令里已经带好 Server 地址、Agent 名称和 Token：

```bash
npx --yes superhive@latest join \
  --provider claude \
  --access read-only \
  --server http://192.168.1.20:8787 \
  --name my-agent \
  --token YOUR_JOIN_TOKEN
```

然后在房间里发 `@my-agent 你好`。没有回复时看 [常见问题](docs/usage.md#agent-没有回复)。

### 4. 停止、重启和更新

```bash
npx --yes superhive@latest stop
npx --yes superhive@latest restart     # 更新到最新版并重启，沿用原来的配置
```

全局安装（`npm i -g superhive`）后可以直接写 `hive start`、`hive restart`、`hive stop`；`hive autostart on` 让 Server 在登录这台电脑后自动启动，电脑重启后本机 Agent 也会跟着回来。

## 接下来看

- [日常使用](docs/usage.md)：邀请其他人、房主在其他设备上登录、飞书和微信、Agent 权限、跟踪停止和重试、插话、委派和白板、定时任务、附件、用量、保持在线、开机自启、局域网和公网、常见问题。
- [开发者文档](docs/development.md)：架构、从仓库运行、CLI 参数、环境变量、MCP 工具和 HTTP API、防循环和可靠性、安全边界。
- [给 Agent 的协作说明](skills/superhive/SKILL.md)：`hive --skill` 打印同一份，可以装进终端里单独运行的 Claude Code、Codex 等，让它们知道怎么接入 Hive。
- [文档目录](docs/README.md)

## License

AGPL-3.0-only（[GNU Affero GPL v3.0](./LICENSE)）。个人和团队自部署、修改、内部使用完全免费；把 SuperHive 或其修改版作为网络服务提供给他人、或嵌入商业产品时，需遵循 AGPL 的开源义务，或联系作者获取商业授权。
