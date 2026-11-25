import { describe, expect, it } from "vitest";
import {
  maskProxyUrl,
  mergeNoProxy,
  parseProxyUrl,
  restoreMaskedProxyUrl,
} from "./network-proxy.js";

describe("parseProxyUrl", () => {
  it("accepts http and socks addresses and normalizes them", () => {
    expect(parseProxyUrl("http://127.0.0.1:7890")).toEqual({
      ok: true,
      url: "http://127.0.0.1:7890",
      scheme: "http",
      socks: false,
    });
    expect(parseProxyUrl(" SOCKS5://Proxy.Example.com:1080/ ")).toMatchObject({
      ok: true,
      url: "socks5://proxy.example.com:1080",
      socks: true,
    });
    expect(parseProxyUrl("socks5h://u:p@10.0.0.2:1080")).toMatchObject({
      ok: true,
      url: "socks5h://u:p@10.0.0.2:1080",
    });
    expect(parseProxyUrl("http://[::1]:8080")).toMatchObject({
      ok: true,
      url: "http://[::1]:8080",
    });
  });

  it("treats host:port without a scheme as http", () => {
    expect(parseProxyUrl("127.0.0.1:7890")).toMatchObject({
      ok: true,
      url: "http://127.0.0.1:7890",
    });
  });

  it("rejects what proxies can't be", () => {
    expect(parseProxyUrl("")).toEqual({ ok: false, problem: "empty" });
    expect(parseProxyUrl("ftp://h:21")).toEqual({ ok: false, problem: "scheme" });
    expect(parseProxyUrl("http://127.0.0.1")).toEqual({ ok: false, problem: "port" });
    // http 的默认端口也必须写出来：省略时 URL 会吞掉，按原文判断
    expect(parseProxyUrl("http://127.0.0.1:80")).toMatchObject({
      ok: true,
      url: "http://127.0.0.1:80",
    });
    expect(parseProxyUrl("http://127.0.0.1:99999")).toMatchObject({ ok: false });
    expect(parseProxyUrl("http://127.0.0.1:7890/pac")).toEqual({ ok: false, problem: "path" });
    expect(parseProxyUrl("http://127.0.0.1:7890?x=1")).toEqual({ ok: false, problem: "path" });
    expect(parseProxyUrl("http://:7890")).toMatchObject({ ok: false });
  });
});

describe("maskProxyUrl / restoreMaskedProxyUrl", () => {
  it("hides credentials", () => {
    expect(maskProxyUrl("http://alice:s3cret@proxy:8080")).toBe("http://***:***@proxy:8080");
    expect(maskProxyUrl("socks5://token@proxy:1080")).toBe("socks5://***@proxy:1080");
    expect(maskProxyUrl("http://proxy:8080")).toBe("http://proxy:8080");
    expect(maskProxyUrl(undefined)).toBeUndefined();
  });

  it("puts stored credentials back when the masked value comes back", () => {
    const stored = "http://alice:s3cret@proxy:8080";
    expect(restoreMaskedProxyUrl("http://***:***@proxy:8080", stored)).toBe(stored);
    // 改了端口，账号密码沿用
    expect(restoreMaskedProxyUrl("http://***:***@proxy:9090", stored)).toBe(
      "http://alice:s3cret@proxy:9090",
    );
    // 新填的账号密码照常用
    expect(restoreMaskedProxyUrl("http://bob:pw@proxy:8080", stored)).toBe(
      "http://bob:pw@proxy:8080",
    );
    expect(restoreMaskedProxyUrl("http://***@proxy:8080", undefined)).toBe("http://***@proxy:8080");
  });
});

describe("mergeNoProxy", () => {
  it("dedupes case-insensitively and keeps order", () => {
    expect(mergeNoProxy("example.com, LOCALHOST", ["localhost", "127.0.0.1"], undefined)).toBe(
      "example.com,LOCALHOST,127.0.0.1",
    );
    expect(mergeNoProxy("a b\tc", "")).toBe("a,b,c");
  });
});
