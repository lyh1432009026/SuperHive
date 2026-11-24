/**
 * `--superhive-cli` 模式下 Chromium 自己的数据目录（HTTP / GPU 缓存）放哪。
 * 不能和正开着的桌面端共用，也不能几个 Agent 进程共用：Windows 上缓存目录被占着时会报
 * 「Unable to move the cache: 拒绝访问」，刷满 Agent 日志。每个 Agent 按名字一个固定子目录
 * （重启复用，不越积越多），其它一次性命令（mcp list、models、--version）共用一个。
 */
export function cliUserDataName(args: readonly string[]): string {
  if (args[0] !== "join") return "oneshot";
  let name: string | undefined;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--name") name = args[i + 1];
    else if (arg.startsWith("--name=")) name = arg.slice("--name=".length);
  }
  const safe = (name ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  return safe ? `agent-${safe}` : "oneshot";
}
