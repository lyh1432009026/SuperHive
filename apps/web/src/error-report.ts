import type { ClientErrorReport } from "@superhive/protocol";

/** 同一个报错在这么长时间内只报一次：渲染循环里反复抛的错不刷屏 */
export const ERROR_REPORT_DEDUPE_MS = 60_000;

/** 浏览器扩展、跨域脚本这类和我们代码无关的报错：不报 */
export function ignorableError(message: string, stack: string | undefined): boolean {
  if (/^Script error\.?$/i.test(message.trim())) return true;
  if (/ResizeObserver loop/i.test(message)) return true;
  return /(?:chrome|moz|safari(?:-web)?)-extension:\/\//.test(stack ?? "");
}

export function reportFrom(
  kind: ClientErrorReport["kind"],
  reason: unknown,
  fallbackMessage?: string,
): ClientErrorReport {
  const error = reason instanceof Error ? reason : undefined;
  return {
    kind,
    ...(error?.name ? { name: error.name.slice(0, 100) } : {}),
    message: (error?.message || fallbackMessage || String(reason)).slice(0, 1000),
    ...(error?.stack ? { stack: error.stack.slice(0, 8000) } : {}),
    url: window.location.href.slice(0, 2000),
    userAgent: navigator.userAgent.slice(0, 500),
  };
}

/**
 * 房主页面上的报错交给 Server 归档成故障单（访客的页面不报：Server 只收房主的）。
 * 只报未捕获的异常和没人处理的 Promise 拒绝；同一个报错一分钟内只报一次。返回卸载函数。
 */
export function installErrorReporter(options: {
  base: string;
  token: string;
  roomId: () => string | undefined;
  send?: (report: ClientErrorReport, roomId: string | undefined) => void;
}): () => void {
  const lastSent = new Map<string, number>();
  const send =
    options.send ??
    ((report: ClientErrorReport, roomId: string | undefined) => {
      void fetch(`${options.base}/api/client-errors`, {
        method: "POST",
        keepalive: true,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.token}`,
          ...(roomId ? { "X-Hive-Room": roomId } : {}),
        },
        body: JSON.stringify(report),
      }).catch(() => undefined);
    });
  const submit = (report: ClientErrorReport) => {
    if (ignorableError(report.message, report.stack)) return;
    const key = `${report.kind} ${report.name ?? ""} ${report.message}`;
    const now = Date.now();
    if (now - (lastSent.get(key) ?? 0) < ERROR_REPORT_DEDUPE_MS) return;
    lastSent.set(key, now);
    send(report, options.roomId());
  };
  const onError = (event: ErrorEvent) => submit(reportFrom("error", event.error, event.message));
  const onRejection = (event: PromiseRejectionEvent) =>
    submit(reportFrom("unhandledrejection", event.reason));
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
