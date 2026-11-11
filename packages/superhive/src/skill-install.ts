import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** 装进各 Agent 全局 skills 目录的技能名，和 skills/superhive/SKILL.md 的 frontmatter 一致 */
export const SKILL_NAME = "superhive";

/** 写进安装文件的托管标记：hive 靠它识别「这份是我们装的、装的哪个版本」 */
const MARKER_RE = /id=superhive version=([^\s;>；]+)/;

/** 支持全局安装 SKILL.md 的 Agent：目录约定是 <agent 主目录>/skills/<name>/SKILL.md */
export interface SkillTarget {
  id: string;
  label: string;
  /** Agent 自己的配置目录名（如 ".claude"），拼在 home 下；不存在视为这台电脑没装该 Agent */
  dirName: string;
}

export const SKILL_TARGETS: SkillTarget[] = [
  { id: "claude", label: "Claude Code", dirName: ".claude" },
  { id: "codex", label: "Codex CLI", dirName: ".codex" },
  { id: "openclaw", label: "OpenClaw", dirName: ".openclaw" },
];

export function findSkillTarget(id: string): SkillTarget {
  const target = SKILL_TARGETS.find((candidate) => candidate.id === id);
  if (!target) {
    throw new Error(
      `未知的 Agent：“${id}”。支持：${SKILL_TARGETS.map((item) => item.id).join("、")}。`,
    );
  }
  return target;
}

/** SKILL.md 在某台电脑上的安装路径 */
export function installedSkillPath(target: SkillTarget, home = homedir()): string {
  return path.join(home, target.dirName, "skills", SKILL_NAME, "SKILL.md");
}

/** 安装内容 = 随包发布的 SKILL.md + 末尾一行托管标记（frontmatter 必须保持在文件开头，所以标记放最后） */
export function skillFileContent(skillText: string, version: string): string {
  const body = skillText.endsWith("\n") ? skillText : `${skillText}\n`;
  return `${body}<!-- 由 hive 安装并管理：id=superhive version=${version}；重跑 hive skill install 更新、hive skill uninstall 移除；请勿手改，补充内容放在旁边的文件里 -->\n`;
}

export type InstallOutcome = "installed" | "updated" | "current" | "took-over";

export interface InstallResult {
  target: SkillTarget;
  path: string;
  outcome: InstallOutcome;
  /** 原文件不是 hive 管理时，覆盖前备份到哪里 */
  backup?: string;
  fromVersion?: string;
}

export function installSkill(
  targetId: string,
  options: { version: string; skillText: string; home?: string },
): InstallResult {
  const target = findSkillTarget(targetId);
  const home = options.home ?? homedir();
  const agentDir = path.join(home, target.dirName);
  if (!existsSync(agentDir)) {
    throw new Error(`${target.label} 的目录不存在（${agentDir}），请先安装 ${target.label}。`);
  }
  const skillPath = installedSkillPath(target, home);
  mkdirSync(path.dirname(skillPath), { recursive: true });
  const desired = skillFileContent(options.skillText, options.version);
  if (existsSync(skillPath)) {
    const existing = readFileSync(skillPath, "utf8");
    if (existing === desired) return { target, path: skillPath, outcome: "current" };
    const match = MARKER_RE.exec(existing);
    if (match) {
      const [, fromVersion = "unknown"] = match;
      writeFileSync(skillPath, desired);
      return { target, path: skillPath, outcome: "updated", fromVersion };
    }
    // 没有 hive 标记：可能是用户手工放的（比如 hive --skill 重定向），备份一份再接管
    const backup = `${skillPath}.bak`;
    copyFileSync(skillPath, backup);
    writeFileSync(skillPath, desired);
    return { target, path: skillPath, outcome: "took-over", backup };
  }
  writeFileSync(skillPath, desired);
  return { target, path: skillPath, outcome: "installed" };
}

export interface UninstallResult {
  target: SkillTarget;
  path: string;
  removed: boolean;
  /** 目录里还剩哪些文件（目录因此保留） */
  leftovers: string[];
  reason?: string;
}

export function uninstallSkill(targetId: string, options: { home?: string } = {}): UninstallResult {
  const target = findSkillTarget(targetId);
  const home = options.home ?? homedir();
  const skillPath = installedSkillPath(target, home);
  const skillDir = path.dirname(skillPath);
  if (!existsSync(skillPath)) {
    return { target, path: skillPath, removed: false, leftovers: [], reason: "没有安装过" };
  }
  const existing = readFileSync(skillPath, "utf8");
  if (!MARKER_RE.test(existing)) {
    return {
      target,
      path: skillPath,
      removed: false,
      leftovers: readdirSync(skillDir),
      reason: "这份 SKILL.md 不是 hive 安装的，未删除",
    };
  }
  rmSync(skillPath);
  const backup = `${skillPath}.bak`;
  if (existsSync(backup)) rmSync(backup);
  const leftovers = existsSync(skillDir) ? readdirSync(skillDir) : [];
  if (leftovers.length === 0) {
    try {
      rmdirSync(skillDir);
    } catch {
      /* 目录被别的进程占用时留着即可 */
    }
  }
  return { target, path: skillPath, removed: true, leftovers };
}

export type SkillState = "agent-missing" | "none" | "current" | "outdated" | "foreign";

export interface SkillStatus {
  target: SkillTarget;
  path: string;
  state: SkillState;
  installedVersion?: string;
}

export function skillStatusOf(
  target: SkillTarget,
  options: { version: string; home?: string },
): SkillStatus {
  const home = options.home ?? homedir();
  const skillPath = installedSkillPath(target, home);
  if (!existsSync(path.join(home, target.dirName)))
    return { target, path: skillPath, state: "agent-missing" };
  if (!existsSync(skillPath)) return { target, path: skillPath, state: "none" };
  const match = MARKER_RE.exec(readFileSync(skillPath, "utf8"));
  if (!match) return { target, path: skillPath, state: "foreign" };
  const [, installedVersion = "unknown"] = match;
  return {
    target,
    path: skillPath,
    state: installedVersion === options.version ? "current" : "outdated",
    installedVersion,
  };
}
