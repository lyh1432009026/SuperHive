#!/usr/bin/env node
// 沙箱预览：用一份数据副本（或空库）起一个临时 Hive Server，给 Agent 做 UI 验证、截图用。
//
//   pnpm preview:sandbox                                  # 空库
//   pnpm preview:sandbox --from-data ~/Coding/ai-hive/apps/server/data
//   pnpm preview:sandbox --from-data <dir> -- node scripts/screenshot.mjs --url {url} --room build
//
// Server 以 HIVE_SANDBOX=1 启动：不连 IM、不起本机 Agent、不跑定时任务、不建删任务目录（服务端硬开关，
// 不靠删数据）；副本在拷贝时就剔除了 IM 凭据、登录令牌等（见 sandbox-data.mjs）。只监听 127.0.0.1，
// 自动挑空闲端口，退出时删掉临时目录；原数据目录只读打开，不会被改。
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { prepareSandboxData } from "./sandbox-data.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const WEB_DIST = path.join(ROOT, "apps/web/dist");
const HELP = `用法：pnpm preview:sandbox [选项] [-- 命令 ...]

  --from-data <目录|文件>  从这个数据目录（含 hive.sqlite）拷一份副本；不给就用空库
  --no-attachments         不拷附件（默认连附件一起拷，APFS 上是写时复制）
  --port <端口>            指定端口；默认自动挑一个空闲端口
  --no-build               不重新构建 protocol 与网页，直接用现有的 apps/web/dist
  --keep                   退出时保留临时数据目录（会打印路径）
  -h, --help               显示帮助

给了「-- 命令」时：Server 就绪后运行该命令（参数里的 {url} 换成沙箱地址，环境变量
SANDBOX_URL 也会带上），命令结束后关闭沙箱，退出码与命令一致。否则一直运行到 Ctrl+C。`;

function fail(message) {
  console.error(`[sandbox] ${message}`);
  process.exit(1);
}

function parse(argv) {
  const split = argv.indexOf("--");
  const own = split < 0 ? argv : argv.slice(0, split);
  const command = split < 0 ? [] : argv.slice(split + 1);
  const { values } = parseArgs({
    args: own,
    options: {
      "from-data": { type: "string" },
      "no-attachments": { type: "boolean", default: false },
      port: { type: "string" },
      "no-build": { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  const port = values.port === undefined ? undefined : Number.parseInt(values.port, 10);
  if (port !== undefined && !(port > 0 && port < 65536))
    throw new Error(`端口不对：${values.port}`);
  return { ...values, port, command };
}

/** 端口 0 让系统分一个空闲的；指定端口时确认没被占用（被占用就报错，不去动别人的进程） */
function freePort(preferred) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) =>
      reject(error.code === "EADDRINUSE" ? new Error(`端口 ${preferred} 已被占用`) : error),
    );
    server.listen(preferred ?? 0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function build() {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  for (const pkg of ["@superhive/protocol", "@superhive/web"]) {
    console.log(`[sandbox] 构建 ${pkg} …`);
    if ((await run(pnpm, ["--filter", pkg, "build"])) !== 0) throw new Error(`${pkg} 构建失败`);
  }
}

/** 子进程的环境：去掉外面带进来的 HIVE_*（比如 Agent 自己连 Hive 用的配置），只留沙箱要的 */
function sandboxEnv(dataDir, port) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("HIVE_")),
  );
  return {
    ...env,
    HIVE_SANDBOX: "1",
    HIVE_HOST: "127.0.0.1",
    HIVE_PORT: String(port),
    HIVE_PUBLIC_URL: `http://127.0.0.1:${port}`,
    HIVE_DATABASE: path.join(dataDir, "hive.sqlite"),
    HIVE_STATIC_DIR: WEB_DIST,
    // 服务端在沙箱下本来就不会加载这些，这里再关一道
    HIVE_LOCAL_AGENTS: "0",
    HIVE_IM_WECHAT: "0",
  };
}

/** 等 Server 回答 /health，并且必须自报是沙箱；不是沙箱就当失败处理，不能让它带着副本跑下去 */
async function waitForSandbox(url, child, timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Server 启动失败（退出码 ${child.exitCode}）`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) {
        const body = await response.json();
        if (body.sandbox !== true) throw new Error("Server 没有进入沙箱模式，已停止");
        return;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("沙箱")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Server 启动超时");
}

function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function main() {
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (error) {
    fail(`${error.message}\n\n${HELP}`);
  }
  if (options.help) {
    console.log(HELP);
    return;
  }

  if (!options["no-build"]) await build();
  if (!fs.existsSync(path.join(WEB_DIST, "index.html")))
    fail(`没有网页构建产物（${WEB_DIST}），去掉 --no-build 重新构建`);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-sandbox-"));
  let server;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await stop(server);
    if (options.keep) console.log(`[sandbox] 保留数据目录：${dataDir}`);
    else fs.rmSync(dataDir, { recursive: true, force: true });
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      void cleanup().then(() => process.exit(130));
    });
  }

  try {
    if (options["from-data"]) {
      const copied = prepareSandboxData({
        from: options["from-data"],
        dir: dataDir,
        attachments: !options["no-attachments"],
      });
      const dropped = Object.entries(copied.removed)
        .filter(([, count]) => count > 0)
        .map(([table, count]) => `${table} ${count}`)
        .join("、");
      console.log(
        `[sandbox] 已从 ${copied.source} 拷贝数据${copied.attachments ? "（含附件）" : ""}`,
      );
      console.log(`[sandbox] 剔除：${dropped || "无"}`);
    } else {
      console.log("[sandbox] 使用空库");
    }

    const port = await freePort(options.port);
    const url = `http://127.0.0.1:${port}`;
    // 直接跑 Server 源码（和 pnpm dev 一样），沙箱看到的就是当前任务线的服务端改动
    server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: path.join(ROOT, "apps/server"),
      env: sandboxEnv(dataDir, port),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const logFile = path.join(dataDir, "server.log");
    const log = fs.createWriteStream(logFile);
    server.stdout.pipe(log);
    server.stderr.pipe(log);
    server.once("exit", (code) => {
      if (cleaned) return;
      console.error(`[sandbox] Server 意外退出（退出码 ${code}），日志：${logFile}`);
      void cleanup().then(() => process.exit(1));
    });

    await waitForSandbox(url, server);
    console.log(`[sandbox] 沙箱已就绪：${url}`);
    console.log(`[sandbox] 数据目录：${dataDir}（Server 日志 server.log）`);
    console.log(`SANDBOX_URL=${url}`);

    if (options.command.length) {
      const [command, ...args] = options.command.map((arg) => arg.replaceAll("{url}", url));
      const code = await run(command, args, { env: { ...process.env, SANDBOX_URL: url } });
      await cleanup();
      process.exit(code);
    }
    console.log("[sandbox] Ctrl+C 结束并清理");
  } catch (error) {
    await cleanup();
    fail(error instanceof Error ? error.message : String(error));
  }
}

await main();
