import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { getSiteConfig, prefixContentUrls } from "./scripts/site-config.mjs";
import { navigation } from "./scripts/navigation.mjs";

const { site, base } = getSiteConfig();

export default defineConfig({
  site,
  base,
  output: "static",
  trailingSlash: "always",
  markdown: { rehypePlugins: [prefixContentUrls(base)] },
  integrations: [
    starlight({
      title: "SuperHive 文档",
      description: "自部署多人、多 Agent 协作空间的入门、日常使用与部署指南。",
      defaultLocale: "root",
      locales: { root: { label: "简体中文", lang: "zh-CN" } },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/custom.css"],
      components: {
        Head: "./src/components/Head.astro",
        Hero: "./src/components/Hero.astro",
        SiteTitle: "./src/components/SiteTitle.astro",
      },
      sidebar: navigation,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
    }),
  ],
});
