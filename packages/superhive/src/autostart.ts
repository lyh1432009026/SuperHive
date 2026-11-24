import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { superhiveHome } from "./home-dir.js";
import { savedStartArgs } from "./service.js";

const usage = `
用法：
  hive autostart on [选项]              登录这台电脑后自动在后台启动 Hive Server
  hive autostart off                    关闭
  hive autostart status                 查看是否已开启

选项（on）：
  --host / --port / --public-url / --no-local-agents  同 hive start；都不写时沿用正在运行的
                     Server 上次的启动配置
  --data-dir PATH    数据目录（默认 ~/.superhive）

说明：
  不会打开浏览器。
  Server 起来后，网页上启动过、没手动停止的本机 Agent 会跟着逐个恢复。
  记下的是当前这份 superhive 的路径：建议先 npm i -g superhive 再开启，升级后重新运行一次 on。
`;

export type AutostartPlan = {
  /** 写入的文件 */
  file: string;
  content: string;
  /** 写入后要执行的命令（Linux 要 enable 一下才会在登录时启动） */
  afterWrite: string[][];
  /** 删除前要执行的命令 */
  beforeRemove: string[][];
  /** 文件编码，默认 utf8 */
  encoding?: "utf8" | "utf16le";
  /** 旧版本写过的自启动文件：开启时换掉、关闭时一起删 */
  legacyFiles?: string[];
};

/** 写自启动文件：utf16le 带 BOM（Windows Script Host 靠它识别编码） */
export function autostartFileContent(plan: AutostartPlan): string | Buffer {
  return plan.encoding === "utf16le"
    ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(plan.content, "utf16le")])
    : plan.content;
}

export type AutostartInput = {
  platform: NodeJS.Platform;
  home: string;
  /** Windows 的 %APPDATA% */
  appData?: string | undefined;
  node: string;
  cli: string;
  startArgs: string[];
  /** 写进服务环境的 PATH：开机时的环境里通常找不到 claude、codex 这些 CLI */
  pathEnv: string;
  logFile: string;
};

const LAUNCHD_LABEL = "dev.superhive.server";

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** systemd 的 ExecStart 参数：带空白或引号的加双引号 */
function systemdQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

