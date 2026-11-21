import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 消息行 <article class="message …"> 上挂的修饰类。它们只在 messages.css 里以 .message.xxx 出现，
// 但别的模块若定义了同名的顶层单类（比如「进展」面板的 .progress），会整条盖掉消息行的网格布局
const MESSAGE_MODIFIERS = [
  "agent",
  "human",
  "own",
  "grouped",
  "selectable",
  "selected",
  "deleted",
  "highlighted",
  "question",
  "progress-update",
  "machine",
];

describe("消息行修饰类", () => {
  it("不和其他样式模块的顶层单类同名", () => {
    const dir = fileURLToPath(new URL("./styles/", import.meta.url));
    const topLevel = new Set<string>();
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".css"))) {
      for (const match of readFileSync(dir + file, "utf8").matchAll(
        /^\.([a-z][a-z0-9-]*)\s*[{,]/gm,
      )) {
        topLevel.add(match[1]!);
      }
    }
    expect(MESSAGE_MODIFIERS.filter((name) => topLevel.has(name))).toEqual([]);
    // 修饰类确实还在用：改名时这里会提醒同步上面的清单
    const list = readFileSync(
      fileURLToPath(new URL("./message-list.tsx", import.meta.url)),
      "utf8",
    );
    expect(list).toContain('"progress-update"');
  });
});
