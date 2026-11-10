import { describe, expect, it } from "vitest";
import {
  englishForms,
  fillTemplate,
  placeholders,
  serverTextTemplate,
  renderServerText,
  serverText,
  serverTextSchema,
  serverTexts,
  zhText,
  type ServerTextEntry,
} from "./server-text.js";

/** 汉字、全角标点：英文文案里不该出现 */
const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

describe("serverTexts", () => {
  const entries = Object.entries(serverTexts) as Array<[string, ServerTextEntry]>;

  it("has both languages for every key, with the same placeholders", () => {
    for (const [key, entry] of entries) {
      expect(entry.zh.trim(), key).not.toBe("");
      for (const en of englishForms(entry)) {
        expect(en.trim(), key).not.toBe("");
        expect(placeholders(en), key).toEqual(placeholders(entry.zh));
      }
    }
  });

  it("keeps Chinese out of the English texts", () => {
    for (const [key, entry] of entries)
      for (const en of englishForms(entry)) expect(CJK.test(en), `${key}: ${en}`).toBe(false);
  });

  it("groups keys by domain", () => {
    for (const [key] of entries) expect(key, key).toMatch(/^[a-z][A-Za-z]*\.[A-Za-z0-9.]+$/);
  });
});

describe("serverTextTemplate", () => {
  const entry: ServerTextEntry = {
    zh: "追加了 {turns} 轮",
    en: { one: "added {turns} turn", other: "added {turns} turns" },
    plural: "turns",
  };
  const render = (turns: number, locale: "zh-CN" | "en") =>
    fillTemplate(serverTextTemplate(entry, locale, { turns }), () => String(turns));

  it("picks the English singular or plural form by the count parameter", () => {
    expect(render(1, "en")).toBe("added 1 turn");
    expect(render(2, "en")).toBe("added 2 turns");
    expect(render(0, "en")).toBe("added 0 turns");
    expect(render(1, "zh-CN")).toBe("追加了 1 轮");
    // 默认看 count；没有数量时用复数
    const byCount: ServerTextEntry = {
      zh: "{count} 台",
      en: { one: "{count} device", other: "{count} devices" },
    };
    expect(serverTextTemplate(byCount, "en", { count: 1 })).toBe("{count} device");
    expect(serverTextTemplate(byCount, "en", {})).toBe("{count} devices");
  });
});

describe("renderServerText", () => {
  it("fills placeholders, renders nested texts in the same language and falls back for unknown keys", () => {
    const text = serverText("invocation.stoppedReason", {
      reason: serverText("invocation.recalledNotRun"),
    });
    expect(renderServerText(text, "en")).toBe("Message unsent; not run; stopped");
    expect(zhText(text)).toBe("消息已撤回，未执行，已停止");
    expect(renderServerText(serverText("schedule.cancelledBy", { name: "rd" }), "en")).toBe(
      "Cancelled by rd",
    );
    expect(renderServerText({ key: "future.key" }, "en")).toBeUndefined();
    // 单复数按数字参数选
    expect(renderServerText(serverText("error.progress.limit", { limit: 1 }), "en")).toContain(
      "its 1 progress update,",
    );
    expect(renderServerText(serverText("error.progress.limit", { limit: 3 }), "en")).toContain(
      "3 progress updates,",
    );
    expect(renderServerText(undefined, "en")).toBeUndefined();
  });

  it("validates the wire shape, accepting keys it does not know yet", () => {
    expect(serverTextSchema.safeParse({ key: "future.key", params: { n: 1 } }).success).toBe(true);
    expect(
      serverTextSchema.safeParse({ key: "a.b", params: { reason: { key: "c.d" } } }).success,
    ).toBe(true);
    expect(serverTextSchema.safeParse({ key: "a.b", extra: 1 }).success).toBe(false);
    expect(serverTextSchema.safeParse({ key: "" }).success).toBe(false);
  });
});
