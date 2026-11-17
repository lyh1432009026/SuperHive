---
title: 单独部署文档站
description: 把 SuperHive 文档作为独立静态网站部署：配置真实域名、单独构建 apps/docs、发布到静态托管或 Nginx，并检查 sitemap、robots 与子路径。
---

## 文档站与 Hive 服务是两件事

这份文档本身也是 monorepo 的一个应用：`apps/docs`。它在构建时生成完整 HTML，访问时不需要登录 Hive，也不需要启动 Server、数据库或任何 Agent。

你可以只部署文档，不公开自己的协作房间；也可以让文档和 Hive 使用不同的域名。需要部署协作服务本身，请看[部署 Hive 服务](/reference/deployment/)。

## 在本机查看

从源码仓库根目录开始，需要 Node.js 22.12+ 与 pnpm 10：

```bash
pnpm install --filter @superhive/docs --filter superhive-workspace --frozen-lockfile
pnpm docs:dev
```

打开终端打印的地址，默认端口为 4321。开发模式适合编辑正文；静态搜索在构建阶段生成，所以搜索验收应使用 `pnpm docs:verify`，然后运行 `pnpm --filter @superhive/docs preview`。

## 发布到自己的域名

下面的域名只是示例，必须换成你拥有的真实 HTTPS 域名：

```bash
DOCS_SITE_URL=https://docs.your-domain.com \
pnpm --filter @superhive/docs build:deploy
```

将生成的 `apps/docs/dist/` 上传到静态托管平台即可。这个目录已经包含正文、图片、样式和搜索索引，无需一起上传 Hive Server。

| 发布配置 | 内容                                                      |
| -------- | --------------------------------------------------------- |
| 根目录   | monorepo 仓库根目录                                       |
| 安装命令 | `pnpm install --filter @superhive/docs --frozen-lockfile` |
| 构建命令 | `pnpm --filter @superhive/docs build:deploy`              |
| 发布目录 | `apps/docs/dist`                                          |
| 环境变量 | `DOCS_SITE_URL` 设置为真实 HTTPS origin                   |

普通 `build` 没有设置域名时只生成不可索引预览，防止测试站误入搜索结果。正式构建会拒绝未配置 HTTPS 地址或设置了 `DOCS_NOINDEX=true` 的发布。

## 页面路径与 404

页面采用 `/guides/agents/` 这样的稳定目录路径。托管平台需要将它映射到相应目录里的 `index.html`，而不是把所有路径都返回首页。

不存在的页面应展示 `404.html` 并返回 **HTTP 404**。不要使用常见的 SPA“所有请求返回首页 200”规则，否则搜索引擎会把不存在的地址当作真实页面。

## 如果挂在子路径下

例如把文档放到主站的 `/handbook/`：

```bash
DOCS_SITE_URL=https://www.your-domain.com \
DOCS_BASE_PATH=/handbook/ \
pnpm --filter @superhive/docs build:deploy
```

域名变量不含路径，前缀单独设置。构建后把 `dist/` 挂载到这个前缀，文章、图片、导航、canonical 与 sitemap 会使用同一前缀。

:::caution[robots.txt 必须在域名根目录]
搜索引擎只读取 `/robots.txt`，不会把 `/handbook/robots.txt` 当作站点规则。请在主站根 robots 中添加文档的 sitemap，并确认没有禁止抓取 `/handbook/`。
:::

## 发布前与上线后分别检查什么

**构建验收**检查独特的标题和摘要、静态正文、链接与图片、结构化数据、sitemap、robots、分享图和搜索索引；你仍要在真正的托管环境检查 HTTPS、深层链接、404 响应、缓存和手机布局。

上线后在搜索引擎站长工具提交 `/sitemap-index.xml`（有子路径时加对应前缀），检查抓取和收录。技术 SEO 做好不等于排名已经提升，也不能代替真实访问条件下的性能测量。

需要 Docker / Nginx 配置、编辑规范和完整发布清单时，查看源码仓库中的 `apps/docs/README.md`。了解站点涵盖哪些内容，可以从[功能地图](/start/overview/)继续。
