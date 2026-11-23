import { describe, expect, it } from "vitest";
import {
  isLoopbackOrigin,
  isTrustedSender,
  originAnswer,
  originOf,
  type SenderLike,
} from "./ipc-guard.js";

const origin = "http://127.0.0.1:8787";
const ids = new Set([7]);

function event(
  overrides: {
    id?: number;
    url?: string;
    parent?: unknown;
    frame?: null;
    destroyed?: boolean;
  } = {},
): SenderLike {
  return {
    sender: { id: overrides.id ?? 7, isDestroyed: () => overrides.destroyed ?? false },
    senderFrame:
      overrides.frame === null
        ? null
        : { url: overrides.url ?? `${origin}/#build`, parent: overrides.parent ?? null },
  };
}

describe("isTrustedSender", () => {
  it("accepts the top frame of our window on the local Hive origin", () => {
    expect(isTrustedSender(event(), { origin, webContentsIds: ids })).toBe(true);
  });

  it("rejects other origins, including the LAN address of the same Hive", () => {
    for (const url of [
      "https://example.com/",
      "http://192.168.1.20:8787/",
      "http://127.0.0.1:9999/",
      "file:///etc/hosts",
      "data:text/html,hi",
    ]) {
      expect(isTrustedSender(event({ url }), { origin, webContentsIds: ids }), url).toBe(false);
    }
  });

  it("rejects iframes, destroyed frames and other webContents", () => {
    expect(isTrustedSender(event({ parent: {} }), { origin, webContentsIds: ids })).toBe(false);
    expect(isTrustedSender(event({ frame: null }), { origin, webContentsIds: ids })).toBe(false);
    expect(isTrustedSender(event({ id: 8 }), { origin, webContentsIds: ids })).toBe(false);
    expect(isTrustedSender(event({ destroyed: true }), { origin, webContentsIds: ids })).toBe(
      false,
    );
  });

  it("rejects everything before the Hive origin is known", () => {
    expect(isTrustedSender(event(), { origin: undefined, webContentsIds: ids })).toBe(false);
  });
});

describe("origin helpers", () => {
  it("only gives http(s) origins", () => {
    expect(originOf("http://127.0.0.1:8787/a?b#c")).toBe(origin);
    expect(originOf("blob:http://127.0.0.1:8787/x")).toBeUndefined();
    expect(originOf("javascript:alert(1)")).toBeUndefined();
    expect(originOf("not a url")).toBeUndefined();
  });

  it("only treats loopback http as local", () => {
    expect(isLoopbackOrigin("http://127.0.0.1:8787")).toBe(true);
    expect(isLoopbackOrigin("http://localhost:8787")).toBe(true);
    expect(isLoopbackOrigin("http://[::1]:8787")).toBe(true);
    expect(isLoopbackOrigin("http://192.168.1.2:8787")).toBe(false);
    expect(isLoopbackOrigin("https://127.0.0.1:8787")).toBe(false);
  });
});

describe("originAnswer", () => {
  it("只把本机 Hive 地址告诉主窗口的顶层框架", () => {
    expect(originAnswer(event(), { origin, webContentsIds: ids })).toBe(origin);
    expect(originAnswer(event({ parent: {} }), { origin, webContentsIds: ids })).toBeNull();
    expect(originAnswer(event({ id: 9 }), { origin, webContentsIds: ids })).toBeNull();
    expect(
      originAnswer(event({ url: "data:text/html,splash" }), { origin, webContentsIds: ids }),
    ).toBeNull();
    expect(
      originAnswer(event({ url: "http://192.168.1.5:8787/" }), { origin, webContentsIds: ids }),
    ).toBeNull();
    // 本机 Hive 还没起好（加载动画阶段）时谁都拿不到
    expect(originAnswer(event(), { origin: undefined, webContentsIds: ids })).toBeNull();
  });
});
