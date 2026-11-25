/**
 * Mac 应用内更新（不签名也能用）：
 *
 * 1. 下载 Release 里的 `SuperHive-darwin-arm64-<版本>.zip`，边下边算 sha256，和 GitHub 给的 digest、大小都对上才继续；
 * 2. 用 ditto 解到临时目录（和访达「解压」一样保留符号链接和扩展属性），确认里面只有一个 .app，
 *    Bundle ID 是 dev.superhive.desktop、版本号就是要更新的版本；
 * 3. 去掉 com.apple.quarantine（我们自己用 Node 写的文件本来就不带，这里是防 zip 里自带），并复查一遍；
 *    再用 codesign 核对签名完整（ad-hoc 签名也要完整，否则换上去以后系统拒绝打开）；
 * 4. 暂存到当前 .app 旁边的隐藏目录（同一个卷，后面的替换只是两次 rename）；
 * 5. 应用退出时起一个独立的 /bin/sh：等主进程退出，把旧 .app 挪开、新 .app 挪进来，失败就挪回去；
 *    点了「重启以更新」时再 `open` 新版本。
 *
 * 当前位置不能写（App Translocation、dmg 等只读卷、没权限）时不下载，网页退回「打开下载页」并写明原因。
 * 新旧版本都是 ad-hoc 签名：不带 quarantine、签名完整时 Gatekeeper 不会拦，替换后能直接打开。
 * 0.4.7 及以前的包签名不完整（fuses 只重签了主程序），从 0.4.8 起打包后整个 .app 重新 ad-hoc 签名（forge.config.cjs 的 postPackage）。
 */
import { execFile as execFileCb, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { InstallPackage } from "./update-check.js";
import { InstallError, type InstallBackend, type InstallFailure } from "./update-install.js";

export const BUNDLE_ID = "dev.superhive.desktop";
const STAGED_PREFIX = ".SuperHive-update-";
/** 替换脚本最多等主进程退出多久（秒）；等不到就什么都不动 */
const SWAP_WAIT_SECONDS = 120;

const execFile = promisify(execFileCb);

/** 从可执行文件往上找到 .app（`/Applications/SuperHive.app/Contents/MacOS/SuperHive` → `/Applications/SuperHive.app`） */
export function appBundlePath(exePath: string): string | undefined {
  let dir = path.dirname(exePath);
  while (dir !== path.dirname(dir)) {
    if (dir.endsWith(".app")) return dir;
    dir = path.dirname(dir);
  }
  return undefined;
}

/** 这个位置能不能原地替换；能返回 undefined */
export function locationProblem(
  appPath: string | undefined,
  access: (dir: string) => void = (dir) => accessSync(dir, constants.W_OK),
): InstallFailure | undefined {
  if (!appPath) return "not-installed";
  // 从「下载」等隔离位置直接打开时，系统把 .app 挂到只读的随机路径下运行
  if (appPath.includes("/AppTranslocation/")) return "translocated";
  try {
    access(path.dirname(appPath));
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EROFS") return "read-only";
    return "not-writable";
  }
}

export type DownloadFetch = (
  url: string,
  init: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}>;

/** 下载到 dest，边下边算 sha256；大小或 sha256 不对抛 checksum，网络问题抛 network */
export async function downloadVerified(
  fetchImpl: DownloadFetch,
  url: string,
  dest: string,
  expected: { size: number; sha256: string },
  progress: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  let response: Awaited<ReturnType<DownloadFetch>>;
  try {
    response = await fetchImpl(url, signal ? { signal } : {});
  } catch (error) {
    throw new InstallError("network", String(error));
  }
  if (!response.ok || !response.body) throw new InstallError("network", `HTTP ${response.status}`);
  const hash = createHash("sha256");
  const out = createWriteStream(dest);
  // 写文件出错（磁盘满、目录被删）不能变成未处理的 error 事件把主进程弄崩：记下来，循环里检查
  let writeError: Error | undefined;
  out.on("error", (error) => {
    writeError = error;
  });
  let received = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      if (writeError) throw new InstallError("unknown", String(writeError));
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      // 比 Release 上写的还大，不用再下了
      if (received > expected.size) throw new InstallError("checksum", "larger than expected");
      hash.update(value);
      if (!out.write(value)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            out.off("drain", done);
            out.off("close", done);
            resolve();
          };
          out.on("drain", done);
          out.on("close", done);
        });
      }
      progress(received, expected.size);
    }
    await new Promise<void>((resolve, reject) => {
      if (writeError) return reject(writeError);
      out.once("error", reject);
      out.end(() => resolve());
    });
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    out.destroy();
    if (error instanceof InstallError) throw error;
    throw new InstallError(writeError ? "unknown" : "network", String(error));
  }
  if (received !== expected.size || hash.digest("hex") !== expected.sha256) {
    throw new InstallError("checksum", "sha256 mismatch");
  }
}

