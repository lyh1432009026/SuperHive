# SuperHive 文档站

Monorepo 中的独立应用 `@superhive/docs`，使用 Astro + Starlight 构建静态 HTML。运行时只有 HTML、CSS、JS 和图片；**不需要 Hive Server、SQLite、模型账号、Agent Token 或 Node 服务**。正文、导航和 SEO 元数据在构建阶段生成，站内搜索使用静态 Pagefind 索引，无外部搜索账号。

产品能力依据源码基线 `c2f68dd` 编写；npm 已发布版本可能存在时间差，不能把源码核对当成所有平台、真实模型或生产环境的端到端验证。

## 视觉主题

配色和系统字体对齐主项目 `apps/web/src/styles/tokens.css`：浅色使用白底、浅灰侧栏与黑色主按钮；深色使用中性深灰底和浅色主按钮。蓝色仅用于链接和少量强调，键盘焦点使用中性灰，不使用青绿色品牌色。文档字号与行距针对长文阅读保留独立设置。

这些色值保存在文档自己的 `src/styles/custom.css`，不在构建或运行时导入主应用，仍可单独构建、部署。原创示意图、标志及分享图采用同一配色；真实界面截图不改色。修改分享图源文件后运行 `pnpm --filter @superhive/docs social:image` 同步 PNG。

品牌图标使用主项目 `HiveLogo` 的双层六边形与中心点，不另绘制文档专用图标。页头和分享图复用 `src/assets/hive-mark.svg`；页头图标随文档明暗主题继承正文色。浏览器图标与 `apps/web/public/favicon.svg` 保持一致，沿用主项目针对小尺寸的线宽及系统明暗适配。`scripts/branding.test.mjs` 核对主项目图形、favicon 与分享图引用，防止后续出现另一套品牌图标；这些检查只在源码验收时读取主项目，不引入运行时依赖。

## 本地预览

在仓库根目录，使用 Node.js 22.12+、pnpm 10：

```bash
pnpm install --filter @superhive/docs --filter superhive-workspace --frozen-lockfile
pnpm docs:dev
```

默认地址 `http://localhost:4321`，如有冲突以终端为准。Pagefind 搜索索引需要先构建，开发模式只用于编辑；要验证真实搜索，使用下面的生产预览。

文档开发模式接入 `@ai-ins/astro`：按住 macOS `Option` 或 Windows/Linux `Alt` 点选元素，可把页面需求和源码位置交给本机 Agent CLI。启动前准备好相应 CLI 与登录状态；发送需求会实际启动本机 Agent 并可能修改文件，只有确认后才提交。面板只在 `astro dev` 启用，正式构建与生产预览不注入客户端、源码定位标记或开发接口。

`ai-ins` 以正在运行的文档应用目录为工作区。隔离修改时，从自己的 worktree 启动文档 dev，避免让 Agent 直接改承载 Hive 服务的主目录；`.ai-ins` 本地会话目录已在根 `.gitignore` 排除。

根工具依赖尚未构建的业务 CLI 时，安装可能提示缺少 `hive` binary；这不影响文档构建，不必为此启动或构建整个 Hive。锁文件保持 pnpm 原生格式，用冻结安装验证，不交给 Prettier 重排。

```bash
pnpm docs:verify
pnpm --filter @superhive/docs preview
```

未配置域名时使用不可访问的 `.invalid` canonical，**所有页面 `noindex` 且 robots 禁止抓取**，防止测试环境被误收录。这不是可发布的正式 SEO 配置。

## 正式构建与部署

把 `DOCS_SITE_URL` 换成你拥有的真实 HTTPS 域名（这里的地址只是占位示例，不代表现有官网）：

```bash
DOCS_SITE_URL=https://docs.your-domain.com pnpm --filter @superhive/docs build:deploy
```

产物是 `apps/docs/dist/`。只上传这个目录即可，不必部署其他 workspace。构建时会检查域名、页面、链接、图片、结构化数据、sitemap 和 robots；未提供可索引 HTTPS 地址时，`build:deploy` 会拒绝发布。

### 静态托管平台

适用于 Cloudflare Pages、Netlify、Vercel 的静态托管，或任意支持目录形式 HTML 的对象存储 CDN：

