import { describe, expect, it } from "vitest";
import {
  applyProxyEnv,
  NetworkProxy,
  parseScutilProxy,
  parseWindowsProxy,
  planProxyEnv,
  ProxySettingsError,
  readSystemProxy,
  type StoredNetworkProxy,
  type SystemProxy,
} from "./network-proxy.js";

// macOS 打开 Clash「设为系统代理」后 `scutil --proxy` 的真实输出格式
const SCUTIL_CLASH = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : localhost
    3 : *.local
    4 : *.crashlytics.com
  }
  ExcludeSimpleHostnames : 1
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7891
  SOCKSProxy : 127.0.0.1
}`;

const SCUTIL_OFF = `<dictionary> {
  FTPPassive : 1
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
}`;

const REG_SIMPLE = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    DisableCachingOfSSLPages    REG_DWORD    0x0
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7890
    ProxyOverride    REG_SZ    localhost;127.*;10.*;*.corp.example.com;<local>
`;

const REG_PER_SCHEME = `
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:8080;https=127.0.0.1:8443;socks=127.0.0.1:1080
`;

const REG_DISABLED = `
    ProxyEnable    REG_DWORD    0x0
    ProxyServer    REG_SZ    127.0.0.1:7890
    AutoConfigURL    REG_SZ    http://wpad/proxy.pac
`;

describe("system proxy parsing", () => {
  it("reads macOS network settings", () => {
    expect(parseScutilProxy(SCUTIL_CLASH)).toEqual({
      https: "http://127.0.0.1:7890",
      http: "http://127.0.0.1:7890",
      socks: "socks5://127.0.0.1:7891",
      bypass: ["127.0.0.1", "localhost", ".local", ".crashlytics.com"],
    });
    expect(parseScutilProxy(SCUTIL_OFF)).toEqual({ bypass: [] });
    expect(
      parseScutilProxy("ProxyAutoConfigEnable : 1\nProxyAutoConfigURLString : http://x/p.pac"),
    ).toEqual({
      pac: true,
      bypass: [],
    });
  });

  it("reads Windows Internet Settings", () => {
    expect(parseWindowsProxy(REG_SIMPLE)).toEqual({
      https: "http://127.0.0.1:7890",
      http: "http://127.0.0.1:7890",
      bypass: ["localhost", ".corp.example.com"],
    });
    expect(parseWindowsProxy(REG_PER_SCHEME)).toEqual({
      http: "http://127.0.0.1:8080",
      https: "http://127.0.0.1:8443",
      socks: "socks5://127.0.0.1:1080",
      bypass: [],
    });
    // 代理开关关着时不用 ProxyServer；只有 PAC 时标出来
    expect(parseWindowsProxy(REG_DISABLED)).toEqual({ pac: true, bypass: [] });
  });

  it("only reads on macOS and Windows, and treats failures as no proxy", () => {
    expect(readSystemProxy("linux", () => "")).toBeUndefined();
    expect(
      readSystemProxy("darwin", () => {
        throw new Error("scutil missing");
      }),
    ).toEqual({ bypass: [] });
    const calls: string[][] = [];
    readSystemProxy("win32", (command, args) => {
      calls.push([command, ...args]);
      return REG_SIMPLE;
    });
    expect(calls[0]?.[0]).toBe("reg");
  });
});

const hiveHosts = ["127.0.0.1"];
const clash: SystemProxy = parseScutilProxy(SCUTIL_CLASH);

