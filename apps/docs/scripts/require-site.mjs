import { getSiteConfig } from "./site-config.mjs";

if (!getSiteConfig().indexable) {
  throw new Error(
    "Production build requires DOCS_SITE_URL=https://YOUR_REAL_DOMAIN and DOCS_NOINDEX must not be true. Use build for a noindex preview.",
  );
}
