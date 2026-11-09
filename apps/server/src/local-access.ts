import { serverText, type ServerText } from "@superhive/protocol";
import { networkInterfaces } from "node:os";

/**
 * 判断一个 HTTP 请求是否来自 Hive Server 所在的这台电脑本身。
 * "本机 Agent" 能在这台电脑上启动进程，只能给坐在这台电脑前的房主用：
 * - 对端地址必须是回环地址或本机网卡地址（允许用局域网 IP 访问自己）
 * - 经过反向代理的请求一律拒绝：同机代理会让所有外部访问者看起来都像本机
 * - Host 必须是 localhost 或本机 IP 字面量：DNS rebinding 时 Host 是攻击者的域名
 * - 带 Origin 时其主机也必须属于本机，且端口与页面所访问的端口一致（或是登记过的网页端口，例如 dev 时的 Vite）：
 *   拦住恶意网页从浏览器里发起的跨站请求，包括同一台电脑上别的端口跑着的网页
 */

export type LocalRequestLike = {
  socket: { remoteAddress?: string | undefined };
  headers: Record<string, string | string[] | undefined>;
};

export type LocalCheck = { local: true } | { local: false; reason: ServerText };

const PROXY_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"];
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** 去掉 IPv4-mapped 前缀与 IPv6 方括号，统一成小写 */
function normalizeAddress(address: string): string {
  const unbracketed = address.replace(/^\[|\]$/g, "").toLowerCase();
  return unbracketed.startsWith("::ffff:") ? unbracketed.slice(7) : unbracketed;
}

function isLoopback(address: string): boolean {
  return LOOPBACK_NAMES.has(address) || /^127\./.test(address);
}

/** 本机所有网卡地址；每次现取，网卡变化（换 Wi-Fi、开 VPN）后无需重启 */
export function localAddresses(): Set<string> {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.add(normalizeAddress(entry.address));
  }
  return addresses;
}

function hostnameOf(value: string, withScheme: boolean): string | undefined {
  return parse(value, withScheme)?.hostname;
}

function parse(value: string, withScheme: boolean): { hostname: string; port: string } | undefined {
  try {
    const url = new URL(withScheme ? value : `http://${value}`);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return { hostname: normalizeAddress(url.hostname), port };
  } catch {
    return undefined;
  }
}

export function checkLocalRequest(
  request: LocalRequestLike,
  addresses: Set<string> = localAddresses(),
  /** 除了 Host 的端口，还允许哪些端口上的本机网页（dev 时的 Vite 端口） */
  options: { originPorts?: readonly string[] } = {},
): LocalCheck {
  const isSelf = (address: string) => isLoopback(address) || addresses.has(address);

  const remote = request.socket.remoteAddress ? normalizeAddress(request.socket.remoteAddress) : "";
  if (!remote || !isSelf(remote))
    return { local: false, reason: serverText("error.local.notThisComputer") };
  if (PROXY_HEADERS.some((name) => request.headers[name] !== undefined)) {
    return { local: false, reason: serverText("error.local.proxied") };
  }

  const hostHeader = request.headers.host;
  const host = typeof hostHeader === "string" ? hostnameOf(hostHeader, false) : undefined;
  if (!host || !isSelf(host)) {
    return { local: false, reason: serverText("error.local.host") };
  }

  const originHeader = request.headers.origin;
  if (originHeader !== undefined) {
    const origin = typeof originHeader === "string" ? parse(originHeader, true) : undefined;
    const hostPort = typeof hostHeader === "string" ? parse(hostHeader, false)?.port : undefined;
    if (
      !origin ||
      !isSelf(origin.hostname) ||
      (origin.port !== hostPort && !options.originPorts?.includes(origin.port))
    ) {
      return { local: false, reason: serverText("error.local.crossSite") };
    }
  }
  return { local: true };
}
