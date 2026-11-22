import { useEffect, useLayoutEffect, useState } from "react";
import { t } from "./i18n";

/**
 * 沙箱预览（`pnpm preview:sandbox` 起的 Server）在页面顶部挂一个醒目的标记，免得把副本当成真实房间。
 * 只问一次 /health：沙箱标记是启动时定的，不会中途变化；问不到（正常 Server、离线）就什么都不显示。
 */
export function SandboxBadge({ base }: { base: string }) {
  const [sandbox, setSandbox] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${base}/health`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((value: unknown) => {
        if (!cancelled && (value as { sandbox?: unknown } | null)?.sandbox === true)
          setSandbox(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [base]);

  // 标题和 data-sandbox 要和角标在同一次提交里生效：用普通 effect 时角标已经插进页面、标题还没改，
  // 中间隔着一次异步调度（机器忙时能看出来，测试也会偶发读到旧标题）。
  useLayoutEffect(() => {
    if (!sandbox) return;
    const prefix = `[${t("沙箱")}] `;
    document.documentElement.dataset.sandbox = "true";
    if (!document.title.startsWith(prefix)) document.title = prefix + document.title;
    return () => {
      delete document.documentElement.dataset.sandbox;
      if (document.title.startsWith(prefix)) document.title = document.title.slice(prefix.length);
    };
  }, [sandbox]);

  if (!sandbox) return null;
  return (
    <div className="sandbox-badge" role="status">
      <strong>{t("沙箱预览")}</strong>
      <span>{t("副本数据，不连外部")}</span>
    </div>
  );
}
