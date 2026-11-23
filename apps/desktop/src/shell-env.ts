import { execFile } from "node:child_process";
import path from "node:path";

const START = "__SUPERHIVE_PATH_START__";
const END = "__SUPERHIVE_PATH_END__";

/**
 * 从访达、Dock 或桌面启动的程序拿不到用户在 shell 配置里设的 PATH（只有 /usr/bin:/bin 之类），
 * 本机 Agent 就找不到 claude、codex、node。这里用登录 + 交互 shell 读一次 PATH 合并进来。
 * Windows 上 GUI 程序本来就继承系统 PATH，不用处理。读不到就保持原样，不影响启动。
 */
export async function loginShellPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  timeoutMs = 5_000,
): Promise<string | undefined> {
  if (platform === "win32") return undefined;
  const shell =
    env.SHELL && path.isAbsolute(env.SHELL)
      ? env.SHELL
      : platform === "darwin"
        ? "/bin/zsh"
        : "/bin/sh";
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-ilc", `printf '%s%s%s' '${START}' "$PATH" '${END}'`],
      {
        timeout: timeoutMs,
        env: { ...env, DISABLE_AUTO_UPDATE: "true", ZSH_TMUX_AUTOSTARTED: "true" },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        const text = String(stdout ?? "");
        const start = text.lastIndexOf(START);
        const end = text.lastIndexOf(END);
        if (start === -1 || end <= start) {
          resolve(undefined);
          return;
        }
        const value = text.slice(start + START.length, end).trim();
        resolve(value || undefined);
      },
    );
  });
}

/** 合并 PATH：shell 里的在前，原有的补在后面，去重 */
export function mergePath(
  primary: string | undefined,
  existing: string | undefined,
  delimiter = path.delimiter,
): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const value of [primary, existing]) {
    for (const part of (value ?? "").split(delimiter)) {
      if (!part || seen.has(part)) continue;
      seen.add(part);
      parts.push(part);
    }
  }
  return parts.join(delimiter);
}
