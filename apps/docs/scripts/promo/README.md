# SuperHive 宣传片脚本

一条命令录屏并合成宣传片。画面全部是真实界面加演示数据：文档站首页和两张协作流转图，以及演示 Server 上的网页。

```sh
pnpm --filter @superhive/docs promo                     # 构建、录屏、合成全部（约 10 分钟）
pnpm --filter @superhive/docs promo --no-build          # 跳过构建，直接用现有的 apps/web/dist 和 apps/docs/dist
pnpm --filter @superhive/docs promo --skip-record       # 只按分镜重新合成，改了字幕或剪辑点时用（约 2 分钟）
pnpm --filter @superhive/docs promo --only delegate,im  # 只重录这几个镜头，再合成
```

依赖：本机装好 Chrome（或用 `CHROME_PATH` 指定）和 `ffmpeg`。不需要新增 npm 依赖。

## 成品

都在仓库根的 `output/promo/` 下，这个目录已被 `.gitignore` 忽略，不会提交：

| 文件                               | 说明                                     |
| ---------------------------------- | ---------------------------------------- |
| `superhive-promo.mp4`              | 主版，1920×1080，60fps，无音轨           |
| `superhive-promo-silent-audio.mp4` | 主版，带一条静音音轨，配乐时直接替换音轨 |
| `superhive-promo-30s.mp4`          | 约 30 秒的精简版，用于社交平台           |
| `superhive-promo-30s-vertical.mp4` | 精简版的 9:16 竖版，1080×1920            |
| `storyboard.md`                    | 分镜表：每个镜头在成片里的起止时间和字幕 |
| `frames/`                          | 主版每个镜头中间的一帧                   |
| `clips/`                           | 原始录屏帧，`--skip-record` 时会复用     |

## 文件

| 文件             | 作用                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `make.mjs`       | 入口：构建 → 录屏（子进程）→ 合成                                                                        |
| `record.mjs`     | 录屏：起文档站静态服务和演示 Server，按镜头驱动无头 Chrome                                               |
| `server.mjs`     | 宣传片用的演示 Server：8 个房间、12 个 Agent、4 位成员，另有委派、设计稿点选两段现场戏，以及假的飞书驱动 |
| `docs-shots.mjs` | 文档站镜头：首页出场、两张协作图（轮播间隔缩短）                                                         |
| `app-shots.mjs`  | 真实界面镜头：总览、派活委派、进展、附件和点选、产物、代码、定时、邀请、接入 Agent、飞书                 |
| `outro-shot.mjs` | 结尾卡                                                                                                   |
| `browser.mjs`    | 录屏浏览器：可见的鼠标指针、平滑移动和点击、逐字输入、镜头推近、高亮框、录屏                             |
| `storyboard.mjs` | 分镜：每段用哪段录屏、剪辑点、加速和字幕                                                                 |
| `render.mjs`     | ffmpeg 合成：恒定帧率、叠字幕、转场、竖版                                                                |
| `cards.mjs`      | 字幕条、结尾卡、竖版标题的 HTML                                                                          |
| `assets.mjs`     | 演示数据里的附件（压测图、两版设计稿、Markdown 规范），现场渲染                                          |

## 安全

- 演示 Server 的 HOME、数据库和演示仓库都在临时目录里，只监听 127.0.0.1，录完就删掉。录屏子进程只带 `PATH`，不带本机的 `HIVE_*` 配置和令牌。
- Agent 都是假连接。「用本机应用打开」「在访达中显示」「在终端打开」都换成了空操作，Agent CLI 也是只会打印版本号的假命令。
- 飞书用的是假驱动，二维码内容是 `https://example.com/...` 的演示地址，不连接任何真实账号。
- 录屏浏览器用临时配置，不碰系统钥匙串和剪贴板。
- 录制时页面里一直在查泄露：画面、shadow DOM 或输入框里一旦出现 `/Users/`、临时目录或本机用户名，这个镜头就报错。临时目录在界面上显示成 `~`。

## 调整

- 改字幕、剪辑点或加速：编辑 `storyboard.mjs`，再跑 `--skip-record`。
- 改操作和节奏：编辑 `app-shots.mjs` 或 `docs-shots.mjs`，再用 `--only <镜头>` 重录。
- 镜头卡住时，3 分钟后自动报错，出错时的画面存为 `output/promo/failed-<镜头>.png`。设置 `PROMO_DEBUG=1` 可以打出每一步的操作。
