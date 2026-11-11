import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSkill,
  installedSkillPath,
  SKILL_TARGETS,
  skillFileContent,
  skillStatusOf,
  uninstallSkill,
} from "./skill-install.js";
import { skillInstallCommand, skillStatusCommand, skillUninstallCommand } from "./skill-command.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const SKILL_TEXT =
  '---\nname: superhive\ndescription: "测试用"\n---\n\n# SuperHive\n\n说明正文。\n';

function tempHome(): string {
  return mkdtempSync(path.join(tmpdir(), "hive-skill-test-"));
}

function agentHome(home: string, id: string): string {
  const dir = path.join(home, SKILL_TARGETS.find((target) => target.id === id)!.dirName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("skill install", () => {
  let home: string;

  beforeEach(() => {
    home = tempHome();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("installs the bundled SKILL.md with a managed marker at the end", () => {
    agentHome(home, "claude");
    const result = installSkill("claude", { version: "1.2.3", skillText: SKILL_TEXT, home });
    expect(result.outcome).toBe("installed");
    const skillPath = installedSkillPath(
      SKILL_TARGETS.find((target) => target.id === "claude")!,
      home,
    );
    expect(result.path).toBe(skillPath);
    const content = readFileSync(skillPath, "utf8");
    // frontmatter 必须还在文件开头，标记只能追加在末尾
    expect(content.startsWith("---\nname: superhive\n")).toBe(true);
    expect(content).toContain("说明正文。");
    expect(content).toContain("id=superhive version=1.2.3");
    expect(content.endsWith("-->\n")).toBe(true);
  });

  it("is a no-op when the same version is already installed", () => {
    agentHome(home, "codex");
    const options = { version: "1.2.3", skillText: SKILL_TEXT, home };
    installSkill("codex", options);
    expect(installSkill("codex", options).outcome).toBe("current");
  });

  it("updates a managed file and reports the previous version", () => {
    agentHome(home, "codex");
    installSkill("codex", { version: "1.2.3", skillText: SKILL_TEXT, home });
    const result = installSkill("codex", { version: "1.3.0", skillText: SKILL_TEXT, home });
    expect(result.outcome).toBe("updated");
    expect(result.fromVersion).toBe("1.2.3");
    expect(readFileSync(result.path, "utf8")).toContain("version=1.3.0");
  });

  it("backs up a foreign SKILL.md before taking it over", () => {
    agentHome(home, "claude");
    const skillPath = path.join(home, ".claude", "skills", "superhive", "SKILL.md");
    mkdirSync(path.dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, "用户手写的说明\n");
    const result = installSkill("claude", { version: "1.2.3", skillText: SKILL_TEXT, home });
    expect(result.outcome).toBe("took-over");
    expect(readFileSync(`${skillPath}.bak`, "utf8")).toBe("用户手写的说明\n");
    expect(readFileSync(skillPath, "utf8")).toContain("id=superhive version=1.2.3");
  });

  it("refuses to install when the agent itself is missing", () => {
    expect(() =>
      installSkill("openclaw", { version: "1.2.3", skillText: SKILL_TEXT, home }),
    ).toThrow(/OpenClaw 的目录不存在.*请先安装 OpenClaw/);
  });

  it("rejects unknown agent names and lists the supported ones", () => {
    expect(() =>
      installSkill("copilot", { version: "1.2.3", skillText: SKILL_TEXT, home }),
    ).toThrow(/未知的 Agent：“copilot”。支持：claude、codex、openclaw/);
  });

  it("uninstall removes the managed file, its backup and the now-empty directory", () => {
    agentHome(home, "claude");
    const options = { version: "1.2.3", skillText: SKILL_TEXT, home };
    const skillPath = installSkill("claude", options).path;
    writeFileSync(`${skillPath}.bak`, "旧备份\n");
    const result = uninstallSkill("claude", { home });
    expect(result.removed).toBe(true);
    expect(existsSync(skillPath)).toBe(false);
    expect(existsSync(`${skillPath}.bak`)).toBe(false);
    expect(existsSync(path.dirname(skillPath))).toBe(false);
  });

  it("uninstall keeps the directory and reports leftovers when the user added files", () => {
    agentHome(home, "claude");
    const skillPath = installSkill("claude", {
      version: "1.2.3",
      skillText: SKILL_TEXT,
      home,
    }).path;
    writeFileSync(path.join(path.dirname(skillPath), "references.md"), "补充\n");
    const result = uninstallSkill("claude", { home });
    expect(result.removed).toBe(true);
    expect(result.leftovers).toEqual(["references.md"]);
    expect(existsSync(path.dirname(skillPath))).toBe(true);
  });

  it("uninstall refuses to delete a SKILL.md it did not install", () => {
    agentHome(home, "claude");
    const skillPath = path.join(home, ".claude", "skills", "superhive", "SKILL.md");
    mkdirSync(path.dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, "用户手写的说明\n");
    const result = uninstallSkill("claude", { home });
    expect(result.removed).toBe(false);
    expect(result.reason).toContain("不是 hive 安装的");
    expect(existsSync(skillPath)).toBe(true);
  });

  it("reports none / current / outdated / foreign / agent-missing states", () => {
    const claude = SKILL_TARGETS.find((target) => target.id === "claude")!;
    const codex = SKILL_TARGETS.find((target) => target.id === "codex")!;
    const openclaw = SKILL_TARGETS.find((target) => target.id === "openclaw")!;
    // openclaw 没装
    expect(skillStatusOf(openclaw, { version: "1.2.3", home }).state).toBe("agent-missing");
    // claude 装了旧版
    agentHome(home, "claude");
    installSkill("claude", { version: "1.0.0", skillText: SKILL_TEXT, home });
    const claudeStatus = skillStatusOf(claude, { version: "1.2.3", home });
    expect(claudeStatus.state).toBe("outdated");
    expect(claudeStatus.installedVersion).toBe("1.0.0");
    // codex 装的是当前版
    agentHome(home, "codex");
    installSkill("codex", { version: "1.2.3", skillText: SKILL_TEXT, home });
    expect(skillStatusOf(codex, { version: "1.2.3", home }).state).toBe("current");
    // codex 的文件被换成用户手写的
    writeFileSync(installedSkillPath(codex, home), "手写\n");
    expect(skillStatusOf(codex, { version: "1.2.3", home }).state).toBe("foreign");
    // claude 删掉文件后回到未安装
    rmSync(installedSkillPath(claude, home));
    expect(skillStatusOf(claude, { version: "1.2.3", home }).state).toBe("none");
  });

  it("normalizes the trailing newline before appending the marker", () => {
    const content = skillFileContent("正文", "1.2.3");
    expect(content).toBe(
      "正文\n<!-- 由 hive 安装并管理：id=superhive version=1.2.3；重跑 hive skill install 更新、hive skill uninstall 移除；请勿手改，补充内容放在旁边的文件里 -->\n",
    );
  });
});

describe("skill commands", () => {
  let home: string;
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.join(" "));
  });

  beforeEach(() => {
    home = tempHome();
    logs.length = 0;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("install without a target covers every detected agent", () => {
    agentHome(home, "claude");
    agentHome(home, "codex");
    skillInstallCommand([], { version: "1.2.3", skillText: SKILL_TEXT, home });
    expect(logs.join("\n")).toContain("已装进 Claude Code");
    expect(logs.join("\n")).toContain("已装进 Codex CLI");
    expect(logs.join("\n")).not.toContain("OpenClaw");
    expect(existsSync(path.join(home, ".claude", "skills", "superhive", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(home, ".codex", "skills", "superhive", "SKILL.md"))).toBe(true);
  });

  it("install fails with a hint when no supported agent is detected", () => {
    expect(() =>
      skillInstallCommand([], { version: "1.2.3", skillText: SKILL_TEXT, home }),
    ).toThrow(/没有检测到已安装的 Agent.*hive skill install <名字>/s);
  });

  it("status describes every agent in one line each", () => {
    agentHome(home, "claude");
    skillStatusCommand({ version: "1.2.3", skillText: SKILL_TEXT, home });
    const text = logs.join("\n");
    expect(text).toContain("Claude Code（claude）：未安装 skill");
    expect(text).toContain("Codex CLI（codex）：未安装该 Agent，跳过");
  });

  it("uninstall only touches managed files and stays quiet when there is nothing to remove", () => {
    agentHome(home, "claude");
    skillInstallCommand(["claude"], { version: "1.2.3", skillText: SKILL_TEXT, home });
    logs.length = 0;
    skillUninstallCommand([], home);
    expect(logs.join("\n")).toContain("Claude Code：已移除");
    logs.length = 0;
    skillUninstallCommand([], home);
    expect(logs.join("\n")).toContain("没有需要移除的");
  });

  it("install rejects extra arguments", () => {
    agentHome(home, "claude");
    expect(() =>
      skillInstallCommand(["claude", "--force"], { version: "1.2.3", skillText: SKILL_TEXT, home }),
    ).toThrow(/多余的参数：“--force”/);
  });
});

// CLI 级别：真实跑一遍 tsx cli.ts，HOME 指到临时目录，验证子命令接线和输出
describe("skill CLI", { timeout: 60_000 }, () => {
  async function runCli(args: string[], home: string): Promise<string> {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", cliPath, ...args],
      {
        env: { ...process.env, HOME: home, NO_UPDATE_NOTIFIER: "1" },
      },
    );
    return stdout;
  }

  it("status lists all three agents on an empty machine", async () => {
    const home = tempHome();
    try {
      const output = await runCli(["skill", "status"], home);
      expect(output).toContain("Claude Code（claude）：未安装该 Agent，跳过");
      expect(output).toContain("Codex CLI（codex）：未安装该 Agent，跳过");
      expect(output).toContain("OpenClaw（openclaw）：未安装该 Agent，跳过");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("install writes the skill into every detected agent directory", async () => {
    const home = tempHome();
    try {
      mkdirSync(path.join(home, ".claude"), { recursive: true });
      mkdirSync(path.join(home, ".openclaw"), { recursive: true });
      const output = await runCli(["skill", "install"], home);
      const skillPath = path.join(home, ".claude", "skills", "superhive", "SKILL.md");
      expect(output).toContain("已装进 Claude Code");
      expect(output).toContain("已装进 OpenClaw");
      expect(output).not.toContain("Codex CLI");
      // 安装的就是随包发布的 SKILL.md（含接入说明），再补一个托管标记
      const content = readFileSync(skillPath, "utf8");
      expect(content.startsWith("---\nname: superhive\n")).toBe(true);
      expect(content).toContain("hive join");
      expect(content).toContain("id=superhive version=");
      // 再装一次是幂等的
      expect(await runCli(["skill", "install"], home)).toContain("已是最新");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
