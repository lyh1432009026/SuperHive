// 必须最先加载：给 Node 24 自带 fetch 的 setTypeOfService 崩溃打补丁
import "./socket-tos-guard.js";
import { serverText } from "@superhive/protocol";
import { errorText } from "./texts.js";
import { existsSync, mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { buildApp, resolveUrl } from "./app.js";
import { RuntimeCredentialStore } from "./runtime-credentials.js";
import { AgentCliManager } from "./agent-clis.js";
import { feishuDriver } from "./im/feishu.js";
import type { ImChannelDriver } from "./im/types.js";
import { lanAddresses } from "./lan-address.js";

import type { AgentCli } from "./local-agents.js";

const host = process.env.HIVE_HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.HIVE_PORT ?? "8787", 10);
const databasePath = process.env.HIVE_DATABASE ?? path.resolve("data/hive.sqlite");
const staticDir = process.env.HIVE_STATIC_DIR;
const instanceId = process.env.HIVE_INSTANCE_ID;
const wildcardHost = host === "0.0.0.0" || host === "::";
const urlHost = (value: string) => (value.includes(":") ? `[${value}]` : value);
const trimUrl = (value: string) => value.replace(/\/$/, "");
// 没配置时按当前网卡现算：换 Wi-Fi、开关手机热点后二维码和外链自动跟着变，不用重启
const detectedUrl = () =>
  `http://${urlHost(wildcardHost ? (lanAddresses()[0] ?? "localhost") : host)}:${port}`;
const configuredPublicUrl = process.env.HIVE_PUBLIC_URL;
const publicUrl = configuredPublicUrl ? trimUrl(configuredPublicUrl) : detectedUrl;
// 网页地址：开发时网页由 Vite 提供（另一个端口），飞书卡片等外链要指向它而不是 Server
const configuredWebUrl = process.env.HIVE_WEB_URL;
const devWebPort = process.env.HIVE_DEV_WEB_PORT;
const webUrl = configuredWebUrl
  ? trimUrl(configuredWebUrl)
  : devWebPort
    ? () => resolveUrl(publicUrl).replace(/:\d+$/, `:${devWebPort}`)
    : publicUrl;
// 开发模式（tsx 直接运行 src/）默认生成仓库本地命令；构建产物（dist/）默认生成已发布的 npx 命令。
const isDevRuntime = import.meta.dirname.endsWith(`${path.sep}src`);
const agentCommandPrefix =
  process.env.HIVE_AGENT_COMMAND ?? (isDevRuntime ? "pnpm agent" : "npx --yes superhive@latest");
mkdirSync(path.dirname(databasePath), { recursive: true });

/**
 * 本机 Agent 用同一份 superhive CLI 拉起：开发时走 tsx 运行仓库源码，打包后用同包内的 dist/cli.js，
 * 都不经过 npx，不依赖网络。HIVE_LOCAL_AGENTS=0 可整体关闭。
 */
// 开发模式下 pnpm 的 cwd 是 apps/server；本机 Agent 的默认工作目录应该是仓库根目录
if (isDevRuntime && !process.env.HIVE_LAUNCH_DIR) {
  process.env.HIVE_LAUNCH_DIR = path.resolve(import.meta.dirname, "../../..");
}

function localAgentCli(): AgentCli | undefined {
  if (isDevRuntime) {
    return {
      command: process.execPath,
      args: [
        "--import",
        import.meta.resolve("tsx"),
        path.resolve(import.meta.dirname, "../../../packages/superhive/src/cli.ts"),
      ],
    };
  }
  const cli = path.resolve(import.meta.dirname, "../cli.js");
  return existsSync(cli) ? { command: process.execPath, args: [cli] } : undefined;
}
const agentCli = process.env.HIVE_LOCAL_AGENTS === "0" ? undefined : localAgentCli();
// 本机 Agent 走回环地址连接，不受局域网 IP 变化影响；只监听了指定网卡时用那个地址
const loopbackHost = ["0.0.0.0", "::", "localhost", "127.0.0.1"].includes(host)
  ? "127.0.0.1"
  : host;
const localServerUrl = `http://${loopbackHost.includes(":") ? `[${loopbackHost}]` : loopbackHost}:${port}`;

