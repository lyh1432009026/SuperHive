import { spawn } from "node:child_process";
import path from "node:path";

/** AppleScript 字符串字面量 */
function appleString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function run(
  command: string,
  args: string[],
  options: { windowsVerbatimArguments?: boolean } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true, ...options });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 || code === null ? resolve() : reject(new Error(`${command} 退出码 ${code}`)),
    );
    child.unref();
  });
}

/**
 * 在 Server 所在电脑上开一个终端窗口执行命令（只给本机房主用）：
 * macOS 用 Terminal.app，Windows 开一个新的 cmd 窗口，Linux 用 x-terminal-emulator。
 */
export async function openTerminal(command: string, platform = process.platform): Promise<void> {
  if (platform === "darwin") {
    await run("osascript", [
      "-e",
      `tell application "Terminal" to do script ${appleString(command)}`,
      "-e",
      'tell application "Terminal" to activate',
    ]);
    return;
  }
  if (platform === "win32") {
    // start 不等新窗口结束；第一个带引号的参数是窗口标题。
    // 原样交给 cmd：Node 默认按 MSVCRT 规则给参数加 \" 转义，cmd 不认，引号会被拆坏
    await run("cmd.exe", ["/d", "/s", "/c", `start "SuperHive" cmd.exe /k ${command}`], {
      windowsVerbatimArguments: true,
    });
    return;
  }
  await run("x-terminal-emulator", ["-e", "sh", "-c", `${command}; exec "\${SHELL:-sh}"`]).catch(
    () => {
      throw new Error("没找到可用的终端程序，请复制命令到终端里运行。");
    },
  );
}

/**
 * 在 Server 所在电脑的文件管理器里选中这个文件（只给本机房主用）：
 * macOS 用访达（open -R），Windows 用资源管理器 /select，Linux 打开所在目录。
 * 只是显示，不打开、不执行文件本身。
 */
export async function revealInFolder(file: string, platform = process.platform): Promise<void> {
  if (platform === "darwin") {
    // 绝对路径以 / 开头，不会被当成选项
    await run("open", ["-R", file]);
    return;
  }
  if (platform === "win32") {
    // explorer 正常也会返回 1，不按退出码判断
    await run("explorer.exe", [`/select,${file}`]).catch(() => undefined);
    return;
  }
  await run("xdg-open", [path.dirname(file)]);
}