describe("planProxyEnv", () => {
  it("follows the system proxy when the environment has none", () => {
    const plan = planProxyEnv({ settings: { mode: "system" }, env: {}, system: clash, hiveHosts });
    expect(plan.source).toBe("system");
    expect(plan.patch.set).toMatchObject({
      HTTPS_PROXY: "http://127.0.0.1:7890",
      https_proxy: "http://127.0.0.1:7890",
      HTTP_PROXY: "http://127.0.0.1:7890",
      ALL_PROXY: "socks5://127.0.0.1:7891",
    });
    // 回环一定直连，系统里的例外也带上
    expect(plan.patch.set.NO_PROXY?.split(",")).toEqual(
      expect.arrayContaining(["localhost", "127.0.0.1", "::1", ".local", ".crashlytics.com"]),
    );
    expect(plan.patch.set.no_proxy).toBe(plan.patch.set.NO_PROXY);
  });

  it("keeps proxy variables already in the environment and only adds loopback to NO_PROXY", () => {
    const plan = planProxyEnv({
      settings: { mode: "system" },
      env: { https_proxy: "http://10.0.0.1:3128", NO_PROXY: "corp.example.com" },
      system: clash,
      hiveHosts: ["192.168.1.5"],
    });
    expect(plan.source).toBe("env");
    expect(plan.url).toBe("http://10.0.0.1:3128");
    expect(plan.patch.set).toEqual({
      NO_PROXY: "corp.example.com,localhost,127.0.0.1,::1,[::1],192.168.1.5",
      no_proxy: "corp.example.com,localhost,127.0.0.1,::1,[::1],192.168.1.5",
    });
    expect(plan.patch.unset).toEqual(["NO_PROXY", "no_proxy"]);
  });

  it("goes direct when neither the environment nor the system has a proxy", () => {
    const plan = planProxyEnv({
      settings: { mode: "system" },
      env: {},
      system: parseScutilProxy(SCUTIL_OFF),
      hiveHosts,
    });
    expect(plan).toEqual({ source: "none", patch: { set: {}, unset: [] } });
  });

  it("replaces everything with the manual address; socks also goes into ALL_PROXY", () => {
    const http = planProxyEnv({
      settings: { mode: "manual", url: "http://127.0.0.1:7890", noProxy: "example.com" },
      env: { HTTPS_PROXY: "http://old:1", ALL_PROXY: "socks5://old:2" },
      system: undefined,
      hiveHosts,
    });
    expect(http.patch.unset).toContain("ALL_PROXY");
    expect(http.patch.set).not.toHaveProperty("ALL_PROXY");
    expect(http.patch.set.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(http.patch.set.NO_PROXY).toBe("example.com,localhost,127.0.0.1,::1,[::1]");
    const socks = planProxyEnv({
      settings: { mode: "manual", url: "socks5://127.0.0.1:7891" },
      env: {},
      system: undefined,
      hiveHosts,
    });
    expect(socks.patch.set).toMatchObject({
      HTTPS_PROXY: "socks5://127.0.0.1:7891",
      ALL_PROXY: "socks5://127.0.0.1:7891",
      all_proxy: "socks5://127.0.0.1:7891",
    });
    expect(socks.patch.set.NO_PROXY).toContain(".local");
  });

  it("removes every proxy variable when told not to use a proxy", () => {
    const plan = planProxyEnv({
      settings: { mode: "none" },
      env: { HTTPS_PROXY: "http://x:1" },
      system: clash,
      hiveHosts,
    });
    expect(plan.source).toBe("none");
    expect(plan.patch.set).toEqual({});
    expect(plan.patch.unset).toEqual(
      expect.arrayContaining(["HTTPS_PROXY", "https_proxy", "NO_PROXY"]),
    );
  });
});

describe("applyProxyEnv", () => {
  it("removes variables case-insensitively before setting", () => {
    expect(
      applyProxyEnv(
        { PATH: "/bin", Https_Proxy: "http://old:1", no_proxy: "x" },
        { unset: ["HTTPS_PROXY", "NO_PROXY"], set: { NO_PROXY: "localhost" } },
      ),
    ).toEqual({ PATH: "/bin", NO_PROXY: "localhost" });
  });
});

describe("NetworkProxy", () => {
  const make = (
    initial?: StoredNetworkProxy,
    options: { system?: SystemProxy } = { system: clash },
  ) => {
    const system = options.system;
    let saved: StoredNetworkProxy | undefined = initial;
    const proxy = new NetworkProxy({
      load: () => saved,
      save: (settings) => (saved = settings),
      env: () => ({}),
      readSystem: () => system,
      serverUrl: "http://127.0.0.1:4339",
      now: () => Date.parse("2026-11-25T05:00:00Z"),
    });
    return { proxy, saved: () => saved };
  };

  it("defaults to following the system", () => {
    const { proxy } = make();
    expect(proxy.state()).toEqual({
      mode: "system",
      effective: {
        source: "system",
        url: "http://127.0.0.1:7890",
        noProxy: expect.stringContaining("127.0.0.1"),
      },
      system: { supported: true, url: "http://127.0.0.1:7890" },
      env: {},
    });
  });

  it("validates, masks credentials, and keeps them when the masked address comes back", () => {
    const { proxy, saved } = make();
    expect(() => proxy.update({ mode: "manual" })).toThrow(ProxySettingsError);
    expect(() => proxy.update({ mode: "manual", url: "ftp://h:1" })).toThrow(ProxySettingsError);
    const state = proxy.update({
      mode: "manual",
      url: "http://alice:s3cret@proxy.example.com:8080",
    });
    expect(state.url).toBe("http://***:***@proxy.example.com:8080");
    expect(state.effective.url).toBe("http://***:***@proxy.example.com:8080");
    expect(state.updatedAt).toBe("2026-11-25T05:00:00.000Z");
    expect(JSON.stringify(state)).not.toContain("s3cret");
    // 网页把打码的地址原样送回来（只改了 NO_PROXY）：账号密码不丢
    proxy.update({ url: state.url!, noProxy: "intranet.example.com" });
    expect(saved()?.url).toBe("http://alice:s3cret@proxy.example.com:8080");
    expect(proxy.plan().patch.set.HTTPS_PROXY).toBe("http://alice:s3cret@proxy.example.com:8080");
    // 切回跟随系统时保留手填的地址，下次切回手动不用重填
    proxy.update({ mode: "system" });
    expect(saved()).toMatchObject({
      mode: "system",
      url: "http://alice:s3cret@proxy.example.com:8080",
    });
    expect(proxy.plan().source).toBe("system");
  });

  it("reports when the system can't be read", () => {
    const { proxy } = make(undefined, {});
    expect(proxy.state().system).toEqual({ supported: false });
    expect(proxy.state().effective).toEqual({ source: "none" });
  });
});
