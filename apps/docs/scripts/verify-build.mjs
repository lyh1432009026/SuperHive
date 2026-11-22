import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "cheerio";
import { getSiteConfig, withBase } from "./site-config.mjs";
import { expectedRoutes } from "./navigation.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(appRoot, "dist");
const { site, base, indexable } = getSiteConfig();
const errors = [];
const documents = new Map();

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filepath = join(directory, entry.name);
    return entry.isDirectory() ? walk(filepath) : [filepath];
  });
}

function check(condition, message) {
  if (!condition) errors.push(message);
}

for (const filepath of walk(output).filter((file) => file.endsWith(".html"))) {
  const html = readFileSync(filepath, "utf8");
  check(
    !/data-ai-ins-source|ai-ins\/client|\/__ai-ins-agent|\/__ai-ins-config/.test(html),
    `${relative(output, filepath)}: AI Ins development tooling leaked into production HTML`,
  );
  const relativePath = relative(output, filepath).replaceAll("\\", "/");
  const route = relativePath === "index.html" ? "" : relativePath.replace(/index\.html$/, "");
  documents.set(new URL(withBase(route, base), site).href, {
    filepath,
    dom: load(html),
  });
}

const titles = new Set();
const descriptions = new Set();
let pages = 0;
let images = 0;
let links = 0;

for (const [url, { filepath, dom }] of documents) {
  const is404 = filepath.endsWith("404.html");
  const label = relative(output, filepath);
  check(dom("html").attr("lang") === "zh-CN", `${label}: missing zh-CN language`);
  check(dom("h1").length === 1, `${label}: requires exactly one H1`);
  const robots = dom('meta[name="robots"]').attr("content") || "";
  check(robots.includes("noindex") === (!indexable || is404), `${label}: wrong indexing policy`);
  if (is404) {
    check(robots.includes("noindex"), "404 must not be indexed");
    check(dom("[data-pagefind-ignore]").length > 0, "404 must be excluded from static search");
    continue;
  }
  pages += 1;
  const title = dom("title").text();
  const description = dom('meta[name="description"]').attr("content") || "";
  check(title.length > 5 && !titles.has(title), `${label}: missing or duplicated title`);
  check(
    description.length >= 20 && !descriptions.has(description),
    `${label}: missing or duplicated description`,
  );
  check(
    description.length >= 50 && description.length <= 120,
    `${label}: description should be 50–120 characters, received ${description.length}`,
  );
  titles.add(title);
  descriptions.add(description);
  check(dom('link[rel="canonical"]').length === 1, `${label}: requires one canonical`);
  check(dom('link[rel="canonical"]').attr("href") === url, `${label}: incorrect canonical`);
  check(dom('meta[property="og:url"]').attr("content") === url, `${label}: incorrect OG URL`);
  check(
    dom('meta[property="og:description"]').attr("content") === description,
    `${label}: OG description differs`,
  );
  check(
    dom('meta[name="twitter:card"]').attr("content") === "summary_large_image",
    `${label}: missing Twitter card`,
  );
  const ogImage = dom('meta[property="og:image"]').attr("content");
  check(Boolean(ogImage?.endsWith(".png")), `${label}: sharing image must be a raster PNG`);
  check(dom("main").text().trim().length > 100, `${label}: body must be available in static HTML`);
  const schemas = dom('script[type="application/ld+json"]');
  check(schemas.length > 0, `${label}: missing structured data`);
  const isHome = url === new URL(base, site).href;
  schemas.toArray().forEach((schema) => {
    try {
      const data = JSON.parse(dom(schema).text());
      check(data["@context"] === "https://schema.org", `${label}: invalid schema context`);
      check(Array.isArray(data["@graph"]), `${label}: missing schema graph`);
      const graph = data["@graph"] ?? [];
      const breadcrumb = graph.find((item) => item["@type"] === "BreadcrumbList");
      check(
        breadcrumb?.itemListElement?.length === (isHome ? 1 : 2) &&
          breadcrumb.itemListElement.at(-1).item === url,
        `${label}: BreadcrumbList must end at this page`,
      );
      const software = graph.find((item) => item["@type"] === "SoftwareApplication");
      if (isHome) {
        check(
          software?.name === "SuperHive" &&
            software.applicationCategory === "DeveloperApplication" &&
            software.offers?.price === "0" &&
            software.sameAs?.some((link) => link.includes("npmjs.com")),
          `${label}: home needs a SoftwareApplication with GitHub and npm links`,
        );
      } else {
        check(!software, `${label}: SoftwareApplication belongs on the home page only`);
      }
    } catch {
      errors.push(`${label}: invalid JSON-LD`);
    }
  });
  dom("img")
    .toArray()
    .forEach((element) => {
      images += 1;
      const image = dom(element);
      check(Boolean(image.attr("alt")?.trim()), `${label}: image needs meaningful alt`);
      check(
        Boolean(image.attr("width") && image.attr("height")),
        `${label}: image dimensions missing`,
      );
      if (image.parents("main").length) {
        check(
          image.attr("loading") === "lazy" || image.attr("fetchpriority") === "high",
          `${label}: image load priority missing`,
        );
      }
      const source = image.attr("src");
      if (source) validateTarget(source, url, label, false);
    });
  dom("a[href], link[rel='stylesheet'], link[rel='icon'], link[rel='shortcut icon']")
    .toArray()
    .forEach((element) => {
      links += 1;
      validateTarget(dom(element).attr("href"), url, label, true);
    });
}

