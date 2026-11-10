import { describe, expect, it } from "vitest";
import { englishForms, type ServerTextEntry } from "@superhive/protocol";
import { imText, imTexts, parseImLocale, renderImMessage } from "./im-texts.js";

const CJK = /[㐀-鿿、-〿！（），：；？]/u;
/** 英文里故意留的中文：切到中文的按钮、告诉人可以填 zh（中文） */
const CHINESE_ON_PURPOSE = new Set(["im.button.otherLanguage", "im.lang.invalid"]);

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

describe("IM 文案目录", () => {
  it("每条都有中英文，两边占位符一致，英文里不夹中文", () => {
    for (const [key, entry] of Object.entries(imTexts) as Array<[string, ServerTextEntry]>) {
      expect(entry.zh.trim(), key).not.toBe("");
      for (const en of englishForms(entry)) {
        expect(en.trim(), key).not.toBe("");
        expect(placeholders(en), key).toEqual(placeholders(entry.zh));
        if (!CHINESE_ON_PURPOSE.has(key)) expect(en, key).not.toMatch(CJK);
      }
    }
  });

  it("按语言渲染，参数可以是另一句话", () => {
    expect(imText("en", "im.task.title", { agents: "codex" })).toBe("Sent to codex");
    expect(imText("zh-CN", "im.task.title", { agents: "codex" })).toBe("已派给 codex");
    const notice = {
      key: "im.audit.notice",
      params: {
        device: "iPhone",
        host: "mac",
        action: { key: "im.audit.roomCleared", params: { room: "build" } },
      },
    } as const;
    expect(renderImMessage("en", notice)).toContain('"iPhone" cleared the room build on mac');
    expect(renderImMessage("zh-CN", notice)).toContain("在 mac 上清空了房间 build");
  });

  it("英文按数量分单复数：1 条用单数，其余用复数", () => {
    const cases: Array<
      [Parameters<typeof imText>[1], Record<string, number | string>, string, string]
    > = [
      ["im.digest.title", { count: 1 }, "1 new message", "2 new messages"],
      [
        "im.audit.revokeOthers",
        { count: 1 },
        "signed out 1 other device",
        "signed out 2 other devices",
      ],
      ["im.resolved.extended", { turns: 1 }, "Added 1 turn", "Added 2 turns"],
      [
        "im.byOwner.continue",
        { turns: 1, owner: "rd" },
        "rd added 1 turn in Feishu",
        "rd added 2 turns in Feishu",
      ],
      [
        "im.notice.pausedNote",
        { turns: 1 },
        "Tap Continue to allow 1 more turn",
        "Tap Continue to allow 2 more turns",
      ],
      ["im.toast.stopped", { count: 1 }, "Asked 1 task to stop", "Asked 2 tasks to stop"],
      [
        "im.pick.prompt",
        { count: 1, token: "cl" },
        '"cl" matches 1 agent. Who should get it?',
        '"cl" matches 2 agents. Who should get it?',
      ],
    ];
    for (const [key, params, one, other] of cases) {
      const name = "turns" in params ? "turns" : "count";
      expect(imText("en", key, params)).toBe(one);
      expect(imText("en", key, { ...params, [name]: 2 })).toBe(other);
    }
    expect(imText("en", "im.toast.stopPartial", { ok: 2, failed: 1 })).toBe(
      "Asked 2 of them to stop; 1 task couldn't be stopped",
    );
    expect(imText("zh-CN", "im.resolved.extended", { turns: 1 })).toBe("已追加 1 轮");
  });

  it("认得中英文写法的语言名", () => {
    expect(parseImLocale("English")).toBe("en");
    expect(parseImLocale(" EN ")).toBe("en");
    expect(parseImLocale("中文")).toBe("zh-CN");
    expect(parseImLocale("zh")).toBe("zh-CN");
    expect(parseImLocale("fr")).toBeUndefined();
  });
});
