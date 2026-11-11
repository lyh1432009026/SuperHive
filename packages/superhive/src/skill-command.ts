import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  findSkillTarget,
  installSkill,
  SKILL_TARGETS,
  skillStatusOf,
  uninstallSkill,
  type SkillTarget,
} from "./skill-install.js";

export interface SkillCommandOptions {
  version: string;
  skillText: string;
  /** 测试注入用；缺省用真实 home */
  home?: string;
}

function targetsFor(arg: string | undefined, home: string): SkillTarget[] {
  if (arg) return [findSkillTarget(arg)];
  return SKILL_TARGETS.filter((target) => existsSync(path.join(home, target.dirName)));
}

/** 没有任何已装 Agent 时 install 无从下手，报错并教用户显式指定 */
function requireDetected(targets: SkillTarget[]): SkillTarget[] {
  if (targets.length === 0) {
    throw new Error(
      `没有检测到已安装的 Agent（支持：${SKILL_TARGETS.map((target) => target.id).join("、")}）。` +
        `确认装好后重试，或显式指定：hive skill install <名字>。`,
    );
  }
  return targets;
}

export function skillInstallCommand(args: string[], options: SkillCommandOptions): void {
  const home = options.home ?? homedir();
  const [targetArg, ...extra] = args;
  if (extra.length > 0) {
    throw new Error(
      `多余的参数：“${extra[0]}”。用法：hive skill install [claude|codex|openclaw]。`,
    );
  }
  for (const target of requireDetected(targetsFor(targetArg, home))) {
    const result = installSkill(target.id, {
      version: options.version,
      skillText: options.skillText,
      home,
    });
    if (result.outcome === "current") {
      console.log(`${result.target.label} 已是最新（v${options.version}），未改动：${result.path}`);
    } else if (result.outcome === "updated") {
      console.log(
        `${result.target.label} 已从 v${result.fromVersion} 更新到 v${options.version}：${result.path}`,
      );
    } else if (result.outcome === "took-over") {
      console.log(
        `${result.target.label} 原有的 SKILL.md 不是 hive 安装的，已备份到 ${result.backup} 后替换：${result.path}`,
      );
    } else {
      console.log(`已装进 ${result.target.label}（v${options.version}）：${result.path}`);
    }
  }
  console.log("Agent 下一个新会话生效；查看状态：hive skill status");
}

export function skillStatusCommand(options: SkillCommandOptions): void {
  const home = options.home ?? homedir();
  for (const target of SKILL_TARGETS) {
    const status = skillStatusOf(target, { version: options.version, home });
    const head = `${target.label}（${target.id}）`;
    if (status.state === "agent-missing") {
      console.log(`${head}：未安装该 Agent，跳过`);
    } else if (status.state === "none") {
      console.log(`${head}：未安装 skill → ${status.path}`);
    } else if (status.state === "current") {
      console.log(`${head}：v${status.installedVersion}（最新）→ ${status.path}`);
    } else if (status.state === "outdated") {
      console.log(
        `${head}：v${status.installedVersion}，可更新到 v${options.version} → ${status.path}`,
      );
    } else {
      console.log(
        `${head}：已有 SKILL.md 但不是 hive 装的（install 会先备份再接管）→ ${status.path}`,
      );
    }
  }
}

export function skillUninstallCommand(args: string[], home = homedir()): void {
  const [targetArg, ...extra] = args;
  if (extra.length > 0) {
    throw new Error(
      `多余的参数：“${extra[0]}”。用法：hive skill uninstall [claude|codex|openclaw]。`,
    );
  }
  const targets = targetArg ? [findSkillTarget(targetArg)] : targetsFor(undefined, home);
  let removedAny = false;
  for (const target of targets) {
    const result = uninstallSkill(target.id, { home });
    if (result.removed) {
      removedAny = true;
      const tail =
        result.leftovers.length > 0
          ? `（目录里还有 ${result.leftovers.join("、")}，保留未动）`
          : "";
      console.log(`${result.target.label}：已移除 ${result.path}${tail}`);
    } else if (result.reason) {
      console.log(`${result.target.label}：${result.reason}`);
    }
  }
  if (!removedAny) console.log("没有需要移除的（只移除由 hive skill install 安装的文件）。");
}