| 配置         | 值                                                        |
| ------------ | --------------------------------------------------------- |
| 项目根目录   | 仓库根目录                                                |
| 安装命令     | `pnpm install --filter @superhive/docs --frozen-lockfile` |
| 构建命令     | `pnpm --filter @superhive/docs build:deploy`              |
| 发布目录     | `apps/docs/dist`                                          |
| 构建环境变量 | `DOCS_SITE_URL=https://你的真实文档域名`                  |
| Node 版本    | 22.12+                                                    |

托管平台应将 `/guides/agents/` 映射到对应 `index.html`；不存在的路径要返回 **HTTP 404** 并展示 `404.html`，不要配置 SPA 的“全部返回首页 200”。平台自动预览建议用普通 `build` 加 `DOCS_NOINDEX=true`，正式分支才用 `build:deploy`。

### Docker / Nginx

在仓库根目录构建，仅将文档装入最后的 Nginx 镜像：

```bash
docker build -f apps/docs/Dockerfile \
  --build-arg DOCS_SITE_URL=https://docs.your-domain.com \
  -t superhive-docs .
docker run --rm -p 8080:80 superhive-docs
```

示例容器监听 HTTP，公网 HTTPS 交给你的反向代理或负载均衡。`nginx.conf` 提供真实 404、基本安全响应头和带内容哈希资源的长期缓存。Docker 示例默认部署在域名根目录。

### 子路径部署

当域名下已有其他站点时，可以在构建时设置：

```bash
DOCS_SITE_URL=https://www.your-domain.com \
DOCS_BASE_PATH=/handbook/ \
pnpm --filter @superhive/docs build:deploy
```

`DOCS_SITE_URL` 只能是 origin，不要在其中加路径；`DOCS_BASE_PATH` 必须以 `/` 开头和结尾。页面、导航、Markdown 链接、图片、Pagefind、canonical 和 sitemap 使用同一个前缀。产物仍在 `dist/`，托管时将其挂到 `/handbook/`。站点地图位于 `/handbook/sitemap-index.xml`。

**robots.txt 特例**：搜索引擎只读取域名根目录的 `/robots.txt`。子路径产物中的 robots 文件不会代替根文件；请在主站根 robots 中添加该文档 sitemap，并确认主站没有禁止 `/handbook/`。Nginx 示例仅面向根目录，子路径时需由你的主站额外配置挂载和 404 路径。

## SEO 与发布清单

- 每页独立标题与摘要、一个 H1、静态可抓取正文，中文语言声明。
- 跟随部署 origin/base 的 canonical、OG 和 Twitter 卡片，以及本地 1200×630 PNG 分享图。
- WebSite、WebPage / TechArticle、BreadcrumbList JSON-LD；没有虚构评分、作者或发布时间。
- 自动 sitemap、robots 和 404 noindex；内部链接与图片资源在构建验收时检查。
- Pagefind 搜索、目录、前后页导航和按任务组织的功能地图。
- SVG 图示带替代文本、原始尺寸、懒加载；首页关键插图优先加载，字体不依赖外部 CDN。

上线后仍需在搜索引擎站长工具提交 sitemap、检查 URL 收录与真实响应码。**技术配置与自动检查不能保证搜索排名、收录速度或生产 Core Web Vitals**。这里不会自动发布到你的账户或修改 DNS。

## 编辑文档与配图

正文位于 `src/content/docs/`，frontmatter 必须有独特的 `title` 和 `description`。正文从 `##` 开始，页面标题自动生成 H1。站内链接统一使用 `/guides/agents/` 等路径；构建插件会加子路径前缀。请不要给 Markdown 链接重复添加部署前缀。

图片放在 `public/media/`，在 Markdown 中用 `![有意义的替代文本](/media/作者目录/图片.svg)`。SVG 使用从零开始的 `viewBox`；构建会补原始尺寸和懒加载。截图必须使用隔离演示数据，禁止真实聊天、Token、账号或私有路径；示意图必须标明非实际截图。

分享图源文件 `src/assets/social-card.svg`，修改后执行 `pnpm --filter @superhive/docs social:image` 更新 `public/social-card.png`。这一步需要 Sharp，不依赖在线图片服务。

```bash
pnpm docs:check
pnpm --filter @superhive/docs test
pnpm docs:verify
pnpm exec prettier --check apps/docs
```

`verify` 会执行类型检查、配置单测、构建与静态产物检查；独立 docs 构建不会启动 Server 或 Agent。旧的 `docs/` Markdown 仍保留供源码阅读，用户向的完整教程以本站为主。
