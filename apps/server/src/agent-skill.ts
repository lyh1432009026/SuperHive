import { AGENT_INSTRUCTIONS } from "./agent-instructions.js";

/**
 * skills/superhive/SKILL.md 里「房间规则」一节由 AGENT_INSTRUCTIONS 生成，和 GET /agent.md 同源：
 * 只改 agent-instructions.ts，再运行 `pnpm --filter @superhive/server skill:sync` 同步，不要手改这一节。
 * agent-skill.test.ts 会在两边不一致时失败。
 */
export const SKILL_RULES_BEGIN =
  "<!-- BEGIN agent-instructions：由 apps/server/src/agent-instructions.ts 生成，勿手改 -->";
export const SKILL_RULES_END = "<!-- END agent-instructions -->";

/** 规则正文：去掉 /agent.md 自己的一级标题，放进 SKILL.md 的小节里 */
export function skillRules(): string {
  return AGENT_INSTRUCTIONS.replace(/^# .*\n+/, "").trim();
}

/** 把 SKILL.md 里两个标记之间的内容换成当前规则；找不到标记时报错 */
export function renderSkill(skill: string): string {
  const begin = skill.indexOf(SKILL_RULES_BEGIN);
  const end = skill.indexOf(SKILL_RULES_END);
  if (begin < 0 || end < begin) {
    throw new Error("SKILL.md 里找不到 agent-instructions 的起止标记。");
  }
  return `${skill.slice(0, begin + SKILL_RULES_BEGIN.length)}\n\n${skillRules()}\n\n${skill.slice(end)}`;
}
