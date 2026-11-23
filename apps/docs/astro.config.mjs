import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import aiIns from "@ai-ins/astro";
import { getSiteConfig, prefixContentUrls } from "./scripts/site-config.mjs";
import { navigation } from "./scripts/navigation.mjs";
import { repoUrl } from "./scripts/project-links.mjs";

const { site, base } = getSiteConfig();

export default defineConfig({
  site,
  base,
  output: "static",
  trailingSlash: "always",
  markdown: { rehypePlugins: [prefixContentUrls(base)] },
  integrations: [
    aiIns(),
    starlight({
      title: { "zh-CN": "SuperHive 文档", en: "SuperHive Docs" },
      description:
        "开源多人、多 Agent 协作空间的入门、日常使用与部署指南，可在自己电脑上运行，也可部署到云服务器用网址访问。",
      // 中文是根语言，地址不变；英文页在 /en/ 下
      defaultLocale: "root",
      locales: {
        root: { label: "简体中文", lang: "zh-CN" },
        en: { label: "English", lang: "en" },
      },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: repoUrl }],
      customCss: ["./src/styles/custom.css"],
      components: {
        ContentPanel: "./src/components/ContentPanel.astro",
        Footer: "./src/components/Footer.astro",
        Head: "./src/components/Head.astro",
        Header: "./src/components/Header.astro",
        Hero: "./src/components/Hero.astro",
        LanguageSelect: "./src/components/LanguageSelect.astro",
        SiteTitle: "./src/components/SiteTitle.astro",
        ThemeProvider: "./src/components/ThemeProvider.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
      },
      sidebar: navigation,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
    }),
  ],
});
