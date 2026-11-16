import net from "node:net";

/**
 * Node 24.15+ 自带的 undici 在每个新 HTTP/1.1 连接上调 socket.setTypeOfService()，对端刚好把连接重置时
 * macOS 会让它同步抛 EINVAL。它发生在 socket 回调里，任何 fetch 的 catch 都接不住，整个进程直接崩掉：
 * 断网或网络切换一下，正在干活的 Agent 全部变成「结果未知」。undici 8.8 已修（nodejs/undici#5547），
 * Node 24 还没带上；这里只吞掉 EINVAL，fetch 照常以连接自身的错误（ECONNRESET 等）失败并走重试。
 */
export function guardSocketTypeOfService(): void {
  const proto = net.Socket.prototype as net.Socket & {
    setTypeOfService?: (...args: unknown[]) => net.Socket;
  };
  const original = proto.setTypeOfService;
  if (!original || (original as { tosGuard?: boolean }).tosGuard) return;
  const guarded = function (this: net.Socket, ...args: unknown[]) {
    try {
      return original.apply(this, args);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EINVAL") return this;
      throw error;
    }
  };
  (guarded as { tosGuard?: boolean }).tosGuard = true;
  proto.setTypeOfService = guarded;
}

guardSocketTypeOfService();
