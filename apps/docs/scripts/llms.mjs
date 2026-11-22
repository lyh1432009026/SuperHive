import { navigation } from "./navigation.mjs";
import { withBase } from "./site-config.mjs";
import { projectLinks, repoUrl } from "./project-links.mjs";

const INTRO =
  "SuperHive 是可以自己部署的多人、多 Agent 协作空间：人在浏览器、飞书或微信里讨论，Codex、Claude Code 等 Agent 在各自电脑上工作，通过同一个房间交换公开信息、委派子任务、登记进展和请人拍板；文件、私有会话和命令权限留在 Agent 所在的电脑上。";

/** 按侧栏顺序排好的文档页：[{ label, title, description, url, body }] */
function orderedPages(entries, site, base) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const page = (id, label) => {
    // 首页在内容集合里的 id 是 index，地址是站点根路径
    const entry = byId.get(id || "index");
    if (!entry) throw new Error(`llms.txt: 侧栏里的 ${id || "首页"} 没有对应文档`);
    return {
      label,
      title: entry.data.title,
      description: entry.data.description,
      url: new URL(withBase(id ? `${id}/` : "", base), site).href,
      body: entry.body ?? "",
    };
  };
  return [
    { group: "首页", pages: [page("", "首页")] },
    ...navigation.map((group) => ({
      group: group.label,
      pages: group.items.map((item) => page(item.slug, item.label)),
    })),
  ];
}

const header = (site, base) =>
  `# SuperHive 文档\n\n> ${INTRO}\n\n文档站：${new URL(base, site).href}\n源码：${repoUrl}\n`;

/** llms.txt：站点简介 + 按分组列出每页的链接和一句话说明（https://llmstxt.org） */
export function buildLlmsTxt(entries, site, base) {
  const sections = orderedPages(entries, site, base).map(
    ({ group, pages }) =>
      `## ${group}\n\n${pages.map((p) => `- [${p.label}](${p.url})：${p.description}`).join("\n")}`,
  );
  const links = projectLinks.map((link) => `- [${link.label}](${link.href})`).join("\n");
  return `${header(site, base)}\n${sections.join("\n\n")}\n\n## 项目链接\n\n${links}\n`;
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
export function buildLlmsFullTxt(entries, site, base) {
  const home = new URL(base, site).href;
  const pages = orderedPages(entries, site, base).flatMap(({ pages }) => pages);
  const body = pages
    .map(
      (p) =>
        `---\n\n# ${p.title}\n\n来源：${p.url}\n\n> ${p.description}\n\n${plainMarkdown(p.body, home)}\n`,
    )
    .join("\n");
  return `${header(site, base)}\n${body}`;
}
