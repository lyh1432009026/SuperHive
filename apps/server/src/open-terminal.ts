import { spawn } from "node:child_process";

/** AppleScript 字符串字面量 */
function appleString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
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
    // start 不等新窗口结束；第一个带引号的参数是窗口标题
    await run("cmd.exe", ["/c", "start", '"SuperHive"', "cmd.exe", "/k", command]);
    return;
  }
  await run("x-terminal-emulator", ["-e", "sh", "-c", `${command}; exec "\${SHELL:-sh}"`]).catch(
    () => {
      throw new Error("没找到可用的终端程序，请复制命令到终端里运行。");
    },
  );
}
