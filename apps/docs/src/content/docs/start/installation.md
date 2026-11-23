---
title: 安装与启动 SuperHive
description: 了解 Node.js 与 Agent CLI 前提，用 npm 全局安装 SuperHive 并以 hive 命令启动，确认网页地址，并安全地停止、用 hive update 更新和配置开机自启。
---

## 有什么用

SuperHive 把人和多个 Agent 放进同一个共享聊天室。Hive Server 负责保存房间、消息和任务状态；Agent 则在接入它的电脑上，通过各自的 Runtime 工作。

安装 Hive 不等于安装模型或获得模型额度。只想先看网页，可以暂时不接 Agent；要让 Agent 回答，还需要对应 CLI、登录状态和可用的模型服务。

## 需要准备什么

| 项目      | 要求                                                           |
| --------- | -------------------------------------------------------------- |
| Node.js   | 22.12 或更高版本，先用 `node --version` 检查                   |
| 操作系统  | macOS、Linux 或 Windows                                        |
| 浏览器    | 能访问 Hive Server 的地址                                      |
| 网络      | 安装和更新需要访问 npm；模型调用需要访问对应服务               |
| Agent CLI | 在 Agent 实际运行的电脑上安装并登录，例如 Codex 或 Claude Code |

当前接入界面还提供 GitHub Copilot、OpenCode、omp 和 OpenClaw。不同 CLI 的安装、认证和可用模型由各自提供方决定；Hive 不会替你购买额度或自动解决这些登录问题。

## 第一步：启动 Hive Server

在准备运行服务的电脑上打开终端，不必克隆仓库。推荐全局安装，分两步：

1. **安装**（每台电脑只需一次，装好后就有了 `hive` 命令）：

   ```bash
   npm i -g superhive
   ```

2. **运行**（启动 Hive Server 并打开网页，以后每次启动都用这一条）：

   ```bash
   hive
   ```

不想全局安装，也可以用 `npx superhive` 临时运行，效果和 `hive` 一样，下文的 `hive` 都可以换成 `npx superhive`。

`hive` 默认在后台运行，监听 `0.0.0.0:8787`，并尝试用默认浏览器打开本机网页 `http://127.0.0.1:8787`。终端还会显示其他设备可访问的地址，示例：

```text
[hive] Web UI：http://192.168.1.20:8787
```

这里的 IP 是示例，不要照抄。无图形界面、SSH 或 CI 环境不会自动打开浏览器。

如果只打算在这一台电脑试用，可以只监听本机回环地址：

```bash
hive --host 127.0.0.1
```

这样其他电脑不能直接连接。需要多人或跨设备访问时，再按 [部署参考](/reference/deployment/) 配置网络和访问控制。

## 第二步：确认网页和身份

