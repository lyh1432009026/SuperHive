# 桌面端自动更新调研

> 2026-11-25 · rd-claude4 · 关联 rd #5853「发新版安装包，用户能收到更新吗？能不能自动更新？」

## 结论

|                | 现在（不签名）                                                                                         | 做成真正的自动更新需要                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **提示有新版** | ✅ 已做：启动后和之后每 6 小时查一次 GitHub Releases，侧栏底部提示「有新版本」，可以下载或忽略这个版本 | —                                                                                                                                                                                      |
| **Windows**    | 用户点「下载」，自己运行新的 Setup.exe 覆盖安装，数据和设置都保留                                      | **不需要签名**。在主进程接上 Electron 的 `autoUpdater`（Squirrel.Windows），每次发版多上传 `RELEASES` 和 `SuperHive-x.y.z-full.nupkg` 两个文件，就能后台下载、重启后生效。可以先单独做 |
| **macOS**      | 用户点「下载」，打开 dmg 把新的 SuperHive 拖进「应用程序」替换                                         | **必须有 Developer ID 签名和公证**（Apple Developer Program，每年 99 美元），每次发版多上传一个 `-darwin-arm64.zip`                                                                    |

建议顺序：先按下面的方案做 Windows 自动更新，同时保留「有新版本」提示；Mac 等申请了开发者账号、签名和公证都跑通后，再改成自动更新。

## 已经做的：检查新版并提示（不需要签名）

- **查哪里**：`apps/desktop/src/update-check.ts` 查 `https://api.github.com/repos/wangrongding/SuperHive/releases/latest`。
  - 启动 20 秒后查一次，之后每 6 小时一次。
  - 距上次查到不足 6 小时直接用缓存，缓存在 Electron 用户目录的 `desktop-update.json`。
  - 带上次返回的 ETag 去查，没有变化时 GitHub 回 304，不算进匿名每小时 60 次的限额。
  - 断网、限流、返回格式不对时都安静跳过，不改缓存，也不打扰用户。
- **怎么算有更新**：
  - 跳过 draft、prerelease 和带预发布标识的 tag。
  - 版本号要比 `app.getVersion()` 新（按 semver 比较）。
  - Release 里要有本平台的安装包：mac arm64 认 `SuperHive-*-arm64.dmg`，Windows x64 认 `SuperHive-*-win-x64-Setup.exe`。Intel Mac、Windows ARM、Linux 目前没有安装包，所以不提示。
- **网页里的样子**：
  - 侧栏底部（头像上面）显示一行「有新版本 0.4.8」。
  - 点开后可以看到当前版本、发布日期、「本版改动」摘要，以及怎么覆盖安装。摘要按界面语言取 Release 说明里「中文 / English」的一半。
  - 弹窗里有三个按钮：「下载」「忽略这个版本」「完整发布说明」。
  - 浏览器里打开网页时没有这个入口，老版本桌面端也没有。
- **菜单**：
  - Mac 在应用菜单，Windows 在「帮助」菜单，各有一项「检查新版本…」。
  - 点了会马上查一次，并且一定给一个答复：有新版、已是最新，或者没能连上 GitHub。
- **安全边界**：
  - 网页只拿到版本号、说明摘要、安装包文件名和大小，拿不到任何链接。
  - 点「下载」和「完整发布说明」时，网页只告诉主进程打开哪一个，地址由主进程从自己的检查结果里取。
  - 打开前还会按白名单检查一遍：只允许 `https://github.com/wangrongding/SuperHive/releases/` 下的地址，拒绝带账号密码、端口、编码斜杠的地址。
  - 新加的三个 IPC 和终端一样，只认主窗口里本机 Hive 页面的顶层框架。
  - 缓存文件被改过也一样：读回来时按同样的规则再校验一遍。
- **开关**：
  - 打包后的正式版默认会查，开发时默认不查。
  - `SUPERHIVE_DESKTOP_UPDATE_CHECK=0` 一律不查，`=1` 时开发时也查。

## 覆盖安装后数据还在吗

**还在。** 程序、数据和设置放在三个不同的地方，覆盖安装只会动程序目录。

| 内容                                                                   | 位置（Windows）                      | 位置（macOS）                             | 覆盖安装时 |
| ---------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------- | ---------- |
| 程序本身                                                               | `%LOCALAPPDATA%\SuperHive\app-x.y.z` | `/Applications/SuperHive.app`             | 替换       |
| Hive 数据：房间、消息、附件、Agent 设置、密钥                          | `%USERPROFILE%\.superhive`           | `~/.superhive`                            | 不动       |
| 桌面端自己的状态：窗口位置、启动画面主题、网页本地存储、检查新版的缓存 | `%APPDATA%\SuperHive`                | `~/Library/Application Support/SuperHive` | 不动       |

**Windows 实测**：查了 rd 的 Windows 机器上 11-24 那几次真实安装的 Squirrel 日志（`%LOCALAPPDATA%\SquirrelTemp\Squirrel-Install.log`），只读，没有再装。

