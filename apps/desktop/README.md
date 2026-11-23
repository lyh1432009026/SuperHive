# SuperHive 桌面端（预览）

用 Electron 45 把 SuperHive 包成一个双击就能用的应用：打开后自动在本机起 Hive（或连上已经在跑的那个），窗口里就是现有的网页界面，另外多一个内置终端。

> 预览阶段：还没有签名、公证和自动更新，也没有发布安装包，需要从源码打包。

## 它做了什么

- **本机 Hive**：读 `~/.superhive/server.json`，`hive start` 起的 Server 还在跑就直接连上，不再起第二个；没有就用 `utilityProcess` 起一个，写同样格式的 `server.json`，`hive stop` / `hive start` 都认得它。8787 被别的程序占了就往后找空端口。退出应用时只停自己起的那个，先请它正常退出（本机 Agent 下线、IM 断开），等不到再结束。数据目录、数据库和 CLI 是同一份，不迁移也不改写用户数据。
- **本机 Agent**：打包后的应用关了 RunAsNode，Electron 不能当 Node 用。Server 改由环境变量 `HIVE_LOCAL_AGENT_CLI` 得知怎么拉起 Agent：桌面端让它运行 `SuperHive --superhive-cli join …`，主进程看到这个参数就只运行包里自带的 superhive CLI，不开窗口、不占单实例锁。
- **PATH**：从访达、Dock 启动的程序拿不到 shell 配置里的 PATH，启动时用登录 shell 读一次再合并，本机 Agent 和终端才能找到 `claude`、`codex`、`node`。
- **窗口**：加载 `http://127.0.0.1:<端口>` 的现有网页（在本机打开才是房主身份）；记住大小和位置（换了显示器会放回可见区域）；只允许一个实例；macOS 上关窗口不退出，点 Dock 图标再打开，⌘Q 才退出。
- **标题栏**：去掉系统标题栏，网页顶栏顶到窗口最上面。macOS 用 `titleBarStyle: "hidden"`，红黄绿按钮在左侧栏顶部那一行垂直居中（网页同步顶栏高度，界面密度变了按钮跟着挪），全屏时按钮隐藏、让出的位置收回；Windows / Linux 用 `titleBarOverlay` 保留系统按钮（Win11 贴靠布局照常可用），底色、图标颜色和高度跟网页主题实时同步，失焦时图标变淡，网页用 `env(titlebar-area-*)` 在右上角让位。侧栏顶部、聊天顶栏、右侧栏顶部可拖动，按钮、输入框、提示等都是 `no-drag`，模态弹窗打开时顶部不再拖动。preload 在 html 上打 `data-desktop`、`data-titlebar`、`data-fullscreen`，样式全在 `apps/web/src/styles/desktop-titlebar.css`，浏览器里一条都不生效。`SUPERHIVE_DESKTOP_TITLEBAR=native` 退回系统标题栏。
- **启动加载动画**：窗口一打开就按上次的位置大小显示，蜂巢 logo 动画铺在窗口里单独的一层 `WebContentsView` 上（`src/splash.ts`，纯 CSS + 内联 SVG）：描边画出、点亮中心、中心往外一圈圈扩散六边形信号。本机 Hive 起好后网页在这层下面加载，首屏画好时网页经 preload 的 `ready()` 通知主进程，logo 缩小淡出、底色变透明露出主界面；启动快时不硬等，没画完的入场动画加速播完。加载超过约 2 秒才淡入一行状态文字，超过 12 秒补一句提示。深浅色用上次网页的主题（记在用户目录的 `splash-theme.json`，和系统一致时跟随系统），`prefers-reduced-motion` 时换成静态 logo 加轻微明暗变化。起不来或 Hive 中途停了，停在出错画面上写明原因和日志位置，可「重试」「打开日志目录」「退出」。`SUPERHIVE_DESKTOP_SPLASH=comb` 换成「小六边形一格格拼出」的备选方案。preload 的本机 Hive 地址改为载入时同步问主进程（窗口比 Hive 先建出来），主进程只回答主窗口的顶层框架。
- **终端**：主进程里用 node-pty，网页里用 xterm 6（fit、web-links）。顶栏「终端」按钮或菜单「文件 → 新建终端」（Ctrl+\`）打开，默认在当前房间的工作区目录，没有工作区就在主目录；macOS / Linux 是用户的登录 shell，Windows 是 PowerShell。多标签；可以停在底部（拖高度）、右侧（拖宽度）或最大化铺满对话区，面板标题栏按钮、菜单「视图」、⌘⇧M / ⌥⌘P 切换，位置和尺寸记在 localStorage；对话区放不下右侧（对话至少留 360px）时按底部显示。收起面板不结束进程，关标签才结束；页面刷新时进程留在主进程（每个终端留最近 512K 字符输出），新页面 60 秒内 `list` + `attach` 接回并回放，没接回的才结束；窗口关闭时全部结束。

## 安全

对照 [Electron 安全清单](https://www.electronjs.org/docs/latest/tutorial/security)：

- 所有渲染进程开 `sandbox`、`contextIsolation`，关 `nodeIntegration`、`webviewTag`；
- preload 只经 `contextBridge` 暴露 `window.superhiveDesktop`（终端的创建、读写、调整大小、结束；标题栏外观同步，只收 `#rrggbb` 颜色和 28–80 的高度），并且只在页面来源是本机 Hive 回环地址、且是顶层框架时才暴露；
- 每个 IPC 都在主进程再校验一次 `senderFrame`：必须是我们窗口的顶层框架、来源等于本机 Hive 地址，iframe、别的窗口、跳走后的页面一律拒绝；每个终端只归创建它的页面，别的页面读写不了；
- 不允许跳到别的站点，外部链接交给系统浏览器；同源新窗口不带 preload；禁止 webview；权限请求只放行剪贴板、通知、全屏，并且只给本机 Hive；
- Fuses：关 `RunAsNode`、`EnableNodeOptionsEnvironmentVariable`、`EnableNodeCliInspectArguments`，开 asar 完整性校验和 `OnlyLoadAppFromAsar`，开 Cookie 加密；
- **终端能力不经过网络**：只走 Electron IPC。局域网、远程或浏览器里打开的网页没有 preload，`window.superhiveDesktop` 不存在，网页也不会出现终端入口、不会加载 xterm。

