import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * `hive --skill`：打印随包发布的 skills/superhive/SKILL.md，和已安装的版本一一对应。
 * 打包时由 copy:skill 复制到包内 skills/；从仓库运行时读仓库根目录那份。
 */
const CANDIDATES = ["../skills/superhive/SKILL.md", "../../../skills/superhive/SKILL.md"];

export function readSkill(base: string = import.meta.url): string {
  for (const candidate of CANDIDATES) {
    try {
      return readFileSync(fileURLToPath(new URL(candidate, base)), "utf8");
    } catch {
      /* 试下一个位置 */
    }
  }
  throw new Error("当前安装包里没有 SKILL.md，请重新安装 superhive。");
}
