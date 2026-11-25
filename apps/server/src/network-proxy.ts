import { execFileSync } from "node:child_process";
import {
  DEFAULT_NO_PROXY,
  LOOPBACK_NO_PROXY,
  PROXY_ENV_KEYS,
  maskProxyUrl,
  mergeNoProxy,
  networkProxySettingsSchema,
  parseProxyUrl,
  restoreMaskedProxyUrl,
  type NetworkProxySettings,
  type NetworkProxySource,
  type NetworkProxyState,
} from "@superhive/protocol";

/**
 * 本机 Agent 的网络代理：按「跟随系统 / 手动 / 不用代理」算出 Agent 子进程要补上、要去掉的环境变量。
 * 只影响 Hive 拉起的本机 Agent（及它再拉起的 claude、agy 等 CLI），不改系统设置。
 * 各 CLI 认哪些变量、为什么这样做，见 docs/research/agent-proxy.md。
 */

/** 系统代理设置里读到的（地址已经拼成 URL） */
export type SystemProxy = {
  https?: string;
  http?: string;
  socks?: string;
  /** 用的是自动代理配置（PAC / WPAD），具体地址要按网址算，读不出来 */
  pac?: boolean;
  /** 系统设置里的「不用代理的主机」，已转成 NO_PROXY 写法 */
  bypass: string[];
};

/** 给 Agent 子进程的环境变量改动：先按 unset 去掉（不分大小写），再盖上 set */
export type ProxyEnvPatch = { set: Record<string, string>; unset: string[] };

export type StoredNetworkProxy = NetworkProxySettings & { updatedAt?: string };

/** 环境变量里已有的代理：HTTPS_PROXY 优先，再 HTTP_PROXY、ALL_PROXY（大小写都看） */
export function envProxyUrl(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"]) {
    const value = envValue(env, name);
    if (value) return value;
  }
  return undefined;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name] ?? env[name.toLowerCase()];
  if (value?.trim()) return value.trim();
  // Windows 上环境变量名不分大小写，复制出来的对象里可能是 Https_Proxy 这类写法
  for (const [key, other] of Object.entries(env)) {
    if (key.toUpperCase() === name && other?.trim()) return other.trim();
  }
  return undefined;
}

/** 把 NO_PROXY 里的写法规整一下：*.example.com → .example.com；带别的通配符、CIDR 简写的去掉 */
function bypassEntry(raw: string): string | undefined {
  const item = raw.trim();
  if (!item || item === "<local>") return undefined;
  if (item.startsWith("*.")) return item.slice(1);
  if (item.includes("*") || item.includes("/")) return undefined;
  return item;
}

/**
 * macOS：`scutil --proxy` 的输出（网络设置里「代理」那一页，跟着当前网络服务走）。
 * Clash、Surge 等打开「设为系统代理」时写的就是这里。
 */
export function parseScutilProxy(output: string): SystemProxy {
  const value = (key: string) =>
    new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "m").exec(output)?.[1];
  const enabled = (key: string) => value(`${key}Enable`) === "1";
  const endpoint = (key: string, scheme: string) => {
    const host = value(`${key}Proxy`);
    const port = value(`${key}Port`);
    return enabled(key) && host && port ? `${scheme}://${host}:${port}` : undefined;
  };
  const exceptions = /ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/.exec(output)?.[1] ?? "";
  const bypass = [...exceptions.matchAll(/^\s*\d+\s*:\s*(.+?)\s*$/gm)]
    .map((match) => bypassEntry(match[1] ?? ""))
    .filter((item): item is string => Boolean(item));
  const https = endpoint("HTTPS", "http");
  const http = endpoint("HTTP", "http");
  const socks = endpoint("SOCKS", "socks5");
  return {
    ...(https ? { https } : {}),
    ...(http ? { http } : {}),
    ...(socks ? { socks } : {}),
    ...(enabled("ProxyAutoConfig") || enabled("ProxyAutoDiscovery") ? { pac: true } : {}),
    bypass,
  };
}

/**
 * Windows：`reg query "HKCU\...\Internet Settings"` 的输出（设置 → 网络 → 代理，也就是 IE / WinINET 的设置）。
 * ProxyServer 可能是 host:port（所有协议共用），也可能是 http=…;https=…;socks=…。
 */