/** 生成各平台的自启动文件；只生成，不碰系统 */
export function autostartPlan(input: AutostartInput): AutostartPlan {
  // macOS / Linux 由系统服务管着进程，用前台模式；Windows 的启动文件夹只负责拉起，用后台模式
  const foregroundArgs = [
    input.node,
    input.cli,
    "start",
    "--foreground",
    "--no-open",
    ...input.startArgs,
  ];
  if (input.platform === "darwin") {
    const args = foregroundArgs.map((arg) => `    <string>${xml(arg)}</string>`).join("\n");
    return {
      file: path.join(input.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${xml(input.home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(input.pathEnv)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(input.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(input.logFile)}</string>
</dict>
</plist>
`,
      // 下次登录时 launchd 自动加载 ~/Library/LaunchAgents，不在这里立即启动
      afterWrite: [],
      beforeRemove: [],
    };
  }
  if (input.platform === "win32") {
    const startup = path.join(
      input.appData ?? path.join(input.home, "AppData", "Roaming"),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
    );
    const command = [input.node, input.cli, "start", "--no-open", ...input.startArgs]
      .map((arg) => `"${arg.replace(/"/g, '""')}"`)
      .join(" ");
    // cmd /s /c "…"：去掉最外层一对引号后原样执行，里面的路径引号保持不变
    const cmdLine = `cmd.exe /d /s /c "${command} >> "${input.logFile}" 2>&1"`;
    return {
      // 用 VBScript 以隐藏窗口（Run 的第二个参数 0）拉起：.cmd 放在启动文件夹里，登录时会闪出一个命令行窗口
      file: path.join(startup, "SuperHive.vbs"),
      content: `' SuperHive: start Hive Server at login (remove with: hive autostart off)\r\nSet shell = CreateObject("WScript.Shell")\r\nshell.CurrentDirectory = shell.ExpandEnvironmentStrings("%USERPROFILE%")\r\nshell.Run "${cmdLine.replace(/"/g, '""')}", 0, False\r\n`,
      // WSH 只认 ANSI 和带 BOM 的 UTF-16：路径里有中文时 ANSI 会乱码
      encoding: "utf16le",
      legacyFiles: [path.join(startup, "SuperHive.cmd")],
      afterWrite: [],
      beforeRemove: [],
    };
  }
  const unit = path.join(input.home, ".config", "systemd", "user", "superhive.service");
  return {
    file: unit,
    content: `[Unit]
Description=SuperHive server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h
ExecStart=${foregroundArgs.map(systemdQuote).join(" ")}
Environment=${systemdQuote(`PATH=${input.pathEnv}`)}
StandardOutput=append:${input.logFile}
StandardError=append:${input.logFile}

[Install]
WantedBy=default.target
`,
    afterWrite: [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "superhive.service"],
    ],
    beforeRemove: [["systemctl", "--user", "disable", "superhive.service"]],
  };
}

/** 当前运行的 CLI 脚本路径；从仓库用 tsx 跑源码时没法给开机自启用 */
function currentCli(): string {
  const self = fileURLToPath(import.meta.url);
  return realpathSync(path.join(path.dirname(self), self.endsWith(".ts") ? "cli.ts" : "cli.js"));
}

function run(commands: string[][]): void {
  for (const [command, ...args] of commands) {
    const result = spawnSync(command!, args, { stdio: "inherit", windowsHide: true });
    if (result.status !== 0) {
      throw new Error(`${[command, ...args].join(" ")} 执行失败。`);
    }
  }
}

export async function autostartCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      "public-url": { type: "string" },
      "no-local-agents": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const action = parsed.positionals[0];
  if (parsed.values.help || !action || !["on", "off", "status"].includes(action)) {
    console.log(usage);
    if (!parsed.values.help && action) process.exitCode = 1;
    return;
  }
  const dataDir = parsed.values["data-dir"];
  const explicit = [
    ...(parsed.values.host ? ["--host", parsed.values.host] : []),
    ...(parsed.values.port ? ["--port", parsed.values.port] : []),
    ...(parsed.values["public-url"] ? ["--public-url", parsed.values["public-url"]] : []),
    ...(parsed.values["no-local-agents"] ? ["--no-local-agents"] : []),
  ];
  const startArgs = explicit.length
    ? [...explicit, ...(dataDir ? ["--data-dir", path.resolve(dataDir)] : [])]
    : savedStartArgs(dataDir);
  const cli = currentCli();
  const plan = autostartPlan({
    platform: process.platform,
    home: homedir(),
    appData: process.env.APPDATA,
    node: process.execPath,
    cli,
    startArgs,
    pathEnv: process.env.PATH ?? "/usr/bin:/bin",
    logFile: path.join(dataDir ? path.resolve(dataDir) : superhiveHome(), "autostart.log"),
  });
  const installed = [plan.file, ...(plan.legacyFiles ?? [])].filter((file) => existsSync(file));
  if (action === "status") {
    console.log(
      installed.length
        ? `[hive] 开机自启已开启：${installed.join("、")}`
        : "[hive] 开机自启未开启（hive autostart on 开启）。",
    );
    return;
  }
  if (action === "off") {
    if (!installed.length) {
      console.log("[hive] 开机自启本来就没有开启。");
      return;
    }
    if (existsSync(plan.file)) run(plan.beforeRemove);
    for (const file of installed) rmSync(file, { force: true });
    console.log(`[hive] 已关闭开机自启，删除了 ${installed.join("、")}`);
    return;
  }
  if (cli.endsWith(".ts")) {
    throw new Error(
      "从仓库源码运行时不支持开机自启，请用发布的 superhive 包（npm i -g superhive）。",
    );
  }
  mkdirSync(path.dirname(plan.file), { recursive: true });
  writeFileSync(plan.file, autostartFileContent(plan), { mode: 0o644 });
  for (const file of plan.legacyFiles ?? []) rmSync(file, { force: true });
  run(plan.afterWrite);
  console.log(`[hive] 已开启开机自启：${plan.file}`);
  console.log(`[hive] 登录后会运行：${[process.execPath, cli, "start", ...startArgs].join(" ")}`);
  if (cli.split(path.sep).includes("_npx")) {
    console.log(
      "[hive] 注意：当前是 npx 临时缓存里的 superhive，清理 npm 缓存后自启会失效；建议 npm i -g superhive 后重新运行 hive autostart on。",
    );
  }
}