export type Exec = (file: string, args: string[]) => Promise<{ stdout: string }>;

export const defaultExec: Exec = (file, args) =>
  execFile(file, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });

async function plistValue(exec: Exec, plist: string, key: string): Promise<string> {
  const { stdout } = await exec("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist]);
  return stdout.trim();
}

/** 解压 zip 到 dir，找到唯一的 .app，核对 Bundle ID 和版本号，去掉 quarantine；返回 .app 路径 */
export async function extractAndVerify(
  exec: Exec,
  zip: string,
  dir: string,
  version: string,
): Promise<string> {
  try {
    await exec("/usr/bin/ditto", ["-x", "-k", zip, dir]);
  } catch (error) {
    throw new InstallError("bad-package", `unzip failed: ${String(error)}`);
  }
  const entries = readdirSync(dir).filter((name) => !name.startsWith("__MACOSX"));
  if (entries.length !== 1 || !entries[0]!.endsWith(".app")) {
    throw new InstallError("bad-package", `unexpected zip content: ${entries.join(", ")}`);
  }
  const app = path.join(dir, entries[0]!);
  const plist = path.join(app, "Contents/Info.plist");
  let bundleId: string;
  let shortVersion: string;
  let executable: string;
  try {
    bundleId = await plistValue(exec, plist, "CFBundleIdentifier");
    shortVersion = await plistValue(exec, plist, "CFBundleShortVersionString");
    executable = await plistValue(exec, plist, "CFBundleExecutable");
  } catch (error) {
    throw new InstallError("bad-package", `bad Info.plist: ${String(error)}`);
  }
  if (bundleId !== BUNDLE_ID || shortVersion !== version) {
    throw new InstallError("bad-package", `got ${bundleId} ${shortVersion}`);
  }
  const binary = path.join(app, "Contents/MacOS", executable);
  if (!/^[^/]+$/.test(executable) || !existsSync(binary) || !statSync(binary).isFile()) {
    throw new InstallError("bad-package", "missing executable");
  }
  // 自己下载的文件不会被打上 quarantine；防 zip 里自带，清一遍再复查
  await exec("/usr/bin/xattr", ["-r", "-d", "com.apple.quarantine", app]).catch(() => undefined);
  const { stdout } = await exec("/usr/bin/find", [
    app,
    "-xattrname",
    "com.apple.quarantine",
    "-print",
    "-quit",
  ]);
  if (stdout.trim()) throw new InstallError("bad-package", "quarantine attribute left");
  // 签名（ad-hoc 也算）必须完整：签名坏了的新 .app 换上去以后系统不让打开（LaunchServices 报 -54），
  // 那就不如不换，退回手动下载
  try {
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  } catch (error) {
    throw new InstallError("bad-package", `code signature invalid: ${String(error)}`);
  }
  return app;
}

/** 暂存位置：当前 .app 旁边的隐藏目录（不以 .app 结尾，访达和启动台不会把它当应用） */
export function stagedPathFor(appPath: string, version: string): string {
  return path.join(path.dirname(appPath), `${STAGED_PREFIX}${version}`);
}

/**
 * 替换脚本。参数按位置传进去（不拼进脚本文本）：$1 主进程 PID，$2 当前 .app，$3 暂存的新 .app，$4 是否重新打开（1/0）。
 * 先等主进程退出；把旧的挪到旁边，新的挪进来，挪不进来就把旧的挪回去；最后删旧的、按需打开。
 */
export const SWAP_SCRIPT = `
pid="$1"; app="$2"; staged="$3"; relaunch="$4"
[ -n "$pid" ] && [ -n "$app" ] && [ -n "$staged" ] || exit 2
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt ${SWAP_WAIT_SECONDS * 10} ]; then echo "superhive-update: app did not exit"; exit 3; fi
  sleep 0.1
done
[ -d "$staged" ] || { echo "superhive-update: staged app missing"; exit 4; }
old="$app.superhive-old-$$"
if ! mv "$app" "$old"; then echo "superhive-update: cannot move old app"; exit 5; fi
if ! mv "$staged" "$app"; then
  mv "$old" "$app"
  echo "superhive-update: cannot move new app, restored"
  exit 6
fi
rm -rf "$old"
echo "superhive-update: replaced"
if [ "$relaunch" = "1" ]; then /usr/bin/open "$app"; fi
exit 0
`;

export type MacUpdaterOptions = {
  exePath: string;
  pid: number;
  /** 下载和解压用的临时目录（Electron 用户目录下） */
  workDir: string;
  /** 替换脚本的输出写到这里，出问题时好查 */
  logFile: string;
  fetch: DownloadFetch;
  exec?: Exec;
  quit: () => void;
  /** 起替换脚本（测试里换掉） */
  spawnSwap?: (args: string[], logFile: string) => void;
};

function spawnDetached(args: string[], logFile: string): void {
  let fd: number | "ignore" = "ignore";
  try {
    fd = openLog(logFile);
  } catch {
    /* 日志打不开也照样替换 */
  }
  const child = spawn("/bin/sh", ["-c", SWAP_SCRIPT, "superhive-update", ...args], {
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
}

function openLog(file: string): number {
  mkdirSync(path.dirname(file), { recursive: true });
  return openSync(file, "a");
}

function fsFailure(error: unknown): InstallFailure {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EROFS") return "read-only";
  if (code === "EACCES" || code === "EPERM") return "not-writable";
  return "unknown";
}

export function createMacUpdater(options: MacUpdaterOptions): InstallBackend {
  const exec = options.exec ?? defaultExec;
  const appPath = appBundlePath(options.exePath);
  let staged: string | undefined;
  let relaunch = false;
  let applied = false;

  return {
    unavailableReason: () => locationProblem(appPath),

    async prepare(pkg: InstallPackage, hooks) {
      if (pkg.kind !== "mac-zip") throw new InstallError("no-package");
      const problem = locationProblem(appPath);
      if (problem || !appPath) throw new InstallError(problem ?? "not-installed");
      const work = path.join(options.workDir, pkg.version);
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
      try {
        const zip = path.join(work, "update.zip");
        await downloadVerified(
          options.fetch,
          pkg.url,
          zip,
          { size: pkg.size, sha256: pkg.sha256 },
          hooks.progress,
        );
        hooks.verifying();
        const extractDir = path.join(work, "extract");
        mkdirSync(extractDir);
        const newApp = await extractAndVerify(exec, zip, extractDir, pkg.version);
        const target = stagedPathFor(appPath, pkg.version);
        try {
          rmSync(target, { recursive: true, force: true });
          try {
            renameSync(newApp, target);
          } catch (error) {
            // 用户目录和应用不在同一个卷：整个复制过去（ditto 保留符号链接和权限）
            if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
            await exec("/usr/bin/ditto", [newApp, target]);
          }
        } catch (error) {
          rmSync(target, { recursive: true, force: true });
          throw error instanceof InstallError
            ? error
            : new InstallError(fsFailure(error), String(error));
        }
        staged = target;
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },

    restartNow() {
      relaunch = true;
      options.quit();
    },

    applyOnQuit() {
      if (applied || !staged || !appPath) return;
      applied = true;
      (options.spawnSwap ?? spawnDetached)(
        [String(options.pid), appPath, staged, relaunch ? "1" : "0"],
        options.logFile,
      );
    },

    cleanup() {
      // 上次暂存了但没换上（比如等主进程超时）：删掉，等下次检查再重新下载
      if (!appPath) return;
      const parent = path.dirname(appPath);
      try {
        for (const name of readdirSync(parent)) {
          if (name.startsWith(STAGED_PREFIX))
            rmSync(path.join(parent, name), { recursive: true, force: true });
        }
      } catch {
        /* 目录读不了就算了 */
      }
      rmSync(options.workDir, { recursive: true, force: true });
    },
  };
}
