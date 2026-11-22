import { useEffect, useState } from "react";
import { t } from "../i18n";
import { renderDocx, type RenderedDocx } from "./docx-render";
import { useElementSize, useThemeValue } from "./hooks";
import { IsolatedFrame } from "./isolated-frame";
import type { OfficeViewProps } from "./types";

/** 纸张只缩不放；按 5% 一档取整，拖动面板宽度时不会每个像素都重排一次 iframe */
export function docxZoom(available: number, pageWidth: number, padding: number): number {
  if (available <= 0 || pageWidth <= 0) return 1;
  const fit = available / (pageWidth + padding * 2);
  return Math.max(0.2, Math.min(1, Math.floor(fit * 20) / 20));
}

/** 滚动条占的宽度，留出来免得纸张右边被盖住 */
const SCROLLBAR = 16;

export default function DocxView({ bytes, name, compact, onError }: OfficeViewProps) {
  const [doc, setDoc] = useState<{ bytes: Uint8Array; value: RenderedDocx }>();
  useEffect(() => {
    let alive = true;
    renderDocx(bytes).then(
      (value) => alive && setDoc({ bytes, value }),
      (cause: unknown) => alive && onError(cause),
    );
    return () => {
      alive = false;
    };
  }, [bytes, onError]);
  const [measure, size] = useElementSize<HTMLDivElement>();
  const backdrop = useThemeValue("--bg-subtle", "#f3f3f3");
  const thumb = useThemeValue("--scrollbar-thumb", "rgb(0 0 0 / 0.18)");
  const thumbHover = useThemeValue("--scrollbar-thumb-hover", "rgb(0 0 0 / 0.34)");
  const current = doc?.bytes === bytes ? doc.value : undefined;
  const padding = compact ? 8 : 24;
  const zoom = current ? docxZoom(size.width - SCROLLBAR, current.pageWidth, padding) : 1;
  const css = [
    `html{zoom:${zoom}}`,
    `html,body{margin:0;background:${backdrop}}`,
    `.docx-wrapper{background:transparent!important;padding:${padding}px ${padding}px 0!important}`,
    `.docx-wrapper>section.docx{box-shadow:0 1px 4px rgba(0,0,0,.18)!important;margin-bottom:${padding}px!important}`,
    "a[aria-disabled]{color:inherit;text-decoration:underline dotted;cursor:default}",
    // iframe 里是独立文档，页面的细滚动条样式（base.css）进不来，这里照着再写一份
    "::-webkit-scrollbar{width:10px;height:10px}",
    "::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}",
    `::-webkit-scrollbar-thumb{border:2px solid transparent;border-radius:999px;background:${thumb} padding-box}`,
    `::-webkit-scrollbar-thumb:hover{background-color:${thumbHover}}`,
    "::-webkit-scrollbar-button{display:none}",
    `@supports not selector(::-webkit-scrollbar){html{scrollbar-width:thin;scrollbar-color:${thumb} transparent}}`,
  ].join("\n");
  return (
    <div className="office-docx" ref={measure}>
      {!current ? (
        <p className="office-preview-status" role="status">
          {t("正在排版文档…")}
        </p>
      ) : (
        size.width > 0 && (
          <IsolatedFrame className="office-frame" title={name} body={current.body} css={css} />
        )
      )}
      {current && !compact && (
        <p className="office-preview-footer">
          {t("共 {0} 页", { 0: current.pages })}
          {zoom < 1 ? ` · ${Math.round(zoom * 100)}%` : ""}
        </p>
      )}
    </div>
  );
}
