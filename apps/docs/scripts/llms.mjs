import { navLabel, navigation } from "./navigation.mjs";
import { withBase } from "./site-config.mjs";
import { projectLinks, repoUrl } from "./project-links.mjs";

// 中英文各一份：中文在站点根路径，英文在 /en/ 下
const TEXT = {
  "zh-CN": {
    title: "SuperHive 文档",
    intro:
      "SuperHive 是开源的多人、多 Agent 协作空间，可以在自己电脑上运行，也可以部署到云服务器、用浏览器打开网址访问。人在浏览器、飞书或微信里讨论，Codex、Claude Code 等 Agent 在各自电脑上工作，通过同一个房间交换公开信息、委派子任务、登记进展和请人拍板；文件、私有会话和命令权限留在 Agent 所在的电脑上。",
    site: "文档站",
    source: "源码",
    home: "首页",
    links: "项目链接",
    from: "来源",
    colon: "：",
  },
  en: {
    title: "SuperHive Docs",
    intro:
      "SuperHive is an open-source collaboration space for multiple people and multiple agents. Run it on your own computer or deploy it to a cloud server and open it in the browser. People talk in the browser, Feishu (Lark) or WeChat; agents such as Codex and Claude Code work on their own computers and use one shared room to exchange public messages, delegate subtasks, report progress and ask people for decisions. Files, private sessions and command permissions stay on the computer each agent runs on.",
    site: "Docs",
    source: "Source",
    home: "Home",
    links: "Project links",
    from: "Source",
    colon: ": ",
  },
};

const prefix = (lang) => (lang === "en" ? "en/" : "");

/** 按侧栏顺序排好的文档页：[{ label, title, description, url, body }] */
function orderedPages(entries, site, base, lang) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const page = (id, label) => {
    // 首页在内容集合里的 id 是 index（英文是 en），地址是站点根路径（英文是 en/）
    const key = lang === "en" ? (id ? `en/${id}` : "en") : id || "index";
    const entry = byId.get(key);
    if (!entry) throw new Error(`llms.txt: 侧栏里的 ${key} 没有对应文档`);
    return {
      label,
      title: entry.data.title,
      description: entry.data.description,
      url: new URL(withBase(`${prefix(lang)}${id ? `${id}/` : ""}`, base), site).href,
      body: entry.body ?? "",
    };
  };
  return [
    { group: TEXT[lang].home, pages: [page("", TEXT[lang].home)] },
    ...navigation.map((group) => ({
      group: navLabel(group, lang),
      pages: group.items.map((item) => page(item.slug, navLabel(item, lang))),
    })),
  ];
}

const header = (site, base, lang) => {
  const text = TEXT[lang];
  const home = new URL(withBase(prefix(lang), base), site).href;
  return `# ${text.title}\n\n> ${text.intro}\n\n${text.site}${text.colon}${home}\n${text.source}${text.colon}${repoUrl}\n`;
};

/** llms.txt：站点简介 + 按分组列出每页的链接和一句话说明（https://llmstxt.org） */
export function buildLlmsTxt(entries, site, base, lang = "zh-CN") {
  const text = TEXT[lang];
  const sections = orderedPages(entries, site, base, lang).map(
    ({ group, pages }) =>
      `## ${group}\n\n${pages.map((p) => `- [${p.label}](${p.url})${text.colon}${p.description}`).join("\n")}`,
  );
  const links = projectLinks
    .map((link) => `- [${lang === "en" ? link.en : link.label}](${link.href})`)
    .join("\n");
  return `${header(site, base, lang)}\n${sections.join("\n\n")}\n\n## ${text.links}\n\n${links}\n`;
}

/** 正文给模型读：去掉 MDX 的 import 和独占一行的组件标签，站内链接补成完整地址 */
function plainMarkdown(body, home) {
  return body
    .replace(/^import .*\n?/gm, "")
    .replace(/^<[A-Z][^>]*\/>\s*\n?/gm, "")
    .replace(/\]\(\//g, `](${home}`)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** llms-full.txt：同样的顺序，附上每页的 Markdown 正文 */
export function buildLlmsFullTxt(entries, site, base, lang = "zh-CN") {
  const text = TEXT[lang];
  // 正文里的站内链接已经带了 en/ 前缀，这里只补站点地址
  const home = new URL(base, site).href;
  const pages = orderedPages(entries, site, base, lang).flatMap(({ pages }) => pages);
  const body = pages
    .map(
      (p) =>
        `---\n\n# ${p.title}\n\n${text.from}${text.colon}${p.url}\n\n> ${p.description}\n\n${plainMarkdown(p.body, home)}\n`,
    )
    .join("\n");
  return `${header(site, base, lang)}\n${body}`;
}
