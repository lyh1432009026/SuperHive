export function getSiteConfig(environment = process.env) {
  const rawSite = environment.DOCS_SITE_URL?.trim();
  const site = new URL(rawSite || "https://docs.example.invalid");
  if (
    !["https:", "http:"].includes(site.protocol) ||
    site.username ||
    site.password ||
    site.search ||
    site.hash ||
    site.pathname !== "/"
  ) {
    throw new Error("DOCS_SITE_URL must be an http(s) origin, without credentials, path or query.");
  }
  const rawBase = environment.DOCS_BASE_PATH || "/";
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(rawBase)) {
    throw new Error("DOCS_BASE_PATH must start and end with /, for example /handbook/.");
  }
  const indexable = Boolean(
    rawSite &&
    site.protocol === "https:" &&
    !["localhost", "0.0.0.0", "[::1]"].includes(site.hostname) &&
    !site.hostname.startsWith("127.") &&
    !site.hostname.endsWith(".localhost") &&
    !site.hostname.endsWith(".invalid") &&
    environment.DOCS_NOINDEX !== "true",
  );
  return { site: site.origin, base: rawBase, indexable };
}

export function withBase(pathname, base) {
  return `${base}${pathname.replace(/^\//, "")}`;
}

const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));
const screensRoot = fileURLToPath(new URL("../public/media/screens/", import.meta.url));

/** 英文页的配图：有 名字.en.扩展名 的英文版就换成它，没有就沿用中文图 */
export function localizedMedia(source, lang) {
  if (lang !== "en") return source;
  const english = source.replace(/(\.[a-z]+)$/, ".en$1");
  return existsSync(resolve(publicRoot, english.slice(1))) ? english : source;
}

// `![说明](/media/screens/名字.png)` 展开成明暗两张真实界面截图，跟随文档主题切换。
// 英文页优先用 名字.en.dark.png / 名字.en.light.png 这套英文界面截图。
export function themedScreenshot(node, lang = "zh-CN") {
  const source =
    node.type === "element" && node.tagName === "img" ? node.properties?.src : undefined;
  const match = typeof source === "string" && source.match(/^\/media\/screens\/([\w-]+)\.png$/);
  if (!match || !existsSync(resolve(screensRoot, `${match[1]}.dark.png`))) return [node];
  const name =
    lang === "en" && existsSync(resolve(screensRoot, `${match[1]}.en.dark.png`))
      ? `${match[1]}.en`
      : match[1];
  return ["light", "dark"].map((theme) => ({
    ...node,
    properties: {
      ...node.properties,
      src: `/media/screens/${name}.${theme}.png`,
      className: ["docs-shot", theme === "light" ? "dark:sl-hidden" : "light:sl-hidden"],
    },
  }));
}

export function prefixContentUrls(base) {
  return () => (tree, file) => {
    // 英文页在 src/content/docs/en/ 下
    const lang = /[\\/]content[\\/]docs[\\/]en[\\/]/.test(file?.path ?? "") ? "en" : "zh-CN";
    function visit(node) {
      if (node.children)
        node.children = node.children.flatMap((child) => themedScreenshot(child, lang));
      if (node.type === "element" && node.properties) {
        if (node.tagName === "img") {
          if (typeof node.properties.src === "string" && node.properties.src.startsWith("/media/"))
            node.properties.src = localizedMedia(node.properties.src, lang);
          const source = node.properties.src;
          node.properties.loading = "lazy";
          node.properties.decoding = "async";
          if (typeof source === "string" && source.startsWith("/media/")) {
            const root = resolve(publicRoot);
            const path = resolve(root, source.slice(1));
            if (path.startsWith(`${root}/`) && existsSync(path)) {
              const image = readFileSync(path);
              if (source.endsWith(".svg")) {
                const viewBox = image
                  .toString()
                  .match(/viewBox=["']\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*["']/);
                if (viewBox) {
                  node.properties.width = Number(viewBox[1]);
                  node.properties.height = Number(viewBox[2]);
                }
              } else if (source.endsWith(".png") && image.length >= 24) {
                // 界面截图按 2 倍像素截取，按一半尺寸显示才清晰
                const scale = source.startsWith("/media/screens/") ? 2 : 1;
                node.properties.width = image.readUInt32BE(16) / scale;
                node.properties.height = image.readUInt32BE(20) / scale;
              }
            }
          }
        }
        for (const attribute of ["href", "src"]) {
          const value = node.properties[attribute];
          if (typeof value === "string" && value.startsWith("/") && !value.startsWith("//")) {
            node.properties[attribute] = withBase(value, base);
          }
        }
      }
      node.children?.forEach(visit);
    }
    visit(tree);
  };
}
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
