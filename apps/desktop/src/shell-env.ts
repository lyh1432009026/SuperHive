import { execFile } from "node:child_process";
import path from "node:path";

const START = "__SUPERHIVE_PATH_START__";
const END = "__SUPERHIVE_PATH_END__";

/** 从登录 shell 里要带回来的变量：PATH，以及代理（终端里能翻墙、客户端里的 Agent 却连不上，多半是这个） */
export const LOGIN_SHELL_KEYS = [
  "PATH",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

/**
 * 从访达、Dock 或桌面启动的程序拿不到用户在 shell 配置里设的 PATH（只有 /usr/bin:/bin 之类）和代理变量，
 * 本机 Agent 就找不到 claude、codex、node，或者连不上海外的模型服务。这里用登录 + 交互 shell 跑一次 env 读回来。
 * 用 env 而不是 echo "$PATH"：bash、zsh、fish 都能跑，打出来的都是导出给子进程的值。
 * Windows 上 GUI 程序本来就继承系统环境变量，不用处理。读不到就返回 undefined，不影响启动。
 */
export async function loginShellEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  timeoutMs = 5_000,
): Promise<Partial<Record<(typeof LOGIN_SHELL_KEYS)[number], string>> | undefined> {
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
      ["-ilc", `printf '%s\\n' '${START}'; env; printf '%s' '${END}'`],
      {
        timeout: timeoutMs,
        env: { ...env, DISABLE_AUTO_UPDATE: "true", ZSH_TMUX_AUTOSTARTED: "true" },
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (_error, stdout) => resolve(parseEnvDump(String(stdout ?? ""))),
    );
  });
}

/** 取标记之间 env 的输出里关心的那几个变量；没有标记（shell 出错）返回 undefined */
export function parseEnvDump(
  text: string,
): Partial<Record<(typeof LOGIN_SHELL_KEYS)[number], string>> | undefined {
  const start = text.lastIndexOf(START);
  const end = text.lastIndexOf(END);
  if (start === -1 || end <= start) return undefined;
  const wanted = new Set<string>(LOGIN_SHELL_KEYS);
  const result: Partial<Record<(typeof LOGIN_SHELL_KEYS)[number], string>> = {};
  for (const line of text.slice(start + START.length, end).split("\n")) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index);
    const value = line.slice(index + 1).trim();
    if (wanted.has(key) && value) result[key as (typeof LOGIN_SHELL_KEYS)[number]] = value;
  }
  return result;
}

/** 兼容旧调用：只要 PATH */
export async function loginShellPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  timeoutMs = 5_000,
): Promise<string | undefined> {
  return (await loginShellEnv(env, platform, timeoutMs))?.PATH;
}

/**
 * 登录 shell 里的代理变量补进当前环境：已经有任何一个代理变量（用户自己从终端启动、或系统给了）就不动，
 * 免得两边混着用。返回补上的变量名。
 */
export function mergeProxyEnv(
  target: NodeJS.ProcessEnv,
  fromShell: Partial<Record<string, string>> | undefined,
): string[] {
  if (!fromShell) return [];
  const proxyKeys = LOGIN_SHELL_KEYS.filter((key) => key !== "PATH");
  if (proxyKeys.some((key) => target[key])) return [];
  const added: string[] = [];
  for (const key of proxyKeys) {
    const value = fromShell[key];
    if (!value) continue;
    target[key] = value;
    added.push(key);
  }
  return added;
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
