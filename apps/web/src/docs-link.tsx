import type { ReactNode } from "react";
import { docsUrl, type DocsLinkKey } from "@superhive/protocol";
import { Icon } from "./app-icons";
import { getLocale, t } from "./i18n";

/** 文档站对应页面：英文界面链到 /en/ 下的同一页（地址表见 protocol 的 docs-links.ts） */
export function docsHref(key: DocsLinkKey): string {
  return docsUrl(key, getLocale());
}

/** 就地的文档链接：小号次要样式，新标签页打开 */
export function DocsLink({ to, children }: { to: DocsLinkKey; children: ReactNode }) {
  return (
    <a className="docs-link" href={docsHref(to)} target="_blank" rel="noreferrer">
      {children}
      <Icon name="external" size={12} />
      <span className="sr-only">{t("（在新标签页打开）")}</span>
    </a>
  );
}