function validateTarget(href, current, label, validateHash) {
  if (!href || /^(mailto:|tel:|javascript:|data:)/.test(href)) return;
  const target = new URL(href, current);
  if (target.origin !== site) return;
  check(target.pathname.startsWith(base), `${label}: link escapes deployment base: ${href}`);
  const pathname = decodeURIComponent(target.pathname.slice(base.length));
  const local = join(output, pathname);
  const targetFile =
    existsSync(local) && statSync(local).isDirectory() ? join(local, "index.html") : local;
  check(existsSync(targetFile), `${label}: broken local target: ${href}`);
  if (target.hash && validateHash) {
    const key = new URL(target.pathname, site).href;
    const document = documents.get(key);
    if (document) {
      const anchor = decodeURIComponent(target.hash.slice(1));
      check(
        document
          .dom("[id]")
          .toArray()
          .some((element) => element.attribs.id === anchor),
        `${label}: missing anchor: ${href}`,
      );
    }
  }
}

check(pages >= 19, `Expected at least 19 documentation pages, received ${pages}`);
for (const route of expectedRoutes) {
  check(
    documents.has(new URL(withBase(route, base), site).href),
    `Required documentation route missing: ${route || "/"}`,
  );
}
check(images >= 6, `Expected at least 6 illustrations, received ${images}`);
check(existsSync(join(output, "pagefind/pagefind.js")), "Static Pagefind search bundle missing");
check(existsSync(join(output, "social-card.png")), "Social sharing image missing");
const robots = readFileSync(join(output, "robots.txt"), "utf8");
check(
  indexable ? robots.includes("Allow: /") : robots.includes("Disallow: /"),
  "robots.txt indexing policy differs",
);
check(
  robots.includes(`${site}${base}sitemap-index.xml`),
  "robots sitemap must respect origin and base",
);
const llms = existsSync(join(output, "llms.txt"))
  ? readFileSync(join(output, "llms.txt"), "utf8")
  : "";
const llmsFull = existsSync(join(output, "llms-full.txt"))
  ? readFileSync(join(output, "llms-full.txt"), "utf8")
  : "";
check(llms.startsWith("# SuperHive 文档\n\n> "), "llms.txt needs a title and a summary blockquote");
check(llmsFull.startsWith("# SuperHive 文档"), "llms-full.txt missing");
for (const [url, { filepath }] of documents) {
  if (filepath.endsWith("404.html")) continue;
  check(llms.includes(`](${url})`), `llms.txt missing link to ${url}`);
  check(llmsFull.includes(`来源：${url}`), `llms-full.txt missing ${url}`);
}
check(
  !/^(?:import |<[A-Z])/m.test(llmsFull),
  "llms-full.txt must not contain MDX imports or components",
);

const sitemapFiles = walk(output).filter((file) => /sitemap.*\.xml$/.test(file));
const sitemapUrls = sitemapFiles.flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]),
);
for (const [url, { filepath }] of documents) {
  if (!filepath.endsWith("404.html")) check(sitemapUrls.includes(url), `Sitemap missing ${url}`);
}
check(!sitemapUrls.some((url) => url.includes("404")), "404 must not appear in sitemap");

for (const filepath of walk(output).filter((file) => /\.(?:js|mjs|css)$/.test(file))) {
  check(
    !/data-ai-ins-source|ai-ins\/client|\/__ai-ins-agent|\/__ai-ins-config/.test(
      readFileSync(filepath, "utf8"),
    ),
    `${relative(output, filepath)}: AI Ins development tooling leaked into production assets`,
  );
}

if (errors.length) {
  console.error(errors.join("\n"));
  assert.fail(`${errors.length} static documentation checks failed`);
}
console.log(
  `Verified ${pages} static pages, ${images} images and ${links} links; metadata, JSON-LD, sitemap, robots, search and ${base} deployment paths passed.`,
);
