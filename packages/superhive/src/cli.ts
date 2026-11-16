#!/usr/bin/env node
// 必须最先加载：给 Node 24 自带 fetch 的 setTypeOfService 崩溃打补丁
import "./socket-tos-guard.js";
import { createRequire } from "module";
import updateNotifier from "update-notifier";
import { autostartCommand } from "./autostart.js";
import { mcpCommand } from "./mcp-command.js";
import { modelsCommand } from "./models-command.js";
import { run } from "./run.js";
import { restartService, startService, stopService } from "./service.js";
import { readSkill } from "./skill.js";
import { skillInstallCommand, skillStatusCommand, skillUninstallCommand } from "./skill-command.js";

const _require = createRequire(import.meta.url);
const pkg = _require("../package.json") as { name: string; version: string };
const { version } = pkg;

const usage = `
SuperHive（命令：hive；未全局安装时用 npx superhive 代替 hive）

用法：
  hive start [选项]   启动自己的 Hive Server 和 Web UI
  hive stop [选项]    停止由 hive start 启动的 Server
  hive restart [选项] 重启 Server，并沿用原有启动配置
  hive autostart on|off|status  登录这台电脑后自动启动 Server
  hive join [选项]    将本机 Agent 加入 Hive（默认加入所有未归档房间）
  hive mcp list [选项] 列出 Agent 会加载的本机 MCP 及其开局 token 估算
  hive models --provider NAME  列出这个 Agent CLI 能用的模型
  hive --skill        打印给 Agent 用的协作说明（SKILL.md，与当前版本对应）
  hive skill install [claude|codex|openclaw]
                      把上面的 SKILL.md 装进本机 Agent 的全局 skills 目录（缺省=全部已装的）
  hive skill status   查看各 Agent 的安装状态与版本
  hive skill uninstall [claude|codex|openclaw]
                      移除装进去的 SKILL.md（缺省=全部）

运行 hive <命令> --help 查看详细选项。
`;

// 后台子进程每天最多查一次 npm registry 并缓存，有新版本时在下一次运行打印提示（NO_UPDATE_NOTIFIER=1 可关闭）
updateNotifier({
  pkg,
  updateCheckInterval: 1000 * 60 * 60 * 24,
  shouldNotifyInNpmScript: true,
}).notify({
  isGlobal: true,
  message:
    "SuperHive 有新版本 {currentVersion} → {latestVersion}\n" +
    "在启动服务的电脑运行 npx --yes superhive@latest restart 更新",
  boxenOptions: {
    title: "有新版本的 SuperHive 可用",
    padding: 1,
    margin: 1,
    align: "center",
    borderColor: "yellowBright",
    borderStyle: "round",
  },
});

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage);
    return;
  }
  if (command === "-v" || command === "-V" || command === "--version" || command === "version") {
    console.log(version);
    return;
  }
  if (command === "--skill") {
    process.stdout.write(readSkill());
    return;
  }
  if (command === "skill") {
    const sub = process.argv[3];
    const args = process.argv.slice(4);
    if (sub === "install") return skillInstallCommand(args, { version, skillText: readSkill() });
    if (sub === "status") return skillStatusCommand({ version, skillText: readSkill() });
    if (sub === "uninstall") return skillUninstallCommand(args);
    if (!sub) {
      process.stdout.write(readSkill());
      return;
    }
    throw new Error(`未知的子命令：“skill ${sub}”。可用：install、status、uninstall。\n${usage}`);
  }
  if (command === "start") return startService();
  if (command === "stop") return stopService();
  if (command === "restart") return restartService();
  if (command === "autostart") return autostartCommand(process.argv.slice(3));
  if (command === "join") return run("codex");
  if (command === "mcp") return mcpCommand(process.argv.slice(3));
  if (command === "models") return modelsCommand(process.argv.slice(3));
  throw new Error(`未知命令：“${command}”。\n${usage}`);
}

main().catch((error: unknown) => {
  console.error(`[hive] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
