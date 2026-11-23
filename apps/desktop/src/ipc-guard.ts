/**
 * IPC 来源校验：只认本机 Hive 页面（指定 origin）的顶层框架，并且必须来自我们自己的窗口。
 * iframe（比如附件预览、Markdown 里嵌的内容）、跳到别的站点后的页面、其他 webContents 一律拒绝。
 */
export type SenderLike = {
  sender: { id: number; isDestroyed?: () => boolean };
  senderFrame: { url: string; parent: unknown } | null;
};

export function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

export function isTrustedSender(
  event: SenderLike,
  allowed: { origin: string | undefined; webContentsIds: ReadonlySet<number> },
): boolean {
  if (!allowed.origin) return false;
  if (!allowed.webContentsIds.has(event.sender.id)) return false;
  if (event.sender.isDestroyed?.()) return false;
  const frame = event.senderFrame;
  // 框架已经销毁或导航走了时 senderFrame 为 null
  if (!frame) return false;
  // 只接受顶层框架
  if (frame.parent) return false;
  return originOf(frame.url) === allowed.origin;
}

/** 本机 Hive 地址只能是回环地址：终端能力绝不交给局域网上的页面 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== "http:") return false;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * preload 同步问「我能不能拿到桌面端能力」时的回答：可信的主窗口顶层框架答本机 Hive 地址，别的一律 null。
 * 窗口在本机 Hive 起好之前就建出来了（先放加载动画），所以地址不能像以前那样建窗口时写进 preload 参数。
 */
export function originAnswer(
  event: SenderLike,
  allowed: { origin: string | undefined; webContentsIds: ReadonlySet<number> },
): string | null {
  return isTrustedSender(event, allowed) ? allowed.origin! : null;
}
