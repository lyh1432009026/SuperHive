# 图片来源与验收范围

## 真正界面截图

`public/media/interface/` 中的图片来自本房间已公开的、使用隔离演示界面生成的无头浏览器验收截图，复用于当前 `c2f68dd` 文档。仅做裁切，不绘制或改写界面：

| 文档图片             | 原始公开消息与文件              | 原始 SHA-256                                                       | 裁切范围                             |
| -------------------- | ------------------------------- | ------------------------------------------------------------------ | ------------------------------------ |
| `agent-count.png`    | #3206 `agent-count-stepper.png` | `fd15a6a8d0db4b145353ed0cf8518ff80c09b574d70db342b2c2c533ba57592b` | 左上 720×130；去除工作目录等本机信息 |
| `member-actions.png` | #3144 `member-actions.png`      | `c6ca210dc36893a61d30deffe6424a3855e40c21c07ae2f2de258e29fb400929` | x40 / y202，320×58；只保留两个入口   |
| `quick-actions.png`  | #3144 `sidebar-left.png`        | `e811f5cc7b293d4c75fa1e65e365d874dd8f13563ac958c2f8a37337098eaec2` | 左上 260×250；去除房间列表           |

原图已经逐一可视检查；裁切结果不含 Token、账号、真实聊天、工作目录或私有房间。数量截图中的 `Alice-codex` 是示例名。截图只证明这些界面的样子，不证明真实模型、远程连接或完整接入流程已经再次实测。文档正文必须注明“隔离演示界面截图（裁切）”。

## 演示环境界面截图

`public/media/screens/` 是用本地临时 Hive Server（独立数据库、独立 `HOME`、只监听 127.0.0.1、假 Agent 只保持在线不调用模型）加演示数据，以无头 Chrome 按 2 倍像素截取的真实界面，每张都有 `.dark.png` 与 `.light.png` 两份。正文写 `![说明](/media/screens/名字.png)`，构建时由 `scripts/site-config.mjs` 展开成跟随主题切换的两张图，并按一半尺寸显示。

全部由 `pnpm docs:screens`（`scripts/screens.mjs` 与 `scripts/screens/demo-server.mjs`）生成，可随时重截：

- 人名（林夏、周屿、陈默）、房间、仓库、分支、提交和任务内容都是演示数据，写在 `demo-server.mjs` 里。
- 演示 Server 的 HOME 是临时目录，截图时把它显示成 `~`；`onboard`、`clis` 里的 Agent CLI 是临时 HOME 里只会打印版本号的假命令，版本号和「有新版」也是写死的演示数据，不读截图电脑上的真实安装，不联网查询。
- 只做裁切与 PNG 调色板压缩，不改画界面。截图只证明界面样子，不证明真实模型任务或远程连接已经实测。

### 首页实景窗口

`public/media/home/` 是上面 `overview`、`preview-dock` 两张演示环境截图（中英、明暗各一份）缩成 960、1600、2400 宽的 WebP，由 `pnpm --filter @superhive/docs home:media`（`scripts/home-media.mjs`）生成，只缩放和压缩，不改画界面。重截 `docs:screens` 后要重跑一次。

首页运行时词云里的 8 个 Agent 标识和网页 `apps/web/src/provider-logos.tsx` 是同一套图形（LobeHub Icons，MIT；omp 取自 omp.sh），预先渲染在 `src/components/home/runtime-logos.ts`。

## 原创示意图

`public/media/workroom.svg` 与 `public/media/codex2/`、`codex4/`、`architecture/` 的 SVG 为原理或操作示意，必须明确标注非真实界面截图，并带有意义的替代文本。分享图 `social-card.png` 根据 `src/assets/social-card.svg` 用 Sharp 生成，不是产品界面。

文档主题调整时，仅统一原创示意图、标志与分享图的配色；真正界面截图保持原始裁切像素，不重绘、不改色。

品牌标志的几何路径来自 `apps/web/src/App.tsx` 的 `HiveLogo`，线宽、内层透明度及中心点半径对应 `apps/web/src/styles/base.css`；文档页头与分享图复用该 SVG。`public/favicon.svg` 直接复用主项目同名文件，用于小尺寸显示，不使用另绘的立方体标志。

## 文档站验收截图

文档站的桌面、手机和教程效果截图由牵头在本任务的本地静态预览里生成；这些仅记录文档站的渲染结果，不是 Hive 服务线上验收或正式部署的证据。
