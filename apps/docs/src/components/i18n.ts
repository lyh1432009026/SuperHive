// 首页自定义组件的双语文案。正文页的翻译在 src/content/docs/en/ 下，Starlight 自带的界面文字在 src/content/i18n/。
import { withBase } from "../../scripts/site-config.mjs";

export type Lang = "zh-CN" | "en";

/** 当前页面的语言：英文页在 /en/ 下，其余都是中文 */
export function pageLang(locals: App.Locals): Lang {
  return locals.starlightRoute.lang === "en" ? "en" : "zh-CN";
}

/** 站内地址加上站点前缀和语言前缀，path 不带开头的 /，例如 start/quickstart/ */
export function localePath(path: string, lang: Lang, base: string): string {
  return withBase(`${lang === "en" ? "en/" : ""}${path}`, base);
}

export const ui = {
  "zh-CN": {
    heroEyebrow: "开源 · 本机或云端部署 · 权限留在本机",
    heroTitle: "把人和 Agent，带进同一间工作室。",
    heroIntro: "从第一个 Agent，到一整个协作团队。把安装、派活、审批和交付，一步步讲清楚。",
    heroPrimary: "开始上手",
    heroSecondary: "浏览功能地图",
    teamHeading: "团队里，每个人都带着自己的 Agent",
    teamIntro:
      "多人协作时，每个人在自己电脑上接自己的 Agent，大家经同一个房间派活、互相委派、交回成果；文件和权限留在各自电脑上。",
    footerNav: "项目链接",
    themeHeading: "外观",
    themeAuto: "跟随系统",
    langHeading: "语言",
    ogImageAlt: "SuperHive 图文文档：人类与多个 Agent 的协作指南",
    siteName: "SuperHive 文档",
    groups: { start: "开始使用", guides: "使用指南", reference: "部署与参考" },
  },
  en: {
    heroEyebrow: "Open source · Run locally or in the cloud · Permissions stay local",
    heroTitle: "Bring people and agents into one workroom.",
    heroIntro:
      "From your first agent to a whole team working together — install, assign work, approve and ship, explained step by step.",
    heroPrimary: "Get started",
    heroSecondary: "Explore features",
    teamHeading: "On a team, everyone brings their own agents",
    teamIntro:
      "Each person runs their own agents on their own computer. Everyone assigns work, delegates and hands back results through the same room, while files and permissions stay on each machine.",
    footerNav: "Project links",
    themeHeading: "Appearance",
    themeAuto: "Match system",
    langHeading: "Language",
    ogImageAlt: "SuperHive docs: an illustrated guide to people and agents working together",
    siteName: "SuperHive Docs",
    groups: { start: "Getting started", guides: "Guides", reference: "Deploy & reference" },
  },
} as const;
