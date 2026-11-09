import { describe, expect, it } from "vitest";
// 这个包不依赖 protocol；测试直接读源码核对两边的键和中文模板一致
import { serverTexts } from "../../protocol/src/server-text.js";
import { BRIDGE_TEXTS, bridgeText, said } from "./bridge-text.js";

describe("bridge texts", () => {
  it("match the server text catalog, key for key", () => {
    const catalog = serverTexts as Record<string, { zh: string; en: string }>;
    for (const [key, zh] of Object.entries(BRIDGE_TEXTS)) {
      expect(catalog[key]?.zh, key).toBe(zh);
    }
  });

  it("reports the Chinese detail together with the structured text", () => {
    const why = bridgeText("bridge.upstreamExhausted", { count: 2 });
    expect(said(bridgeText("bridge.upstreamFailed", { reason: "API Error: 429", why }))).toEqual({
      detail:
        "上游模型服务出错：API Error: 429。已自动继续 2 次仍未成功；点「继续」会接着原会话从中断处往下做。",
      detailText: { key: "bridge.upstreamFailed", params: { reason: "API Error: 429", why } },
    });
  });
});
