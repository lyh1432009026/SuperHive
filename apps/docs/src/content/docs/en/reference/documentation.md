---
title: Deploy the docs site separately
description: Deploy the SuperHive docs as a standalone static site, set a real domain, build apps/docs alone, publish it, and check sitemap, robots, and subpaths.
---

## The docs site and the Hive Server are separate

These docs are themselves an app in the monorepo: `apps/docs`. It generates complete HTML at build time, so readers don't need to sign in to Hive, and you don't need to run the Server, a database, or any agents.

You can deploy only the docs without exposing your own collaboration rooms, and the docs and Hive can use different domains. To deploy the collaboration service itself, see [Deploy the Hive Server](/en/reference/deployment/).

## Preview locally

From the root of the source repository, with Node.js 22.12+ and pnpm 10:

```bash
pnpm install --filter @superhive/docs --filter superhive-workspace --frozen-lockfile
pnpm docs:dev
```

Open the address printed in the terminal; the default port is 4321. Dev mode is good for editing content. Static search is generated at build time, so to check search, run `pnpm docs:verify` and then `pnpm --filter @superhive/docs preview`.

## Publish to your own domain

The domain below is only an example; replace it with a real HTTPS domain you own:

```bash
DOCS_SITE_URL=https://docs.your-domain.com \
pnpm --filter @superhive/docs build:deploy
```

Upload the generated `apps/docs/dist/` to any static hosting platform. It already contains the content, images, styles, and search index; there's no need to upload the Hive Server alongside it.

| Setting               | Value                                                     |
| --------------------- | --------------------------------------------------------- |
| Root directory        | The monorepo root                                         |
| Install command       | `pnpm install --filter @superhive/docs --frozen-lockfile` |
| Build command         | `pnpm --filter @superhive/docs build:deploy`              |
| Publish directory     | `apps/docs/dist`                                          |
| Environment variables | Set `DOCS_SITE_URL` to the real HTTPS origin              |

A plain `build` without a domain produces a non-indexable preview, so test sites don't end up in search results. The production build refuses to publish if no HTTPS URL is configured or `DOCS_NOINDEX=true` is set.

## Page paths and 404s

Pages use stable directory paths such as `/guides/agents/`. Your host must map them to the `index.html` in the matching directory instead of returning the home page for every path.

Missing pages should show `404.html` and return **HTTP 404**. Don't use the common SPA rule of "return the home page with 200 for every request", or search engines will treat nonexistent URLs as real pages.

## Hosting under a subpath

For example, to serve the docs under `/handbook/` on your main site:

```bash
DOCS_SITE_URL=https://www.your-domain.com \
DOCS_BASE_PATH=/handbook/ \
pnpm --filter @superhive/docs build:deploy
```

The domain variable has no path; the prefix is set separately. After building, mount `dist/` at that prefix. Articles, images, navigation, canonical URLs, and the sitemap all use the same prefix.

:::caution[robots.txt must be at the domain root]
Search engines only read `/robots.txt`; they don't treat `/handbook/robots.txt` as site rules. Add the docs sitemap to your main site's root robots file and make sure `/handbook/` isn't disallowed.
:::

## What to check before and after launch

**Build verification** checks unique titles and descriptions, static content, links and images, structured data, the sitemap, robots, social images, and the search index. You still need to check HTTPS, deep links, 404 responses, caching, and mobile layout on the real host.

After launch, submit `/sitemap-index.xml` (with your prefix if you use a subpath) in the search engines' webmaster tools and check crawling and indexing. Good technical SEO doesn't mean your rankings have improved, and it doesn't replace measuring performance under real-world conditions.

For Docker / Nginx configs, editing guidelines, and the full release checklist, see `apps/docs/README.md` in the source repository. To see what the site covers, continue with the [feature map](/en/start/overview/).
