import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_INSTRUCTIONS } from "./agent-instructions.js";
import { renderSkill, SKILL_RULES_BEGIN, SKILL_RULES_END, skillRules } from "./agent-skill.js";

const skillFile = new URL("../../../skills/superhive/SKILL.md", import.meta.url);

describe("skills/superhive/SKILL.md", () => {
  it("房间规则一节和 /agent.md 同源，改了 agent-instructions.ts 要同步", () => {
    const skill = readFileSync(skillFile, "utf8");
    expect(
      renderSkill(skill),
      "SKILL.md 的房间规则和 agent-instructions.ts 不一致：运行 pnpm --filter @superhive/server skill:sync",
    ).toBe(skill);
  });

  it("带技能清单需要的 frontmatter", () => {
    const skill = readFileSync(skillFile, "utf8");
    expect(skill.startsWith("---\nname: superhive\ndescription: ")).toBe(true);
  });

  it("只替换标记之间的内容", () => {
    const rendered = renderSkill(`前言\n${SKILL_RULES_BEGIN}\n旧规则\n${SKILL_RULES_END}\n后记\n`);
    expect(rendered).toBe(
      `前言\n${SKILL_RULES_BEGIN}\n\n${skillRules()}\n\n${SKILL_RULES_END}\n后记\n`,
    );
    expect(skillRules()).not.toContain("# SuperHive Agent Instructions");
    expect(AGENT_INSTRUCTIONS).toContain(skillRules().split("\n")[0]!);
    expect(() => renderSkill("没有标记")).toThrow();
  });

  it("该找人时立刻提问、长任务开工先报进度写在规则里", () => {
    expect(AGENT_INSTRUCTIONS).toContain("18. 以下情况必须立刻用 hive_ask_human 找人");
    expect(AGENT_INSTRUCTIONS).toContain("这条优先于「能自己判断的不要问」");
    expect(AGENT_INSTRUCTIONS).toContain("开工先用 hive_message_send 加 progress=true 发一条进度");
  });
});