- 15:23:53 运行 0.4.6 的 Setup.exe，覆盖已经装好的 0.4.4。日志原文是 `Install path C:\Users\zphz\AppData\Local\SuperHive already exists, burning it to the ground`。
  - 也就是说，Setup.exe 覆盖安装时是先关掉正在运行的 SuperHive，**把整个程序目录删掉再重装**，不是增量更新。
- 装完后两类数据都还在：
  - `~/.superhive`：11-20 的 `attachments/`、`im-secret.key`，以及 13:47 的 `hive.sqlite`；
  - `%APPDATA%\SuperHive`：11:34 写的 `splash-theme.json`，以及 10:45 建的网页本地存储（`Local Storage/leveldb/CURRENT`）。
- 所以：
  1. 数据和设置在覆盖安装后保留；
  2. 以后**不能把任何要保留的东西放进 `%LOCALAPPDATA%\SuperHive`**，那里每次覆盖安装都会被清空；
  3. 装新版时，Setup.exe 会自动关掉正在运行的 SuperHive，它带起来的本机 Hive 也会跟着停。SQLite 用的是 WAL，进程被关掉不会丢已经提交的数据。

**为什么没有用临时目录再装一遍**：

- Squirrel.Windows 的安装位置固定为 `%LOCALAPPDATA%\<应用名>`，Setup.exe 没有参数可以改。
- 绕开 Setup.exe，把 `Update.exe` 放到临时目录里运行 `--install`，倒是能装到临时目录。但安装钩子还是会以应用名 SuperHive：
  - 改写真实的开始菜单快捷方式和桌面快捷方式（日志里能看到 `--createShortcut` 写的是 `Start Menu\Programs\SuperHive\SuperHive.lnk` 和 `Desktop\SuperHive.lnk`）；
  - 改写 HKCU 下的卸载登记。
- 清理时还会把真的快捷方式删掉。这违反「不动现有桌面端」的要求，所以改用上面的真实日志作为验证。

**macOS**：数据不在 .app 里面，把新的 SuperHive.app 拖进「应用程序」替换旧的，不会碰到 `~/.superhive` 和 `~/Library/Application Support/SuperHive`。替换前要先退出旧版，否则访达会提示应用正在使用。

## 真正的自动更新

### Windows：不签名也能做，可以先单独做

Electron 内置的 `autoUpdater` 在 Windows 上就是 Squirrel.Windows，我们打包用的 `@electron-forge/maker-squirrel` 也是它。流程如下：

1. 应用启动后调 `autoUpdater.setFeedURL(feed)` 和 `checkForUpdates()`。
2. `Update.exe` 读取 feed 下的 `RELEASES`，发现有新版本，就在**后台**下载 nupkg（完整包，或者相对当前版本的差量包），解到 `%LOCALAPPDATA%\SuperHive\app-<新版本>`。这期间用户照常使用。
3. 下载完会触发 `update-downloaded` 事件。之后有两种方式让新版本生效：
   - 网页提示「新版本已下载，重启后生效」，用户点「立即重启」时调 `autoUpdater.quitAndInstall()`；
   - 不调也行，下次启动时 `SuperHive.exe`（Squirrel 的启动壳）会直接运行最新的 `app-x.y.z`。
4. 新版本第一次启动时会带 `--squirrel-updated` 参数，`squirrel.ts` 已经处理了这个参数（重建快捷方式）。旧版本的 `app-x.y.z` 目录在下一次更新时清掉。

与 Setup.exe 覆盖安装相比，这种方式**不会删整个目录**，也不会弹 SmartScreen，因为下载是 Update.exe 做的，不经过浏览器。用户只需要在第一次安装时，在 SmartScreen 上点一次「仍要运行」。

**签名**：Squirrel.Windows 不校验签名。update.electronjs.org 的 README 写明只有 macOS 和 MSIX 需要签名（“Your builds are code signed (macOS and MSIX only)”）。不签名的风险只是个别杀毒软件可能拦下没签名的 exe，和现在手动安装一样。

**feed 有两种选法**：

|      | update.electronjs.org（推荐先用）                                                                                                                                           | 自己放静态文件                                                      |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 接入 | 加依赖 `update-electron-app`，主进程调 `updateElectronApp()`；也可以手动 `setFeedURL('https://update.electronjs.org/wangrongding/SuperHive/win32-x64/' + app.getVersion())` | `setFeedURL('<存放地址>/win32/x64/')`，目录里放 `RELEASES` 和 nupkg |
| 条件 | 公开的 GitHub 仓库，安装包发在 GitHub Releases，跳过 draft 和 prerelease                                                                                                    | 任意 HTTPS 静态存储，比如 GitHub Pages、R2、OSS                     |
| 优点 | 不用自己维护服务，直接从 Release 资产里取                                                                                                                                   | 国内访问可以换成更快的地址，不依赖第三方服务                        |
| 缺点 | 依赖 Electron 官方托管的服务；国内访问 GitHub 下载慢                                                                                                                        | 发版时多一步同步文件                                                |

