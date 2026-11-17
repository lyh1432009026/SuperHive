import { getSiteConfig } from "../../scripts/site-config.mjs";

export function GET() {
  const { site, base, indexable } = getSiteConfig();
  return new Response(
    `User-agent: *\n${indexable ? "Allow: /" : "Disallow: /"}\n\nSitemap: ${site}${base}sitemap-index.xml\n`,
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}