## 本地开发

在仓库根目录先 `pnpm install`，然后：

```bash
pnpm --filter @superhive/desktop dev     # 组装 .stage/app 并启动
pnpm --filter @superhive/desktop test    # 单元测试（IPC 校验、终端会话、端口发现、窗口位置、标题栏）
pnpm --filter @superhive/desktop test:smoke   # 冒烟：真的启动应用、开终端执行命令、接入一个本机 Agent
```

- `scripts/stage.mjs` 把应用组装到 `.stage/app`：主进程和 preload（esbuild 打包）、随包的 superhive（`packages/superhive` 的 dist、web、skills，和 npm 包同一份），以及用 npm 单独装的运行时依赖。网页或 Server 改了要带 `--rebuild` 重新构建 superhive 包。
- 运行时依赖不用仓库的 pnpm node_modules：仓库里的 better-sqlite3 12.x 在 Electron 45 的 V8 上编译不过，桌面端这一份换成走 N-API、自带预编译包的 13.2（见 `package.json` 的 `superhiveDesktop.dependencyOverrides`），改编译也不会影响 server 测试。node-pty 1.1 同样是 N-API 预编译包；Linux 上没有预编译包，stage 时按 Electron 编一次。
- 开发时不想碰自己的 `~/.superhive`，可以设 `SUPERHIVE_DESKTOP_DATA_DIR=/tmp/xxx` 和 `SUPERHIVE_DESKTOP_PORT=18787`。设了数据目录时 Electron 的用户目录也放到它下面，和正在用的桌面端互不影响（单实例锁、窗口位置分开），开发版、冒烟测试可以和安装版同时开。

## 打包

```bash
pnpm --filter @superhive/desktop make      # 重新构建并打出安装包
pnpm --filter @superhive/desktop package   # 只打 .app / 目录，不做安装包
```

产物在 `apps/desktop/out/`（已 gitignore）：macOS 是 `out/make/dmg/arm64/SuperHive-<版本>-arm64.dmg` 和 `out/make/zip/darwin/arm64/*.zip`。Windows（Squirrel 安装包、zip）和 Linux（deb、rpm、zip）的 maker 已经配好，需要在对应系统上打。

打包版的冒烟测试（fuses 开着，用 Chromium 远程调试端口连上窗口）：

```bash
SUPERHIVE_DESKTOP_APP=out/SuperHive-darwin-arm64/SuperHive.app/Contents/MacOS/SuperHive pnpm --filter @superhive/desktop exec playwright test test/packaged.smoke.ts
```

为什么用 Electron Forge：这是 Electron 官方维护和推荐的工具链，fuses、原生模块重编、各平台 maker 和发布器都是官方插件。pnpm 仓库的问题用「先组装到 `.stage/app`、在那里跑 Forge」解决。

应用图标的源文件是 `build/icon.svg`，改了之后运行 `pnpm --filter @superhive/desktop icons`（需要 macOS）重新生成 png / icns / ico。

## 发布前要准备的（这次没做）

| 事项                  | 要准备什么                                                                                   | 配置位置                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| macOS 签名和公证      | Apple Developer 账号（年费）、Developer ID Application 证书、App 专用密码或 API Key、Team ID | `forge.config.cjs` 的 `packagerConfig.osxSign` / `osxNotarize`           |
| Windows 签名          | 代码签名证书（OV/EV），或 Azure Trusted Signing 账号                                         | `packagerConfig.windowsSign`、`maker-squirrel` 的签名参数                |
| 自动更新              | 签名之后才可用；用 update.electronjs.org（需公开 GitHub Release）或自建更新源                | 主进程接入 `update-electron-app`                                         |
| 发布到 GitHub Release | 有发版权限的 GitHub token；在 CI 上按平台打包                                                | `forge.config.cjs` 的 `publishers`（`@electron-forge/publisher-github`） |

## 已知限制

- 未签名的 macOS 应用第一次打开会被 Gatekeeper 拦下，需要右键「打开」，或在「系统设置 → 隐私与安全性」里允许。
- 每个本机 Agent 是一个不带窗口的 Electron 主进程，比直接用 Node 多占几十 MB 内存。
- 安装 Agent CLI（`npm i -g @anthropic-ai/claude-code` 之类）仍然需要系统里有 Node.js；桌面端本身不需要。
- Windows：npm 全局装的 Agent CLI 如果是 `.cmd` 包装、旁边又没有 `node.exe`，Hive 会退回用 `process.execPath` 运行它，在桌面端里这会是 Electron 本身。需要在 Windows 上实测。
- Windows 和 Linux 只配好了 maker，没有在对应系统上实际打包和运行过。
