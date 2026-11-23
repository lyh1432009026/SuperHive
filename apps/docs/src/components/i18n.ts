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
    footerNav: "项目链接",
    themeHeading: "外观",
    themeAuto: "跟随系统",
    langHeading: "语言",
    ogImageAlt: "SuperHive 图文文档：人类与多个 Agent 的协作指南",
    siteName: "SuperHive 文档",
    groups: { start: "开始使用", guides: "使用指南", reference: "部署与参考" },
  },
  en: {
    footerNav: "Project links",
    themeHeading: "Appearance",
    themeAuto: "Match system",
    langHeading: "Language",
    ogImageAlt: "SuperHive docs: an illustrated guide to people and agents working together",
    siteName: "SuperHive Docs",
    groups: { start: "Getting started", guides: "Guides", reference: "Deploy & reference" },
  },
} as const;