**发版时 Windows 要多上传的文件**（`pnpm --filter @superhive/desktop make` 在 Windows 上的产物，都在 `out/make/squirrel.windows/x64/` 下）：

| 文件                                | 现在     | 自动更新需要                                                                                             |
| ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `SuperHive-x.y.z-win-x64-Setup.exe` | 已上传   | 继续上传：第一次安装和手动更新都用它                                                                     |
| `RELEASES`                          | 没上传   | **要上传**：一行一个包，内容是 sha1、文件名和大小                                                        |
| `SuperHive-x.y.z-full.nupkg`        | 没上传   | **要上传**：完整包，大小和 Setup.exe 差不多（0.4.6 是 167 MB）                                           |
| `SuperHive-x.y.z-delta.nupkg`       | 没有生成 | 可选：maker-squirrel 配 `remoteReleases`，指向上一个版本的 Release，会生成差量包；没有差量包时下载完整包 |

update.electronjs.org 认 Windows 安装包时，要求文件名带 `-win32`，或者是不带平台标识的 `.exe`（按 x64 处理）。我们的 `-win-x64-Setup.exe` 应该会按后一条认作 x64，正式接入前要用一个测试 Release 确认一下。`RELEASES` 由服务从 Release 资产里读取，并改写成 GitHub 的下载地址，不用自己改。

**Windows 自动更新还要做的事**（下一步，这次没做）：

1. `forge.config.cjs` 删掉自动更新那条 TODO。主进程在 `app.isPackaged && process.platform === "win32"` 时接上 `autoUpdater`；Mac 仍然只用现在的「有新版本」提示。
2. 侧栏的「有新版本」入口在 Windows 上换成：后台下载中 →「新版本已下载，重启后生效」+「立即重启」。点「立即重启」时调 `quitAndInstall()`，退出流程照旧先停本机 Hive 和终端。
3. 发版流程多上传 `RELEASES` 和 `-full.nupkg`，写进发版说明（现在 Windows 包是在 Windows 机器上手动打的，要和 dmg 一起上传）。
4. 测试：
   - 先装 0.4.x，再发一个 0.4.x+1 的测试 Release（draft 不会被认，要先发成正式版，或者用静态目录做 feed），确认后台下载、重启后版本号变了、数据还在；
   - 再确认关掉网络、Release 缺文件时不会报错打扰用户。

### macOS：必须先签名和公证

- **Squirrel.Mac 要求应用已签名**。Electron 文档里写的是 “Your application must be signed for automatic updates on macOS. This is a requirement of Squirrel.Mac.”；update.electronjs.org 也要求 macOS 构建已签名。
  - 没签名的 .app 下载了也装不上：Squirrel.Mac 会校验新版和当前版本的签名是否出自同一个开发者。
- **需要准备**：
  - 加入 Apple Developer Program（个人或组织，每年 99 美元），申请 **Developer ID Application** 证书；
  - 公证要用 Apple ID 加 App 专用密码，或者 App Store Connect API Key。这些都是凭据，要放在 CI 的 secret 里，不能进仓库。
- **配置**：
  - `forge.config.cjs` 的 `packagerConfig` 加 `osxSign: {}` 和 `osxNotarize: { appleId, appleIdPassword, teamId }`（或 `appleApiKey`）；
  - hardened runtime 要配好 entitlements：node-pty 和本机 Hive 的子进程需要 `com.apple.security.cs.allow-jit`，可能还要 `allow-unsigned-executable-memory`，以实际公证和运行结果为准。
- **发版要多上传的文件**：
  - update.electronjs.org 在 Mac 上只认 zip，要求文件名带 `-darwin`、`-mac` 或 `-osx`，再加架构，比如 `SuperHive-darwin-arm64-0.4.8.zip`。现在 `maker-zip` 已经会在 darwin 上出 zip，只是没上传；
  - dmg 继续上传，第一次安装用。
- **签名以后顺带的好处**：第一次打开不用再去「隐私与安全性」点「仍要打开」。

### 不建议的做法

- **在应用里自己下载安装包再运行**：
  - Windows 上下载的 Setup.exe 一样会把程序目录删掉重装，还要处理 SmartScreen、文件锁、下载中断，不如直接用 Squirrel 的后台更新；
  - Mac 上不签名的话，替换 .app 会被 Gatekeeper 拦下。
- **改用 electron-builder 和 electron-updater**：要换掉整个打包链（现在用 Forge），收益不大。electron-updater 在 Mac 上一样要签名。

## 参考

- Electron `autoUpdater`：https://www.electronjs.org/docs/latest/api/auto-updater
- Electron 更新指南：https://www.electronjs.org/docs/latest/tutorial/updates
- update.electronjs.org 的要求和资产命名：https://github.com/electron/update.electronjs.org
- Electron Forge Squirrel.Windows maker：https://www.electronforge.io/config/makers/squirrel.windows
- Electron Forge macOS 签名和公证：https://www.electronforge.io/guides/code-signing/code-signing-macos