export function parseWindowsProxy(output: string): SystemProxy {
  const value = (name: string) =>
    new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*?)\\s*$`, "im").exec(output)?.[1];
  const enabled = /^0x0*1$/i.test(value("ProxyEnable") ?? "");
  const pac = Boolean(value("AutoConfigURL"));
  const bypass = (value("ProxyOverride") ?? "")
    .split(";")
    .map(bypassEntry)
    .filter((item): item is string => Boolean(item));
  const server = enabled ? (value("ProxyServer") ?? "") : "";
  const result: SystemProxy = { bypass, ...(pac ? { pac: true } : {}) };
  if (!server) return result;
  const withScheme = (address: string, scheme: string) =>
    /^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `${scheme}://${address}`;
  if (!server.includes("=")) {
    const url = withScheme(server.trim(), "http");
    return { ...result, https: url, http: url };
  }
  for (const part of server.split(";")) {
    const [scheme, address] = part.split("=").map((item) => item.trim());
    if (!scheme || !address) continue;
    const kind = scheme.toLowerCase();
    if (kind === "https") result.https = withScheme(address, "http");
    else if (kind === "http") result.http = withScheme(address, "http");
    else if (kind === "socks") result.socks = withScheme(address, "socks5");
  }
  return result;
}

export type SystemProxyReader = () => SystemProxy | undefined;

/** 读系统代理；这个系统不支持（Linux）返回 undefined，读失败当作没设代理 */
export function readSystemProxy(
  platform: NodeJS.Platform = process.platform,
  run: (command: string, args: string[]) => string = (command, args) =>
    execFileSync(command, args, {
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }),
): SystemProxy | undefined {
  try {
    if (platform === "darwin") return parseScutilProxy(run("/usr/sbin/scutil", ["--proxy"]));
    if (platform === "win32") {
      return parseWindowsProxy(
        run("reg", [
          "query",
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
        ]),
      );
    }
  } catch {
    return { bypass: [] };
  }
  return undefined;
}

/** Agent 连 Hive 用的地址里的主机名（回环之外，例如用局域网地址起的 Server） */
export function hiveNoProxyHosts(serverUrl: string | undefined): string[] {
  if (!serverUrl) return [];
  try {
    const host = new URL(serverUrl).hostname;
    return host ? [host] : [];
  } catch {
    return [];
  }
}

export type ProxyPlan = {
  source: NetworkProxySource;
  /** 生效的地址（未打码，只给子进程用） */
  url?: string;
  noProxy?: string;
  patch: ProxyEnvPatch;
};

/**
 * 按设置算出 Agent 子进程的代理环境变量：
 * - none：代理相关变量全部去掉
 * - manual：去掉原有的，换成手填的；socks 地址同时写进 ALL_PROXY
 * - system：环境里已有就沿用，只补 NO_PROXY；没有再用系统代理
 * 有代理时 NO_PROXY 强制带上回环和 Hive 自己的地址。
 */
export function planProxyEnv(options: {
  settings: NetworkProxySettings;
  env: NodeJS.ProcessEnv;
  system: SystemProxy | undefined;
  hiveHosts: readonly string[];
}): ProxyPlan {
  const { settings, env, system } = options;
  const forced = [...LOOPBACK_NO_PROXY, ...options.hiveHosts];
  const removeAll = [...PROXY_ENV_KEYS];
  const both = (name: string, value: string) => ({ [name]: value, [name.toLowerCase()]: value });

  if (settings.mode === "none") {
    return { source: "none", patch: { set: {}, unset: removeAll } };
  }

  if (settings.mode === "manual") {
    const parsed = settings.url ? parseProxyUrl(settings.url) : undefined;
    if (!parsed?.ok) return { source: "none", patch: { set: {}, unset: removeAll } };
    const noProxy = mergeNoProxy(settings.noProxy ?? DEFAULT_NO_PROXY, forced);
    return {
      source: "manual",
      url: parsed.url,
      noProxy,
      patch: {
        unset: removeAll,
        set: {
          ...both("HTTPS_PROXY", parsed.url),
          ...both("HTTP_PROXY", parsed.url),
          ...(parsed.socks ? both("ALL_PROXY", parsed.url) : {}),
          ...both("NO_PROXY", noProxy),
        },
      },
    };
  }

  const fromEnv = envProxyUrl(env);
  const existingNoProxy = envValue(env, "NO_PROXY");
  if (fromEnv) {
    const noProxy = mergeNoProxy(existingNoProxy, forced);
    return {
      source: "env",
      url: fromEnv,
      noProxy,
      patch: { unset: ["NO_PROXY", "no_proxy"], set: both("NO_PROXY", noProxy) },
    };
  }
  const https = system?.https ?? system?.http ?? system?.socks;
  const http = system?.http ?? system?.https ?? system?.socks;
  if (!https || !http) return { source: "none", patch: { set: {}, unset: [] } };
  const noProxy = mergeNoProxy(existingNoProxy, system?.bypass, forced);
  return {
    source: "system",
    url: https,
    noProxy,
    patch: {
      unset: removeAll,
      set: {
        ...both("HTTPS_PROXY", https),
        ...both("HTTP_PROXY", http),
        ...(system?.socks ? both("ALL_PROXY", system.socks) : {}),
        ...both("NO_PROXY", noProxy),
      },
    },
  };
}

