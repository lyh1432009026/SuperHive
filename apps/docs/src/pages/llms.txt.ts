import { getCollection } from "astro:content";
import { buildLlmsTxt } from "../../scripts/llms.mjs";
import { getSiteConfig } from "../../scripts/site-config.mjs";

export async function GET() {
  const { site, base } = getSiteConfig();
  return new Response(buildLlmsTxt(await getCollection("docs"), site, base), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
