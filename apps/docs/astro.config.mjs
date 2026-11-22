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
      title: "SuperHive 文档",
      description: "自部署多人、多 Agent 协作空间的入门、日常使用与部署指南。",
      defaultLocale: "root",
      locales: { root: { label: "简体中文", lang: "zh-CN" } },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: repoUrl }],
      customCss: ["./src/styles/custom.css"],
      components: {
        Footer: "./src/components/Footer.astro",
        Head: "./src/components/Head.astro",
        Header: "./src/components/Header.astro",
        Hero: "./src/components/Hero.astro",
        SiteTitle: "./src/components/SiteTitle.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
      },
      sidebar: navigation,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
    }),
  ],
});