/** 套用到一份环境变量上：unset 不分大小写（Windows 上变量名不分大小写） */
export function applyProxyEnv(
  env: Record<string, string | undefined>,
  patch: ProxyEnvPatch | undefined,
): Record<string, string | undefined> {
  if (!patch) return env;
  const remove = new Set(patch.unset.map((name) => name.toUpperCase()));
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!remove.has(key.toUpperCase())) result[key] = value;
  }
  return Object.assign(result, patch.set);
}

/** 设置的读写和当前状态；网页「这台电脑 → 网络代理」用 */
export class NetworkProxy {
  private stored: StoredNetworkProxy;

  constructor(
    private readonly deps: {
      load(): StoredNetworkProxy | undefined;
      save(settings: StoredNetworkProxy): void;
      /** 启动 Hive 的环境（桌面端已从登录 shell 补上代理变量） */
      env: () => NodeJS.ProcessEnv;
      readSystem?: SystemProxyReader;
      platform?: NodeJS.Platform;
      serverUrl?: string;
      now?: () => number;
    },
  ) {
    this.stored = deps.load() ?? { mode: "system" };
  }

  settings(): StoredNetworkProxy {
    return this.stored;
  }

  private system(): SystemProxy | undefined {
    return (this.deps.readSystem ?? (() => readSystemProxy(this.deps.platform)))();
  }

  /** 下一次启动 Agent 用的环境变量改动 */
  plan(): ProxyPlan {
    return planProxyEnv({
      settings: this.stored,
      env: this.deps.env(),
      system: this.stored.mode === "system" ? this.system() : undefined,
      hiveHosts: hiveNoProxyHosts(this.deps.serverUrl),
    });
  }

  state(): NetworkProxyState {
    const system = this.system();
    const plan = planProxyEnv({
      settings: this.stored,
      env: this.deps.env(),
      system: this.stored.mode === "system" ? system : undefined,
      hiveHosts: hiveNoProxyHosts(this.deps.serverUrl),
    });
    const systemUrl = system?.https ?? system?.http ?? system?.socks;
    const envUrl = envProxyUrl(this.deps.env());
    return {
      mode: this.stored.mode,
      ...(this.stored.url ? { url: maskProxyUrl(this.stored.url) } : {}),
      ...(this.stored.noProxy !== undefined ? { noProxy: this.stored.noProxy } : {}),
      ...(this.stored.updatedAt ? { updatedAt: this.stored.updatedAt } : {}),
      effective: {
        source: plan.source,
        ...(plan.url ? { url: maskProxyUrl(plan.url) } : {}),
        ...(plan.noProxy ? { noProxy: plan.noProxy } : {}),
      },
      system: {
        supported: system !== undefined,
        ...(systemUrl ? { url: maskProxyUrl(systemUrl) } : {}),
        ...(system?.pac ? { pac: true } : {}),
      },
      env: envUrl ? { url: maskProxyUrl(envUrl) } : {},
    };
  }

  /**
   * 改设置。手动模式必须有合法地址；网页提交回来的打码地址换回原来的账号密码。
   * 不合法时抛出 problem（parseProxyUrl 的原因），由路由层转成 400。
   */
  update(patch: Partial<NetworkProxySettings>): NetworkProxyState {
    const merged = networkProxySettingsSchema.parse({ ...this.stored, ...patch });
    const next: StoredNetworkProxy = { mode: merged.mode };
    if (merged.url) {
      const parsed = parseProxyUrl(restoreMaskedProxyUrl(merged.url, this.stored.url));
      if (!parsed.ok) throw new ProxySettingsError(parsed.problem);
      next.url = parsed.url;
    } else if (merged.mode === "manual") {
      throw new ProxySettingsError("empty");
    }
    if (merged.noProxy !== undefined) next.noProxy = mergeNoProxy(merged.noProxy);
    next.updatedAt = new Date(this.deps.now?.() ?? Date.now()).toISOString();
    this.stored = next;
    this.deps.save(next);
    return this.state();
  }
}

export class ProxySettingsError extends Error {
  constructor(readonly problem: string) {
    super(`invalid proxy: ${problem}`);
  }
}