// 个人微信走非官方通道：HIVE_IM_WECHAT=0 时整体不加载（网页上也不显示这个选项）
const imDrivers: Partial<Record<"feishu" | "wechat", ImChannelDriver>> = {
  feishu: feishuDriver,
  ...(process.env.HIVE_IM_WECHAT === "0"
    ? {}
    : { wechat: (await import("./im/wechat.js")).wechatDriver }),
};

/** 附件配额（MB）：房间总量与每个上传者的待发暂存量；未设置用默认的 1024 / 200 */
function megabytes(value: string | undefined): number | undefined {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 1024 * 1024) : undefined;
}
const roomAttachmentQuotaBytes = megabytes(process.env.HIVE_ROOM_ATTACHMENT_QUOTA_MB);
const pendingAttachmentQuotaBytes = megabytes(process.env.HIVE_PENDING_ATTACHMENT_QUOTA_MB);

const app = await buildApp({
  databasePath,
  ...(roomAttachmentQuotaBytes ? { roomAttachmentQuotaBytes } : {}),
  ...(pendingAttachmentQuotaBytes ? { pendingAttachmentQuotaBytes } : {}),
  imDrivers,
  runtimeCredentials: new RuntimeCredentialStore(),
  agentClis: new AgentCliManager(),
  imKeyPath: path.join(path.dirname(databasePath), "im-secret.key"),
  publicUrl,
  webUrl,
  agentCommandPrefix,
  ...(staticDir ? { staticDir } : {}),
  ...(instanceId ? { instanceId } : {}),
  ...(agentCli
    ? {
        localAgents: {
          cli: agentCli,
          serverUrl: localServerUrl,
          logDir: path.join(path.dirname(databasePath), "agent-logs"),
          settingsDir: path.join(path.dirname(databasePath), "agent-settings"),
        },
      }
    : {}),
  ...(process.env.HIVE_HANDOVER_FILE ? { handoverFile: process.env.HIVE_HANDOVER_FILE } : {}),
  logger: true,
});
/**
 * 让启动本 Server 的程序（hive stop、dev supervisor）请它正常退出：Windows 上没有 SIGTERM，
 * 结束进程就是强制结束，Agent 下线、IM 断开、交接文件这些收尾都不会执行。
 * 只接受本机回环请求，并且要带上启动时经环境变量传入的口令。
 */
const shutdownToken = process.env.HIVE_SHUTDOWN_TOKEN;
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  const prepare = (app as unknown as { prepareClose?: () => Promise<void> }).prepareClose;
  void (prepare ? prepare().catch(() => undefined) : Promise.resolve())
    .then(() => app.close())
    .finally(() => process.exit(0));
}
if (shutdownToken) {
  const expected = Buffer.from(shutdownToken);
  app.post("/api/local/shutdown", async (request, reply) => {
    const provided = Buffer.from(String(request.headers["x-hive-shutdown"] ?? ""));
    // 来自本机：回环地址，或本机自己的网卡地址（只监听某块网卡时，本机请求也从那个地址来）
    const remote = (request.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const local =
      remote === "127.0.0.1" ||
      remote === "::1" ||
      Object.values(networkInterfaces()).some((entries) =>
        (entries ?? []).some((entry) => entry.address === remote),
      );
    if (!local || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return reply.code(403).send({ ...errorText(serverText("error.auth.notAllowed")) });
    }
    setImmediate(shutdown);
    return reply.code(202).send({ ok: true });
  });
}
await app.listen({ host, port });

const shareUrl = resolveUrl(publicUrl);
const addresses = new Set([
  shareUrl,
  ...lanAddresses().map((address) => `http://${urlHost(address)}:${port}`),
  `http://localhost:${port}`,
]);

app.log.info("SuperHive is ready");
app.log.info(`Share URL: ${shareUrl}`);
for (const address of addresses) app.log.info(`Web: ${address}`);
app.log.info(
  `Agent: ${agentCommandPrefix} join --server ${shareUrl} --name my-agent --token <JOIN_TOKEN>`,
);

// SIGBREAK：Windows 控制台的 Ctrl+Break
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
  process.once(signal, shutdown);
}