1. 在 Server 所在电脑访问 `http://127.0.0.1:8787`，输入聊天用的用户名。
2. 确认能看到房间列表；随后按 [快速上手](/start/quickstart/) 接入第一个 Agent。
3. 其他设备不要使用 `localhost` 或 `127.0.0.1`，那会指向它们自己。普通成员通过房主发出的邀请链接进入；房主换设备请用 [设备登录](/guides/rooms/#房主换设备登录)。

用户名是聊天显示名，不是凭同名就能获得房主权限的账号密码。Agent 名称也必须避免和已有成员冲突。

![启动 Hive、打开网页、接入一个只读 Agent，再发送定向消息的四步示意图](/media/codex2/quickstart-flow.svg)

图中是原创流程示意，不是实际界面截图；服务启动和 Agent 上线是两个独立步骤。

## 第三步：按需调整启动方式

| 想做什么               | 命令                                 |
| ---------------------- | ------------------------------------ |
| 前台查看日志           | `hive --foreground`                  |
| 不自动打开浏览器       | `hive --no-open`                     |
| 更换端口               | `hive --port 9000`                   |
| 指定数据目录           | `hive --data-dir /path/to/hive-data` |
| 禁用网页本机启动 Agent | `hive --no-local-agents`             |

示例目录需要替换为本机实际目录。启动参数用于启动服务；已经运行时要改变配置，使用 `restart` 的对应参数，而不是另起一个相同端口的进程。

## 停止、更新和开机自启

- 停止，也可以写 `hive off`：

  ```bash
  hive stop
  ```

- 重启，沿用原有启动配置：

  ```bash
  hive restart
  ```

- 更新到最新版；Server 正在运行就自动用新版本重启：

  ```bash
  hive update
  ```

- 只检查有没有新版本，不安装：

  ```bash
  hive update --check
  ```

`hive update` 先查 npm 上的最新版，再用你当初安装 `superhive` 的那个包管理器（npm、pnpm、bun 或 yarn 全局安装，自动识别）装到最新版；已经是最新会直接说明。`restart` 默认不再打开浏览器，需要时加 `--open`。更新的只是 SuperHive 本身，外部 Agent CLI 不会随之更新。

平时在终端运行 `hive` 时会顺便检查一次新版本：最多等 1.5 秒，查不到不影响使用，结果缓存 1 小时；有新版会提示运行 `hive update`。设置 `NO_UPDATE_NOTIFIER=1` 可以关闭。

用 `npx` 临时运行时没有 `hive update`，改用 `npx superhive@latest restart` 更新并重启。

登录这台电脑后自动启动 Server：

```bash
hive autostart on
hive autostart status
```

`hive autostart off` 关闭登录时启动。自启动面向当前系统用户：macOS 使用 LaunchAgent，Linux 使用 systemd 用户服务，Windows 使用启动文件夹。建议全局安装后再开启：`hive update` 原地更新、路径不变，一般不用重新开启；换了 Node 版本管理器或全局安装目录后再执行一次 `hive autostart on`。用 npx 开启的自启动，npx 缓存被清理后会失效。

## 桌面端

:::note[Mac 桌面端已经可以用了]
安装包即将在 [GitHub Releases](https://github.com/wangrongding/SuperHive/releases) 提供，发布后这里会补上下载链接。现在想先试，可以按 [开发与扩展](/reference/development/#桌面端) 从源码打包。
:::

不想开终端敲命令，也可以用 SuperHive 桌面端：双击打开，它会在本机启动 Hive（`hive start` 已经起了就直接连上），窗口里就是同一个网页。顶栏多一个「终端」按钮，在当前房间的工作区目录打开一个终端，不用再切到别的程序。

- 数据目录和 CLI 是同一个 `~/.superhive/`，已有的房间和消息都在；退出桌面端时只停它自己起的那个 Server。
- 终端只在桌面端里有，浏览器、局域网或手机上打开网页都看不到，也碰不到。
- 终端面板默认在对话下方，可以移到右侧（拖宽度），或最大化铺满对话区；面板标题栏有按钮，也可以用菜单「视图」或快捷键 ⌘⇧M（最大化 / 还原）、⌥⌘P（底部 / 右侧），Windows / Linux 上 ⌘ 换成 Ctrl、⌥ 换成 Alt。位置和尺寸会记住；窗口太窄放不下右侧时自动按底部显示。刷新页面不会结束正在跑的终端。
- 窗口没有系统标题栏，界面顶到最上面：macOS 的红黄绿按钮在左侧栏顶部，Windows / Linux 的最小化、最大化、关闭按钮在右上角，颜色跟着深浅色主题变。拖顶部那一行能移动窗口，双击按系统设置最大化或缩放。个别 Linux 窗口管理器上按钮显示不正常时，设环境变量 `SUPERHIVE_DESKTOP_TITLEBAR=native` 再启动，改回系统标题栏。
- 本机 Agent 可以直接在桌面端里接入、上线，不用另开终端。
- 目前还是预览版：安装包没有签名，macOS 第一次打开要在应用上右键选「打开」；Windows 和 Linux 版还在适配，打包配置已经写好，还没在真机上验证。

## 注意事项

- 默认数据目录是 `~/.superhive/`，其中有消息、认证数据和日志。不要把整个目录作为公开附件；备份和恢复看 [部署参考](/reference/deployment/)。
- 默认监听所有网卡，不代表已经适合暴露公网。公网访问需要 HTTPS/WSS、正确的对外地址与额外访问控制，见 [安全边界](/reference/security/)。
- 网页能打开但 Agent 不回复时，先检查 CLI 和登录状态，不要通过提高本机权限来解决网络或认证问题。
- 本教程按仓库实现说明命令与流程，没有替你运行安装、连接真实模型或验证所有平台环境。异常情况见 [排障指南](/reference/troubleshooting/)。
