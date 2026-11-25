import { z } from "zod";

/**
 * 本机 Agent 的网络代理（设置 → 这台电脑 → 网络代理）。只影响 Hive 拉起的本机 Agent 子进程的环境变量，
 * 不改系统设置。调研与各 CLI 的支持情况见 docs/research/agent-proxy.md。
 *
 * - system：跟随系统（默认）。启动 Hive 的环境里已有代理变量就沿用；没有就读系统代理（macOS 网络设置、
 *   Windows 的「代理服务器」设置）补上 HTTPS_PROXY / HTTP_PROXY
 * - manual：用这里填的地址，原有的代理变量先全部去掉
 * - none：不用代理，代理相关变量全部去掉
 *
 * 不管哪种，只要有代理，NO_PROXY 都强制带上本机回环和 Hive 自己的地址，免得 Agent 连 Hive 被代理截走。
 */
export const networkProxyModeSchema = z.enum(["system", "manual", "none"]);
export type NetworkProxyMode = z.infer<typeof networkProxyModeSchema>;

export const PROXY_URL_SCHEMES = ["http", "https", "socks5", "socks5h", "socks4", "socks"] as const;

/** 代理相关的环境变量（大小写两种写法都有程序在读） */
export const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

/** 必须直连的地址：Agent 连 Hive、MCP 都走本机回环 */
export const LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "::1", "[::1]"] as const;

/** 手动模式下 NO_PROXY 的默认值（回环之外，再加常见的内网写法） */
export const DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1,.local";

export const networkProxySettingsSchema = z.object({
  mode: networkProxyModeSchema,
  /** 手动模式的地址，例如 http://127.0.0.1:7890、socks5://127.0.0.1:7891 */
  url: z.string().trim().max(2048).optional(),
  /** 手动模式的 NO_PROXY，逗号分隔；回环地址无论填没填都会加上 */
  noProxy: z.string().trim().max(4096).optional(),
});
export type NetworkProxySettings = z.infer<typeof networkProxySettingsSchema>;

/** 生效的代理从哪来：env=启动 Hive 的环境变量；system=系统代理设置；manual=手填；none=直连 */
export const networkProxySourceSchema = z.enum(["env", "system", "manual", "none"]);
export type NetworkProxySource = z.infer<typeof networkProxySourceSchema>;

export const networkProxyStateSchema = z.object({
  mode: networkProxyModeSchema,
  /** 手填的地址，账号密码换成 *** */
  url: z.string().optional(),
  noProxy: z.string().optional(),
  /** 上次改设置的时间：在这之前启动的 Agent 还是旧设置，要重启 */
  updatedAt: z.string().datetime().optional(),
  /** 下一次启动 Agent 时实际会用的代理 */
  effective: z.object({
    source: networkProxySourceSchema,
    /** 打码后的地址；直连时没有 */
    url: z.string().optional(),
    noProxy: z.string().optional(),
  }),
  /** 读到的系统代理（打码）；supported=false 表示这个系统读不了（Linux） */
  system: z.object({
    supported: z.boolean(),
    url: z.string().optional(),
    /** 系统用的是自动代理配置（PAC），读不出具体地址 */
    pac: z.boolean().optional(),
  }),
  /** 启动 Hive 的环境里已经有的代理变量（打码） */
  env: z.object({ url: z.string().optional() }),
});
export type NetworkProxyState = z.infer<typeof networkProxyStateSchema>;

export type ProxyUrlProblem = "empty" | "invalid" | "scheme" | "host" | "port" | "path";

/**
 * 校验并规整代理地址：只认 http(s)://、socks5(h)://、socks4://；必须有主机和端口，不能带路径、查询参数。
 * 没写协议的（127.0.0.1:7890）按 http 处理，Clash、v2rayN 等界面上显示的就是这种写法。
 */
export function parseProxyUrl(
  input: string,
):
  | { ok: true; url: string; scheme: string; socks: boolean }
  | { ok: false; problem: ProxyUrlProblem } {
  const text = input.trim();
  if (!text) return { ok: false, problem: "empty" };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, problem: "invalid" };
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (!(PROXY_URL_SCHEMES as readonly string[]).includes(scheme)) {
    return { ok: false, problem: "scheme" };
  }
  if (!parsed.hostname) return { ok: false, problem: "host" };
  // 特殊协议（http/https）的 URL 会把默认端口吞掉，这里从原文判断有没有写端口
  const authority = withScheme.slice(withScheme.indexOf("//") + 2).split(/[/?#]/)[0] ?? "";
  const hostPart = authority.slice(authority.lastIndexOf("@") + 1);
  if (!/:\d+$/.test(hostPart)) return { ok: false, problem: "port" };
  const port = Number(hostPart.slice(hostPart.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, problem: "port" };
  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    return { ok: false, problem: "path" };
  }
  const auth = parsed.username
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@`
    : "";
  return {
    ok: true,
    url: `${scheme}://${auth}${parsed.hostname.toLowerCase()}:${port}`,
    scheme,
    socks: scheme.startsWith("socks"),
  };
}

const MASK = "***";

/** 账号密码换成 ***，界面和日志里只显示这个 */
export function maskProxyUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  return url.replace(
    /^([a-z][a-z0-9+.-]*:\/\/)([^@/]*)@/i,
    (_match, scheme: string, auth: string) =>
      auth.includes(":") ? `${scheme}${MASK}:${MASK}@` : `${scheme}${MASK}@`,
  );
}

/**
 * 网页提交回来的地址里账号密码还是 ***（没改）时，换回保存着的原值；改了主机端口照样保留原账号密码。
 * 其它情况原样返回。
 */
export function restoreMaskedProxyUrl(incoming: string, stored: string | undefined): string {
  const match = /^([a-z][a-z0-9+.-]*:\/\/)\*\*\*(?::\*\*\*)?@(.*)$/i.exec(incoming.trim());
  if (!match || !stored) return incoming;
  const storedAuth = /^[a-z][a-z0-9+.-]*:\/\/([^@/]*)@/i.exec(stored)?.[1];
  if (!storedAuth) return `${match[1]}${match[2]}`;
  return `${match[1]}${storedAuth}@${match[2]}`;
}

/** 合并 NO_PROXY：逗号或空白分隔，去重（不分大小写），保持先后顺序 */
export function mergeNoProxy(...lists: Array<string | readonly string[] | undefined>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    if (!list) continue;
    const items = typeof list === "string" ? list.split(/[,\s]+/) : list;
    for (const raw of items) {
      const item = raw.trim();
      if (!item) continue;
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out.join(",");
}
