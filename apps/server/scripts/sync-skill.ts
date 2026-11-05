// 把 agent-instructions.ts 里的规则同步进 skills/superhive/SKILL.md（见 src/agent-skill.ts）
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderSkill } from "../src/agent-skill.js";

const file = fileURLToPath(new URL("../../../skills/superhive/SKILL.md", import.meta.url));
const current = readFileSync(file, "utf8");
const next = renderSkill(current);
if (next === current) {
  console.log("[skill:sync] SKILL.md 已是最新");
} else {
  writeFileSync(file, next);
  console.log("[skill:sync] 已更新 skills/superhive/SKILL.md");
}
