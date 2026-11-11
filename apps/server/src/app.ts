import { serverText } from "@superhive/protocol";
import { errorText, hiveErrorBody, wsText } from "./texts.js";
import { observeRuntime } from "./runtime-observation.js";
import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  LIMITS,
  clientEventSchema,
  parseMentions,
  createRoomRequestSchema,
  updateRoomRequestSchema,
  createGuestAgentRequestSchema,
  createInviteRequestSchema,
  redeemInviteRequestSchema,
  renewAccessRequestSchema,
  startImLoginRequestSchema,
  setImDeliveryLevelRequestSchema,
  setImLocaleRequestSchema,
  setImScopeRequestSchema,
  submitImLoginCodeRequestSchema,
  type ImChannel,
  type ChatMessage,
  type ClientEvent,
  type Invocation,
  type InvocationBlockReason,
  type Participant,
  type RoomSummary,
  type Schedule,
  type ServerEvent,
  type ServerText,
  type ServerTextParam,
  type WireServerText,
  isServerTextKey,
  zhText,
  type TraceStep,
  DEFAULT_CACHE_WRITE_ALERT_TOKENS,
  keepAwakeSettingsSchema,
  explainInvocationState,
  formatInvocationStateForAgent,
} from "@superhive/protocol";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { AGENT_INSTRUCTIONS } from "./agent-instructions.js";
import {
  CONTINUATION_READY_STATUSES,
  HiveDatabase,
  HiveError,
  TERMINAL_INVOCATION_STATUSES,
  type CreateMessageInput,
} from "./database.js";
import { createHiveMcpServer, type AttachmentReadResult, type InboxDigest } from "./hive-mcp.js";
import { readMessageContent } from "./message-content.js";
import { gitBranch } from "./git-branch.js";
import {
  LocalAgentSupervisor,
  autoSteerKey,
  resolveWorkspace,
  type LocalAgentSupervisorOptions,
} from "./local-agents.js";
import { MANAGE_GRANT_MS, registerLocalAgentRoutes } from "./local-routes.js";
import { KeepAwake } from "./keep-awake.js";
import { OwnerDevices, isOwnerDeviceToken } from "./owner-devices.js";
import { HostApprovals, type HostApproval } from "./host-approvals.js";
import { checkLocalRequest } from "./local-access.js";
import {
  AccessStore,
  expiresAtFrom,
  isGuestToken,
  type AccessSession,
  type ResolvedSession,
} from "./access-store.js";
import { AttachmentStore, publicAttachment, type StoredAttachment } from "./attachment-store.js";
import { ImHub } from "./im/im-hub.js";
import { ImStore } from "./im/im-store.js";
import { SecretBox } from "./im/secret-box.js";
import type { ImChannelDriver } from "./im/types.js";

/**
 * admin：持有共享 join token 的房主与其 Agent（房主页面只在 Server 所在电脑上拿到它）；
 * guest：凭限时邀请进入的访客或访客带入的 Agent，只能访问一个房间，到期或被移除即失效。
 */
/** admin：总令牌、本机，或房主在其他设备上的登录（deviceId） */
type Principal =
  { kind: "admin"; deviceId?: string } | { kind: "guest"; resolved: ResolvedSession };

type Connection = {
  socket: WebSocket;
  participant?: Participant;
  principal?: Principal;
  lastHeartbeat: number;
};

export type ConfiguredUrl = string | (() => string);

export function resolveUrl(value: ConfiguredUrl): string {
  return (typeof value === "function" ? value() : value).replace(/\/$/, "");
}

export type BuildAppOptions = {
  databasePath?: string;
  token?: string;
  /** 对外地址；传函数时每次用到现取（按当前网卡推算的地址会随换网变化） */
  publicUrl?: ConfiguredUrl;
  /** 网页地址（开发时是 Vite 的端口）；飞书卡片上的「在网页查看」用它，缺省同 publicUrl */
  webUrl?: ConfiguredUrl;
  agentCommandPrefix?: string;
  instanceId?: string;
  logger?: boolean;
  heartbeatTimeoutMs?: number;
  /** 扫描超时调用的间隔；测试可调小 */
  invocationSweepMs?: number;
  /** 检查房间工作区 git 分支变化的间隔；测试可调小 */
  branchCheckMs?: number;
  /** 在本机终端里打开 Agent 会话；测试里替换掉，不真的开窗口 */
  openTerminal?: (command: string) => Promise<void>;
  /** 超时扫描使用的时钟；测试用来模拟时间流逝 */
  now?: () => number;
  /** 检查访客会话到期的间隔；测试可调小 */
  accessSweepMs?: number;
  staticDir?: string;
  /**
   * 外部 IM 渠道（飞书、个人微信）的驱动；省略即不提供「连接 IM」（测试默认关闭），由 index.ts 注入。
   */
  imDrivers?: Partial<Record<ImChannel, ImChannelDriver>>;
  /** 熄屏后保持在线（macOS 起 caffeinate）；测试里默认关闭，避免真的阻止睡眠 */
  keepAwake?: boolean;
  /** IM 凭据加密密钥文件；省略时用进程内随机密钥（重启后已保存的连接需要重新扫码） */
  imKeyPath?: string;
  /** 附件文件目录；省略时放在数据库旁的 attachments/（内存数据库用临时目录） */
  attachmentsDir?: string;
  /** 每个房间附件总量、每个上传者未发送暂存量（字节）；省略用 LIMITS 里的默认值 */
  roomAttachmentQuotaBytes?: number;
  pendingAttachmentQuotaBytes?: number;
  /** 清理过期上传与无引用文件的间隔；测试可调小 */
  attachmentSweepMs?: number;
  /**
   * 本机 Agent：允许本机房主在网页上一键拉起 `hive join` 子进程。
   * 省略即关闭（测试默认关闭），由 index.ts 按运行方式注入 CLI 路径。
   */
  /**
   * 交接标记文件：Server 关闭时它存在（且是刚写的），说明只是换代重启（dev 代码更新），
   * 本机 Agent 不随之结束，由下一个 Server 接管；不存在则照常结束本机 Agent。
   */
  handoverFile?: string;
  localAgents?: Omit<
    LocalAgentSupervisorOptions,
    "database" | "joinToken" | "isAgentOnline" | "isNameInUse"
  >;
};

function participantKey(roomId: string, username: string): string {
  return `${roomId}:${username.toLocaleLowerCase()}`;
}

function send(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requestPublicUrl(
  request: { protocol: string; headers: { host?: string | undefined } },
  configuredUrl?: ConfiguredUrl,
): string {
  if (configuredUrl) return resolveUrl(configuredUrl);
  return `${request.protocol}://${request.headers.host ?? "localhost:8787"}`;
}

const roomParamsSchema = z.object({
  roomId: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(64),
});
const messagesQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const mentionsQuerySchema = z.object({
  username: z.string().trim().min(1).max(32),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const roomsQuerySchema = z.object({
  includeArchived: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

/** 有没有新鲜的交接标记（不删除），关闭前判断要不要先让本机 Agent 下线 */
function handoverPending(file: string | undefined): boolean {
  if (!file) return false;
  try {
    return Date.now() - statSync(file).mtimeMs < 2 * 60_000;
  } catch {
    return false;
  }
}

/** 交接标记只在写入后 2 分钟内有效，用后即删，避免过期的标记让真正的关闭也留下进程 */
function consumeHandover(file: string | undefined): boolean {
  if (!file) return false;
  try {
    const fresh = Date.now() - statSync(file).mtimeMs < 2 * 60_000;
    rmSync(file, { force: true });
    return fresh;
  } catch {
    return false;
  }
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: LIMITS.maxClientPayloadBytes,
  });
  const database = new HiveDatabase(options.databasePath ?? "./data/hive.sqlite");
  const joinToken = database.getOrCreateToken(options.token ?? process.env.HIVE_TOKEN);
  const access = new AccessStore(database.connection());
  const imStore = new ImStore(database.connection(), SecretBox.open(options.imKeyPath));
  const ownerDevices = new OwnerDevices(database.connection(), {
    secret: (() => {
      const stored = database.getSetting("ownerLoginSecret");
      if (stored) return Buffer.from(stored, "base64");
      const created = randomBytes(32);
      database.setSetting("ownerLoginSecret", created.toString("base64"));
      return created;
    })(),
    ...(options.now ? { now: options.now } : {}),
  });
  const clock = () => options.now?.() ?? Date.now();
  const webBase = () => {
    const configured = options.webUrl ?? options.publicUrl;
    return configured ? resolveUrl(configured) : undefined;
  };
  const hostApprovals = new HostApprovals({ now: clock });
  // 本机网页可能开在别的端口（dev 时的 Vite、单独公布的网页地址）：只放行这些登记过的端口
  // 端口不随换网变化，启动时取一次即可
  const originPorts = [options.webUrl, options.publicUrl].flatMap((value) => {
    if (!value) return [];
    try {
      const url = new URL(resolveUrl(value));
      return [url.port || (url.protocol === "https:" ? "443" : "80")];
    } catch {
      return [];
    }
  });
  const isLocal = (request: Parameters<typeof checkLocalRequest>[0]) =>
    checkLocalRequest(request, undefined, { originPorts });
  const databasePath = options.databasePath ?? "./data/hive.sqlite";
  const attachments = new AttachmentStore(database.connection(), {
    dir:
      options.attachmentsDir ??
      (databasePath === ":memory:"
        ? mkdtempSync(path.join(tmpdir(), "hive-attachments-"))
        : path.join(path.dirname(databasePath), "attachments")),
    ...(options.roomAttachmentQuotaBytes !== undefined
      ? { roomQuotaBytes: options.roomAttachmentQuotaBytes }
      : {}),
    ...(options.pendingAttachmentQuotaBytes !== undefined
      ? { pendingQuotaBytes: options.pendingAttachmentQuotaBytes }
      : {}),
    now: clock,
  });
  const connections = new Set<Connection>();
  const onlineByName = new Map<string, Set<Connection>>();
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
  let shuttingDown = false;

  await app.register(cors, { origin: true });
  await app.register(websocket, { options: { maxPayload: LIMITS.maxClientPayloadBytes } });
  // 附件走 multipart 流式上传，写盘时边收边算摘要；不经 JSON，也不进 bodyLimit
  await app.register(multipart, {
    limits: { files: 1, fields: 0, parts: 1, fileSize: LIMITS.maxAttachmentBytes },
  });

  const configuredStaticDir =
    options.staticDir ?? path.resolve(import.meta.dirname, "../../web/dist");
  const hasWebUi = existsSync(path.join(configuredStaticDir, "index.html"));
  if (hasWebUi) {
    await app.register(fastifyStatic, { root: configuredStaticDir, wildcard: false });
  }
  // 网页的内容安全策略：只运行自己的脚本，减少注入脚本偷走 localStorage 里登录凭证的可能
  app.addHook("onSend", async (request, reply, payload) => {
    const type = reply.getHeader("content-type");
    if (
      typeof type === "string" &&
      type.startsWith("text/html") &&
      !reply.hasHeader("content-security-policy")
    ) {
      const host = (request.headers.host ?? "").replace(/[^\w.:[\]-]/g, "");
      reply.header(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          // 消息里的 Markdown 图片可能来自外部
          "img-src 'self' data: blob: https:",
          "media-src 'self' blob:",
          "font-src 'self' data:",
          `connect-src 'self' ws://${host} wss://${host}`,
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'",
        ].join("; "),
      );
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Referrer-Policy", "no-referrer");
    }
    return payload;
  });

  function broadcast(roomId: string, event: ServerEvent): void {
    for (const connection of connections) {
      if (connection.participant?.roomId === roomId) send(connection.socket, event);
    }
  }

  /** 跨房间事件涉及的房间；访客只能收到自己房间的 */
  function eventRoomId(event: ServerEvent): string | undefined {
    if (event.type === "invocation.updated") return event.invocation.roomId;
    if (event.type === "rooms.changed") return event.room.id;
    if (event.type === "room.activity") return event.roomId;
    return undefined;
  }

  function broadcastAll(event: ServerEvent): void {
    const roomId = eventRoomId(event);
    for (const connection of connections) {
      if (!connection.participant) continue;
      if (
        connection.principal?.kind === "guest" &&
        connection.principal.resolved.session.roomId !== roomId
      ) {
        continue;
      }
      send(connection.socket, event);
    }
  }

  function broadcastRoomActivity(roomId: string): void {
    broadcastAll({
      type: "room.activity",
      roomId,
      latestSeq: database.latestSeq(roomId),
      onlineCount: database.onlineCount(roomId),
    });
  }

  function setStatus(connection: Connection, status: "online" | "offline" | "busy"): void {
    const current = connection.participant;
    if (!current || current.status === status) return;
    const participant = database.setParticipantStatus(current.id, status);
    connection.participant = participant;
    broadcast(participant.roomId, {
      type: "presence.changed",
      participant: withAccess(participant),
    });
    if ((current.status === "offline") !== (status === "offline")) {
      broadcastRoomActivity(participant.roomId);
    }
  }

  function disconnect(connection: Connection): void {
    connections.delete(connection);
    const participant = connection.participant;
    if (!participant) return;
    const key = participantKey(participant.roomId, participant.username);
    const namedConnections = onlineByName.get(key);
    namedConnections?.delete(connection);
    if (namedConnections?.size) return;
    onlineByName.delete(key);
    if (shuttingDown) return;
    setStatus(connection, "offline");
  }

  /** 任意房间里是否有这个名字的在线成员；agentsOnly 时只看 Agent */
  function onlineAnywhere(username: string, agentsOnly: boolean): boolean {
    const suffix = `:${username.toLocaleLowerCase()}`;
    for (const [key, set] of onlineByName) {
      if (!key.endsWith(suffix)) continue;
      for (const connection of set) {
        if (!agentsOnly || connection.participant?.type === "agent") return true;
      }
    }
    return false;
  }

  const localAgents = options.localAgents
    ? new LocalAgentSupervisor({
        ...options.localAgents,
        database,
        joinToken,
        isAgentOnline: (name) => onlineAnywhere(name, true),
        isNameInUse: (name) => onlineAnywhere(name, false),
        requestShutdown: (name) => {
          const suffix = `:${name.toLocaleLowerCase()}`;
          let sent = false;
          for (const [key, set] of onlineByName) {
            if (!key.endsWith(suffix)) continue;
            for (const connection of set) {
              if (connection.participant?.type !== "agent") continue;
              if (connection.socket.readyState !== connection.socket.OPEN) continue;
              send(connection.socket, { type: "agent.shutdown" });
              sent = true;
            }
          }
          return sent;
        },
      })
    : undefined;
  /**
   * 清空房间：删除消息和调用记录后插入一条话题分隔，各 Agent 据此丢弃旧会话。
   * 只经本机房主接口调用（见 local-routes.ts），操作人必须是该房间里的人类成员。
   */
  function clearRoom(roomId: string, username: string) {
    if (!database.getRoom(roomId))
      throw new HiveError("ROOM_NOT_FOUND", serverText("error.room.notFound"));
    const actor = database.findParticipant(roomId, username);
    if (!actor || actor.type !== "human") {
      throw new HiveError("NOT_A_MEMBER", serverText("error.room.clearMembersOnly"));
    }
    const removed = database.clearRoom(roomId, actor.username);
    for (const [invocationId, trace] of traces)
      if (trace.roomId === roomId) traces.delete(invocationId);
    forgetAgentSessions(roomId);
    const cleared = serverText("topic.cleared", { name: actor.username });
    const message = database.createMessage(actor, {
      content: zhText(cleared),
      text: cleared,
      clientMessageId: `room-clear-${randomUUID()}`,
      kind: "topic",
    }).message;
    broadcast(roomId, { type: "room.cleared", message });
    broadcastRoomActivity(roomId);
    supersedeStale(roomId);
    for (const schedule of database.listSchedules(roomId)) emitSchedule(schedule);
    armScheduleTimer();
    return removed;
  }
  /** 登记过、且账号没变的可批准 IM 连接 */
  function isHostApprover(connection: { id: string; ownerActorId: string }): boolean {
    return ownerDevices.hostApprovers().get(connection.id) === connection.ownerActorId;
  }

  /** 批准或拒绝其他设备管理这台电脑：申请管理权的获批后授予 12 小时 */
  function decideHostApproval(id: string, allow: boolean, by: string): HostApproval | undefined {
    const decided = hostApprovals.decide(id, allow, by);
    if (decided?.status === "approved" && decided.kind === "manage") {
      ownerDevices.grantManage(decided.deviceId, MANAGE_GRANT_MS);
    }
    return decided;
  }

  registerLocalAgentRoutes(app, localAgents, {
    clearRoom,
    ...(options.openTerminal ? { openTerminal: options.openTerminal } : {}),
    agentSession: (roomId, agentName) => {
      const agent = database.findParticipant(roomId, agentName);
      const session = agent ? agentSessions.get(agent.id) : undefined;
      if (!agent || !session) return undefined;
      // 排队中的也算：它马上会开始，终端开着就成了两边同时写一个会话
      const busy =
        database.listExecutingInvocations(agent.id).length > 0 ||
        database
          .listInvocations(roomId)
          .some((item) => item.agentId === agent.id && item.status === "queued");
      return { ...session, busy };
    },
    isLocal,
    ownerDevices: {
      list: () => ownerDevices.list(),
      revoke: revokeOwnerDevice,
      // 包括已超期但可能还连着 WS 的：全部退出不能漏掉
      revokeAll: (except) =>
        ownerDevices
          .unrevokedIds()
          .filter((id) => id !== except)
          .filter((id) => revokeOwnerDevice(id)),
      pair: () => ownerDevices.createPairTicket(),
      webBase,
      joinToken: () => joinToken,
      resolve: (token) => {
        const id = ownerDevices.resolve(token);
        return id ? ownerDevices.get(id) : undefined;
      },
    },
    approvals: {
      store: hostApprovals,
      send: (approval, summaryText) =>
        imHub.requestHostApproval(approval, isHostApprover, summaryText),
      remote: () =>
        imStore
          .listConnections()
          .some((connection) => connection.status !== "paused" && isHostApprover(connection)),
      decide: decideHostApproval,
      approvers: () =>
        imStore.listConnections().map((connection) => ({
          connectionId: connection.id,
          channel: connection.channel,
          label: connection.label,
          allowed: isHostApprover(connection),
        })),
      setApprover: (connectionId, allowed) => {
        const connection = imStore.getConnection(connectionId);
        if (!connection) return false;
        ownerDevices.setHostApprover(connection.id, connection.ownerActorId, allowed);
        return true;
      },
    },
    notifyOwner: (text) => void imHub.notifyOwner(text),
    keepAwake: {
      state: () => keepAwake?.state(),
      update: (patch) => keepAwake?.update(patch),
    },
  });

  /* ---------- 访问控制：房主（join token）与限时访客 ---------- */

  function principalForToken(token: string | undefined): Principal | undefined {
    if (!token) return undefined;
    if (token === joinToken) return { kind: "admin" };
    if (isOwnerDeviceToken(token)) {
      const deviceId = ownerDevices.resolve(token);
      return deviceId ? { kind: "admin", deviceId } : undefined;
    }
    if (!isGuestToken(token)) return undefined;
    const resolved = access.resolveToken(token, clock());
    return resolved?.state === "active" ? { kind: "guest", resolved } : undefined;
  }

  function bearerToken(request: { headers: { authorization?: string | undefined } }) {
    const header = request.headers.authorization;
    return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  }

  function requestPrincipal(request: { headers: { authorization?: string | undefined } }) {
    return principalForToken(bearerToken(request));
  }

  function canAccessRoom(principal: Principal, roomId: string): boolean {
    return principal.kind === "admin" || principal.resolved.session.roomId === roomId;
  }

  /** 没有凭证 401；凭证有效但不属于这个房间 403。返回 undefined 时已经回复了错误 */
  function guard(
    request: { headers: { authorization?: string | undefined } },
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
    roomId?: string,
  ): Principal | undefined {
    const principal = requestPrincipal(request);
    if (!principal) {
      reply
        .code(401)
        .send({ ...errorText(serverText("error.auth.unauthorized")), code: "UNAUTHORIZED" });
      return undefined;
    }
    if (roomId !== undefined && !canAccessRoom(principal, roomId)) {
      reply
        .code(403)
        .send({ ...errorText(serverText("error.auth.roomForbidden")), code: "ROOM_FORBIDDEN" });
      return undefined;
    }
    return principal;
  }

  function adminOnly(
    request: { headers: { authorization?: string | undefined } },
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  ): boolean {
    const principal = guard(request, reply);
    if (!principal) return false;
    if (principal.kind !== "admin") {
      reply
        .code(403)
        .send({ ...errorText(serverText("error.auth.ownerOnly")), code: "OWNER_ONLY" });
      return false;
    }
    return true;
  }

  /** 成员最近的访客会话（同类型）；房主与本机 Agent 没有 */
  function guestSessionOf(participant: Pick<Participant, "roomId" | "username" | "type">) {
    const session = access.latestSessionFor(participant.roomId, participant.username);
    return session && session.kind === participant.type
      ? access.resolve(session, clock())
      : undefined;
  }

  /** 成员信息附上访客期限，成员列表据此显示剩余时间 */
  function withAccess(participant: Participant): Participant {
    const resolved = guestSessionOf(participant);
    if (!resolved) return participant;
    return {
      ...participant,
      access: {
        kind: "guest",
        sessionId: resolved.session.id,
        expiresAt: resolved.expiresAt,
        ...(resolved.sponsor ? { sponsorName: resolved.sponsor.username } : {}),
        ...(resolved.state !== "active" ? { ended: true } : {}),
        ...(resolved.state === "revoked" ? { revoked: true } : {}),
      },
    };
  }

  /** 到期或被移除的访客留在离线列表里（带「已到期」标记），房主可续期，访客下次也可能再加入 */
  function participantsOf(roomId: string): Participant[] {
    return database.listParticipants(roomId).map(withAccess);
  }

  const endedMessages = {
    expired: { code: "SESSION_EXPIRED", ...wsText(serverText("error.guest.expired")) },
    revoked: { code: "SESSION_REVOKED", ...wsText(serverText("error.guest.revoked")) },
  } as const;

  /** 断开访客会话（及其带入的 Agent）的所有连接，并刷新成员列表里的期限 */
  function endSessionConnections(sessionIds: string[], reason: "expired" | "revoked"): void {
    const ids = new Set(sessionIds);
    for (const connection of [...connections]) {
      if (connection.principal?.kind !== "guest") continue;
      if (!ids.has(connection.principal.resolved.session.id)) continue;
      send(connection.socket, { type: "error", ...endedMessages[reason] });
      connection.socket.close(4401, reason);
      disconnect(connection);
    }
  }

  /** 访客或其 Agent 的期限变化后，推送最新的成员信息 */
  function refreshAccessPresence(sessionIds: string[]): void {
    for (const id of sessionIds) {
      const session = access.getSession(id);
      if (!session) continue;
      const participant = database.findParticipant(session.roomId, session.username);
      if (participant) {
        broadcast(session.roomId, {
          type: "presence.changed",
          participant: withAccess(participant),
        });
      }
    }
  }

  /** 连接上的访客会话、房主设备会话是否仍有效；失效时断开并返回 false */
  function ensureActive(connection: Connection): boolean {
    const principal = connection.principal;
    if (principal?.kind === "admin" && principal.deviceId) {
      // 设备会话超期、闲置太久或已退出：和 HTTP 一样不再放行
      if (ownerDevices.get(principal.deviceId)) return true;
      send(connection.socket, {
        type: "error",
        code: "SESSION_REVOKED",
        ...wsText(serverText("error.device.sessionInvalid")),
      });
      connection.socket.close(4401, "revoked");
      disconnect(connection);
      return false;
    }
    if (connection.principal?.kind !== "guest") return true;
    const current = access.getSession(connection.principal.resolved.session.id);
    const resolved = current ? access.resolve(current, clock()) : undefined;
    if (resolved?.state === "active") {
      connection.principal = { kind: "guest", resolved };
      return true;
    }
    const reason = resolved?.state === "expired" ? "expired" : "revoked";
    send(connection.socket, { type: "error", ...endedMessages[reason] });
    connection.socket.close(4401, reason);
    disconnect(connection);
    return false;
  }

  function sweepExpiredAccess(): void {
    const expired = new Set<string>();
    for (const connection of [...connections]) {
      const principal = connection.principal;
      if (principal?.kind === "admin" && principal.deviceId) {
        ensureActive(connection);
        continue;
      }
      if (principal?.kind !== "guest") continue;
      const id = principal.resolved.session.id;
      if (!ensureActive(connection)) expired.add(id);
    }
    if (expired.size) refreshAccessPresence([...expired]);
  }

  /** 兑换邀请时：同名的有效成员不能被顶替；曾经的访客到期或被移除后，可以用同名重新加入 */
  function isNameTaken(roomId: string, username: string): boolean {
    // 同一链接多人共用：已兑换但还没连上的访客也占着名字
    const pending = access.latestSessionFor(roomId, username);
    if (pending && access.resolve(pending, clock()).state === "active") return true;
    const existing = database.findParticipant(roomId, username);
    if (!existing) return false;
    const resolved = guestSessionOf(existing);
    return !(existing.type === "human" && resolved && resolved.state !== "active");
  }

  function sessionView(resolved: ResolvedSession) {
    return {
      role: "guest" as const,
      kind: resolved.session.kind,
      sessionId: resolved.session.id,
      roomId: resolved.session.roomId,
      username: resolved.session.username,
      expiresAt: resolved.expiresAt,
      allowAgents: resolved.allowAgents,
      showTrace: resolved.showTrace,
    };
  }

  function guestAgentCommand(
    request: Parameters<typeof requestPublicUrl>[0],
    session: AccessSession,
    token: string,
  ) {
    const prefix = options.agentCommandPrefix ?? "npx --yes superhive@latest";
    return `${prefix} join --server ${requestPublicUrl(request, options.publicUrl)} --room ${session.roomId} --name ${session.username} --token ${token}`;
  }

  function onlineAgent(roomId: string, username: string): Connection | undefined {
    return [...(onlineByName.get(participantKey(roomId, username)) ?? [])].find(
      (connection) => connection.participant?.type === "agent",
    );
  }

  // 推送给所有在线客户端：侧栏的跨房间"Agent 任务"计数需要实时更新，各房间视图按 roomId 自行过滤
  /** 收起已经过时的失败、被拦、结果未知，推送给所有能看到它们的页面 */
  function supersedeStale(roomId?: string): void {
    for (const invocation of database.supersedeStaleInvocations(roomId)) {
      broadcastAll({ type: "invocation.updated", invocation });
    }
  }

  /**
   * 执行过程只放内存：调用还在执行时按步合并，结束（或被停止、转为等人回答）就丢掉。
   * 发给房间里房主的页面（本机或已登录的房主设备），以及邀请时允许看执行过程、仍在有效期内的访客；
   * Agent、IM 都收不到。
   */
  const traces = new Map<string, { roomId: string; steps: Map<string, TraceStep> }>();
  const TRACE_LIVE_STATUSES: readonly Invocation["status"][] = ["running", "cancelling"];

  /** 这个连接能不能看执行过程：房主可以；访客看邀请时的开关，期限、撤销按当前状态重新核对 */
  function canSeeTrace(connection: Connection, roomId: string): boolean {
    const participant = connection.participant;
    if (participant?.roomId !== roomId || participant.type !== "human") return false;
    const principal = connection.principal;
    if (principal?.kind === "admin") return true;
    if (principal?.kind !== "guest") return false;
    const resolved = access.resolve(principal.resolved.session, clock());
    return resolved.state === "active" && resolved.showTrace;
  }

  function sendToTraceViewers(roomId: string, event: ServerEvent): void {
    for (const connection of connections) {
      if (canSeeTrace(connection, roomId)) send(connection.socket, event);
    }
  }

  function recordTrace(agent: Participant, messageId: string, steps: TraceStep[]): void {
    const invocation = database.getInvocationFor(messageId, agent.id);
    if (!invocation || !TRACE_LIVE_STATUSES.includes(invocation.status)) return;
    let trace = traces.get(invocation.id);
    if (!trace) {
      trace = { roomId: invocation.roomId, steps: new Map() };
      traces.set(invocation.id, trace);
    }
    for (const step of steps) {
      trace.steps.delete(step.id);
      trace.steps.set(step.id, { ...trace.steps.get(step.id), ...step });
      // 超过上限丢掉最早的几步：只是实时状态，不需要完整
      while (trace.steps.size > LIMITS.maxTraceSteps) {
        trace.steps.delete(trace.steps.keys().next().value!);
      }
    }
    sendToTraceViewers(invocation.roomId, {
      type: "invocation.trace",
      roomId: invocation.roomId,
      invocationId: invocation.id,
      steps,
    });
  }

  function endTrace(invocation: Invocation): void {
    if (TRACE_LIVE_STATUSES.includes(invocation.status) || !traces.delete(invocation.id)) return;
    sendToTraceViewers(invocation.roomId, {
      type: "invocation.trace",
      roomId: invocation.roomId,
      invocationId: invocation.id,
      steps: [],
      ended: true,
    });
  }

  /** Agent 在各房间当前的 Provider 会话（按房间里的成员 ID）：本机房主可以在终端里接着它 */
  const agentSessions = new Map<string, { sessionId: string; cwd: string }>();

  /** 开新话题或清空房间后，Agent 下一轮从新会话开始：旧会话不再能在终端里接着 */
  function forgetAgentSessions(roomId: string): void {
    for (const participantId of [...agentSessions.keys()]) {
      if (database.getParticipant(participantId)?.roomId === roomId) {
        agentSessions.delete(participantId);
      }
    }
  }

  /** 等人批的权限申请（见 requestApproval） */
  const approvals = new Map<string, PendingApproval>();
  const approvalByQuestion = new Map<string, string>();

  function emitInvocation(invocation: Invocation): Invocation {
    broadcastAll({ type: "invocation.updated", invocation });
    endTrace(invocation);
    // 这一轮结束了：它还在等的权限申请作废
    if (isTerminal(invocation)) {
      for (const pending of [...approvals.values()]) {
        if (pending.invocationId === invocation.id) settleApproval(pending.requestId, "expired");
      }
    }
    // 这个 Agent 在房间里正常完成了一次任务：它更早留下的异常多半已经过时，自动收起
    if (invocation.status === "completed") setImmediate(() => supersedeStale(invocation.roomId));
    // 任务结果和需要人处理的状态推到房主的 IM（失败、被拦下这些往往没有对应的聊天消息）
    imHub.onInvocationUpdated(invocation);
    scheduleKeepAwake();
    // 所有状态变更都经过这里：委派的子任务一结束就安排回执，放到下一拍避免在派发循环中重入
    if (
      invocation.continuation === "pending" &&
      CONTINUATION_READY_STATUSES.includes(invocation.status)
    ) {
      setImmediate(() => deliverContinuation(invocation.id));
    }
    // 定时任务触发的调用结束了：没有正常回复时由服务端补一条说明
    if (CONTINUATION_READY_STATUSES.includes(invocation.status)) {
      const schedule = database.scheduleForInvocation(invocation.id);
      if (schedule) setImmediate(() => reportSchedule(schedule.id));
    }
    return invocation;
  }

  /** 正被委派方 hive_wait 的子任务 ID 及等待者数量 */
  const activeWaits = new Map<string, number>();

  const continuationOutcome: Partial<Record<Invocation["status"], ServerText>> = {
    completed: serverText("receipt.status.completed"),
    failed: serverText("receipt.status.failed"),
    cancelled: serverText("receipt.status.cancelled"),
    timed_out: serverText("receipt.status.timedOut"),
  };

  /** 引用的正文里的 @ 换成全角，避免回执把原文中提到的成员再唤醒一遍 */
  function quoteWithoutMentions(text: string, limit: number): string {
    const quoted = text.replace(/@/g, "＠");
    return quoted.length > limit ? `${quoted.slice(0, limit)}…（已截断，全文见原消息）` : quoted;
  }

  /**
   * 子任务结束后，代被委派方给委派方发一条回执，把结果交回去：
   * 委派方不必轮询，也不依赖被委派方记得回头 @ 它。回执沿委派消息挂链，预算照常计算。
   * 先原子地占用回执状态再发消息，保证与 hive_wait、重启补发之间只回执一次。
   */
  function deliverContinuation(childId: string): void {
    // 委派方正在 hive_wait 这个子任务：结果由等待直接交回，等待结束时再决定是否补发回执
    if (activeWaits.has(childId)) return;
    const child = database.getInvocation(childId);
    if (
      !child ||
      child.continuation !== "pending" ||
      !CONTINUATION_READY_STATUSES.includes(child.status)
    ) {
      return;
    }
    const delegation = database.getMessage(child.messageId);
    const requester = child.requesterId ? database.getParticipant(child.requesterId) : undefined;
    const delegate = database.getParticipant(child.agentId);
    if (
      !delegation ||
      delegation.deletedAt ||
      !requester ||
      requester.type !== "agent" ||
      !delegate
    ) {
      if (database.claimContinuation(child.id, "failed")) {
        emitInvocation(database.getInvocation(child.id)!);
      }
      return;
    }
    if (!database.claimContinuation(child.id, "delivered")) return;
    const reply = child.replyMessageId ? database.getMessage(child.replyMessageId) : undefined;
    const text = serverText("receipt.delegation", {
      requester: requester.username,
      delegate: delegate.username,
      status: continuationOutcome[child.status] ?? child.status,
      task: quoteWithoutMentions(delegation.content, 300),
      outcome:
        reply && !reply.deletedAt
          ? serverText("receipt.result", {
              seq: reply.seq,
              result: quoteWithoutMentions(reply.content, 4000),
            })
          : child.detail
            ? serverText("receipt.note", { note: quotedDetail(child, 500) })
            : "",
      id: child.id,
    });
    try {
      createAndDispatchMessage(
        delegate,
        {
          content: zhText(text),
          text,
          clientMessageId: `receipt-${child.id}`,
          parentMessageId: delegation.id,
          kind: "receipt",
        },
        { receipt: true },
      );
      emitInvocation(database.getInvocation(child.id)!);
    } catch (error) {
      // 链条深度、条数到顶这类错误重试也无济于事；限流等暂时性错误放回待发，由扫描重试
      const permanent =
        error instanceof HiveError &&
        ["HOP_LIMIT", "TRACE_LIMIT", "PARENT_NOT_FOUND", "SELF_RESPONSE"].includes(error.code);
      database.releaseContinuation(child.id, permanent ? "failed" : "pending");
      emitInvocation(
        database.updateInvocation(child.id, {
          detail: permanent
            ? serverText("invocation.receiptUndeliverable", {
                name: requester.username,
                reason: errorReason(error),
              })
            : (child.detailText ?? child.detail ?? null),
        }),
      );
    }
  }

  function isTerminal(invocation: Invocation): boolean {
    return TERMINAL_INVOCATION_STATUSES.includes(invocation.status);
  }

  function deliverMention(
    message: ChatMessage,
    agent: Participant,
    retry = false,
    steer = false,
    first = false,
  ): void {
    const target = onlineAgent(message.roomId, agent.username);
    if (!target) return;
    send(target.socket, {
      type: "agent.mentioned",
      message,
      latestSeq: database.latestSeq(message.roomId),
      ...(retry ? { retry: true } : {}),
      ...(steer ? { steer: true } : {}),
      ...(first ? { first: true } : {}),
      ...(asLead(message, agent) ? { lead: true } : {}),
    });
  }

  /** 这个 Agent 在这个房间里正在执行的调用（插话、停下改做都要有它） */
  function runningInvocations(agent: Participant, except?: string): Invocation[] {
    return database
      .listExecutingInvocations(agent.id)
      .filter(
        (item) => item.roomId === agent.roomId && item.status === "running" && item.id !== except,
      );
  }

  /**
   * 能不能插进当前任务：只有人发的普通消息（不含定时触发）、还在排队（没被拦下）、
   * 这个 Agent 在这个房间里正有任务在执行。其他 Agent 的消息、回执、定时触发一律照常排队。
   */
  function steerableInvocation(actor: Participant, invocationId: string) {
    const invocation = invocationInRoom(actor, invocationId);
    const message = database.getMessage(invocation.messageId);
    const agent = database.getParticipant(invocation.agentId);
    if (!message || message.deletedAt || !agent) {
      throw new HiveError("STEER_UNAVAILABLE", serverText("error.steer.messageGone"));
    }
    if (message.senderType !== "human" || message.kind === "schedule") {
      throw new HiveError("STEER_UNAVAILABLE", serverText("error.steer.humanOnly"));
    }
    if (invocation.status !== "queued") {
      throw new HiveError("STEER_UNAVAILABLE", serverText("error.steer.notQueued"));
    }
    const running = runningInvocations(agent, invocation.id);
    if (running.length === 0) {
      throw new HiveError(
        "STEER_UNAVAILABLE",
        serverText("error.steer.agentIdle", { agent: agent.username }),
      );
    }
    return { invocation, message, agent, running };
  }

  /** 插入当前任务：让 Agent 把这条并进正在执行的这一轮（插不进去时 Agent 会说明并留在队里） */
  function steerInvocation(actor: Participant, invocationId: string): void {
    const { invocation, message, agent } = steerableInvocation(actor, invocationId);
    emitInvocation(
      database.updateInvocation(invocation.id, {
        detail: serverText("invocation.steerRequested", { name: actor.username }),
      }),
    );
    deliverMention(message, agent, false, true);
  }

  /**
   * 停下当前，改做这条：先请求停止正在执行的任务（它会变成已停止或结果未知），
   * 确认停下后 Agent 从队里接着做这一条；不会两份同时在跑。
   */
  function preemptInvocation(actor: Participant, invocationId: string): void {
    const { invocation, message, agent, running } = steerableInvocation(actor, invocationId);
    // 先让 Agent 把这条排到队首、下一轮单独做，再停当前任务
    deliverMention(message, agent, false, false, true);
    for (const item of running) cancelInvocation(actor, item.id);
    emitInvocation(
      database.updateInvocation(invocation.id, {
        detail: serverText("invocation.preemptRequested", { name: actor.username }),
      }),
    );
  }

  /** 这个 Agent 打开了「人发的消息自动插话」 */
  function autoSteers(agent: Participant): boolean {
    return database.getSetting(autoSteerKey(agent.username)) === "1";
  }

  /**
   * 多维防循环预算（参考 yobiru）：传递深度、人类缺席时的 Agent 连续轮数、每对 Agent 每日次数。
   * 人发出的 @ 只受深度限制；人在 UI 中追加轮数后，被拦下的调用会被恢复。
   */
  function budgetBlock(
    sender: Participant,
    message: ChatMessage,
    agent: Participant,
  ): { reason: InvocationBlockReason; detail: ServerText } | undefined {
    const hopLimit = LIMITS.maxHopCount + database.turnAllowance(message.roomId);
    if (message.hopCount >= hopLimit) {
      return {
        reason: "hop_limit",
        detail: serverText("invocation.blockedHop", { limit: hopLimit }),
      };
    }
    if (sender.type !== "agent") return undefined;
    // 回执把已放行的委派结果交回发起方：拦下它，发起方就永远等不到结果，只受转交深度约束
    if (message.kind === "receipt") return undefined;
    const budget = database.agentTurnBudget(message.roomId);
    if (budget.used > budget.limit) {
      return {
        reason: "consecutive_limit",
        detail: serverText("invocation.blockedTurns", {
          used: budget.used - 1,
          limit: budget.limit,
        }),
      };
    }
    const extra = budget.limit - LIMITS.maxConsecutiveAgentTurns;
    const pairLimit = LIMITS.maxAgentPairTurnsPerDay + extra;
    if (database.pairTurnsToday(message.roomId, sender.id, agent.id) >= pairLimit) {
      return {
        reason: "pair_limit",
        detail: serverText("invocation.blockedPair", {
          sender: sender.username,
          agent: agent.username,
          limit: pairLimit,
        }),
      };
    }
    return undefined;
  }

  /**
   * Agent 经 MCP 发消息却没带 parentMessageId 时，若它正在执行调用，就用触发消息补上 parent。
   * hop / trace 预算只沿 parent 链累计，不能交给提示词规则自觉遵守——
   * 否则执行中省略 parent 就能从 hop 0 另起一条链，绕过防循环上限。
   * 合批时取传递深度最大的触发消息（同深度取最新），与 bridge 的 pickReplyParent 一致。
   */
  function inferExecutingParent(agent: Participant): ChatMessage | undefined {
    let best: ChatMessage | undefined;
    for (const invocation of database.listExecutingInvocations(agent.id)) {
      const trigger = database.getMessage(invocation.messageId);
      if (!trigger || trigger.roomId !== agent.roomId) continue;
      if (
        !best ||
        trigger.hopCount > best.hopCount ||
        (trigger.hopCount === best.hopCount && trigger.seq > best.seq)
      ) {
        best = trigger;
      }
    }
    return best;
  }

  /**
   * Agent 带 parentMessageId 的回复同时推进对应调用。
   * 返回 false 表示回复属于已被人停止的调用：消息照常展示，但不再据此唤醒其他 Agent。
   * parent 由服务端推断时（见 inferExecutingParent）只做防循环记账，不推进完成：
   * 执行中途的一条进度消息不代表这一轮结束，完成由 bridge 在轮末报告。
   */
  function completeFromReply(
    agent: Participant,
    reply: ChatMessage,
    options: { inferredParent?: boolean; fromTool?: boolean } = {},
  ): boolean {
    if (!reply.parentMessageId) return true;
    const invocation = database.getInvocationFor(reply.parentMessageId, agent.id);
    if (!invocation) return true;
    if (invocation.status === "cancelled") return false;
    if (options.inferredParent) return invocation.status !== "cancelling";
    if (isTerminal(invocation)) return true;
    // 提过问的调用等人回答才算结束；这一轮的回复只记下来，不把它推进到完成
    if (invocation.status === "waiting_human") {
      emitInvocation(database.updateInvocation(invocation.id, { replyMessageId: reply.id }));
      return true;
    }
    // 有 Bridge 在执行这一轮（报过执行中、在发心跳）：Agent 用工具中途发的消息只是进度，不结束这一轮；
    // 结束与最终回复以 Bridge 轮末上报为准。没有 Bridge 的 Agent（手动接入）仍以这条回复作为结束
    if (options.fromTool && invocation.status === "running" && invocation.runtime) {
      emitInvocation(
        database.updateInvocation(invocation.id, {
          progress: serverText("invocation.toolMessageSent", { seq: reply.seq }),
        }),
      );
      return true;
    }
    const stopping = invocation.status === "cancelling";
    emitInvocation(
      database.updateInvocation(invocation.id, {
        status: stopping ? "cancelling" : "completed",
        replyMessageId: reply.id,
        ...(stopping ? {} : { finishedAt: new Date().toISOString() }),
        progress: null,
        detail: stopping
          ? serverText("invocation.replyWhileStopping")
          : invocation.status === "timed_out"
            ? serverText("invocation.lateResult")
            : null,
      }),
    );
    return !stopping;
  }

  function createAndDispatchMessage(
    participant: Participant,
    input: CreateMessageInput,
    options: {
      inferredParent?: boolean;
      delegateTo?: string;
      receipt?: boolean;
      /** 发送并插话：@ 到的 Agent 正在执行时插进当前任务 */
      steer?: boolean;
      /** Agent 经 hive_message_send 发出（不是 Bridge 代发的最终回复） */
      fromTool?: boolean;
    } = {},
  ) {
    const result = database.createMessage(participant, input);
    if (!result.created) return result;
    const message = result.message;
    broadcast(participant.roomId, { type: "message.created", message });
    broadcastRoomActivity(participant.roomId);
    imHub.onMessageCreated(message);
    if (message.kind === "topic") {
      supersedeStale(message.roomId);
      forgetAgentSessions(message.roomId);
    }
    // 进度只是给人看的：不推进调用，也不唤醒任何 Agent；调用上记一笔最近进度
    if (message.kind === "progress") {
      const invocation = message.parentMessageId
        ? database.getInvocationFor(message.parentMessageId, participant.id)
        : undefined;
      if (invocation && !isTerminal(invocation)) {
        emitInvocation(
          database.updateInvocation(invocation.id, {
            progress: oneLineProgress(message.content),
          }),
        );
      }
      return result;
    }
    // 回执由服务端代发，不是被委派方的回复：既不推进子任务，也不因子任务已停止而吞掉对委派方的 @
    if (
      participant.type === "agent" &&
      !options.receipt &&
      !completeFromReply(participant, message, options)
    ) {
      return result;
    }
    // 人批了 Agent 执行中申请的权限：结果直接交回正在跑的那一轮，不另起一轮、不唤醒任何人
    if (participant.type === "human" && message.replyToMessageId) {
      const requestId = approvalByQuestion.get(message.replyToMessageId);
      const pending = requestId ? approvals.get(requestId) : undefined;
      const allow = pending ? approvalChoice(message) : undefined;
      if (pending && allow !== undefined && canApprove(participant, pending)) {
        settleApproval(pending.requestId, allow ? "allowed" : "denied", participant.username);
        return result;
      }
    }
    // 人回复了 Agent 的提问：结束等待中的调用，并用这条回答重新唤醒提问的 Agent（不必再 @ 它）
    const answered = participant.type === "human" ? answeredQuestion(message) : undefined;
    const targets = [...message.mentions];
    // 访客（及其 Agent）发出的 @：房主的 Agent 可能有本机完全权限，未获授权时等房主批准
    const senderGuest = options.receipt ? undefined : guestSessionOf(participant);
    // 房间设了主 Agent 时，人发的、没有 @ 任何人的消息也有人接（未授权访客的不算，免得闲聊堆满待批准）
    const implicit =
      !answered && !(senderGuest && !senderGuest.allowAgents) ? implicitTarget(message) : undefined;
    if (implicit) targets.push(implicit.username);
    if (
      answered &&
      !targets.some((name) => name.toLocaleLowerCase() === answered.agentName.toLocaleLowerCase())
    ) {
      targets.push(answered.agentName);
    }
    // Agent 在执行中发出的 @ 记下上游调用，任务概览才能画出真实的委派关系
    const parentInvocation =
      participant.type === "agent" && message.parentMessageId
        ? database.getInvocationFor(message.parentMessageId, participant.id)
        : undefined;
    for (const mention of targets) {
      if (mention.toLocaleLowerCase() === "all") continue;
      const agent = database.findParticipant(participant.roomId, mention);
      if (!agent || agent.type !== "agent" || agent.id === participant.id) continue;
      const needsApproval =
        senderGuest &&
        !senderGuest.allowAgents &&
        !guestSessionOf(agent) &&
        !(answered && answered.agentId === agent.id);
      const blocked = needsApproval
        ? {
            reason: "guest_approval" as const,
            detail: serverText("invocation.blockedGuest", { name: participant.username }),
          }
        : budgetBlock(participant, message, agent);
      const { invocation: createdInvocation, created } = database.createInvocation({
        message,
        agent,
        status: blocked ? "blocked" : "queued",
        ...(blocked ? { blockReason: blocked.reason, detail: blocked.detail } : {}),
        ...(parentInvocation ? { parentInvocationId: parentInvocation.id } : {}),
        ...(options.delegateTo === agent.id ? { continuation: "pending" as const } : {}),
      });
      if (!created) continue;
      let invocation = createdInvocation;
      if (answered && answered.agentId === agent.id) {
        if (database.adoptContinuation(answered.id, invocation.id)) {
          invocation = database.getInvocation(invocation.id)!;
        }
        // 提问前发过的进度接着算：一问一答不能把名额重新刷满
        database.setProgressCount(invocation.id, database.progressCount(answered.id));
        // 定时任务那一轮提过问：后续结果在续上的新调用里，状态与补发说明都跟着它走
        const schedule = database.scheduleForInvocation(answered.id);
        if (schedule) {
          emitSchedule(database.updateSchedule(schedule.id, { invocationId: invocation.id }));
        }
        emitInvocation(
          database.updateInvocation(answered.id, {
            status: "completed",
            finishedAt: answered.finishedAt ?? new Date().toISOString(),
            progress: null,
            detail: serverText("invocation.answered", {
              name: participant.username,
              seq: message.seq,
            }),
          }),
        );
      }
      emitInvocation(invocation);
      if (blocked) continue;
      // 人发的消息、Agent 正在执行：按人的要求（发送并插话）或 Agent 的自动插话设置插进当前任务
      const steer =
        participant.type === "human" &&
        message.kind !== "schedule" &&
        !answered &&
        (options.steer === true || autoSteers(agent)) &&
        runningInvocations(agent, invocation.id).length > 0;
      if (steer) {
        emitInvocation(
          database.updateInvocation(invocation.id, {
            detail: serverText(options.steer ? "invocation.steerSend" : "invocation.steerAuto"),
          }),
        );
      }
      deliverMention(message, agent, false, steer);
    }
    return result;
  }

  /** 房间设了主 Agent 且它还在房间里时返回它 */
  function leadAgentOf(roomId: string): Participant | undefined {
    const name = database.getRoom(roomId)?.leadAgent;
    const agent = name ? database.findParticipant(roomId, name) : undefined;
    return agent?.type === "agent" ? agent : undefined;
  }

  /** 人发的普通消息、没有 @ 任何人（Agent 的消息、回执、定时触发、话题分隔都不算） */
  function unaddressed(message: ChatMessage): boolean {
    return message.senderType === "human" && !message.kind && message.mentions.length === 0;
  }

  /** 回复的是哪个 Agent 的消息（它还在房间里时） */
  function repliedAgent(message: ChatMessage): Participant | undefined {
    const replied = message.replyToMessageId
      ? database.getMessage(message.replyToMessageId)
      : undefined;
    if (!replied || replied.deletedAt || replied.senderType !== "agent") return undefined;
    const agent = database.getParticipant(replied.senderId);
    return agent?.type === "agent" && agent.roomId === message.roomId ? agent : undefined;
  }

  /**
   * 设了主 Agent 的房间里，没有 @ 任何人的消息交给谁：回复的是某个 Agent 的消息就交给它，
   * 否则交给主 Agent。没设主 Agent 时和以前一样没人接。
   */
  function implicitTarget(message: ChatMessage): Participant | undefined {
    if (!unaddressed(message)) return undefined;
    const lead = leadAgentOf(message.roomId);
    if (!lead) return undefined;
    return repliedAgent(message) ?? lead;
  }

  /** 这次派发是不是把这个 Agent 当作主 Agent 唤醒（重试、批准后、重连补发都按同一规则算） */
  function asLead(message: ChatMessage, agent: Participant): boolean {
    return (
      unaddressed(message) && !repliedAgent(message) && leadAgentOf(message.roomId)?.id === agent.id
    );
  }

  /** 这条消息回复的是 Agent 的提问且该调用仍在等人回答时，返回那个等待中的调用 */
  function answeredQuestion(message: ChatMessage): Invocation | undefined {
    if (!message.replyToMessageId) return undefined;
    const invocation = waitingForQuestion(message.replyToMessageId);
    return invocation && invocation.roomId === message.roomId ? invocation : undefined;
  }

  function waitingForQuestion(questionId: string): Invocation | undefined {
    const question = database.getMessage(questionId);
    if (
      !question ||
      question.kind !== "question" ||
      question.deletedAt ||
      !question.parentMessageId
    ) {
      return undefined;
    }
    const invocation = database.getInvocationFor(question.parentMessageId, question.senderId);
    return invocation?.status === "waiting_human" ? invocation : undefined;
  }

  /**
   * 网页点选回答：按提问里保存的题目校验所选，生成完整正文（带选项原文，历史被裁剪也看得懂），
   * 再作为对提问的回复走普通的回答续接。同一 clientMessageId 的重试直接返回已发出的答案；
   * 提问已被回答（另一个标签页、手打回复）后再点选会被拒绝，保证只续接一次。
   */
  function submitAnswer(
    human: Participant,
    input: Extract<ClientEvent, { type: "question.answer" }>,
  ): { message: ChatMessage; created: boolean } {
    const existing = database.findMessageByClientId(human.id, input.clientMessageId);
    if (existing) return { message: existing, created: false };
    const question = database.getMessage(input.questionMessageId);
    if (
      !question ||
      question.roomId !== human.roomId ||
      question.kind !== "question" ||
      question.deletedAt ||
      !question.question
    ) {
      throw new HiveError("QUESTION_NOT_FOUND", serverText("error.question.notFound"));
    }
    const approval = approvalByQuestion.get(question.id);
    if (!waitingForQuestion(question.id) && !approval) {
      throw new HiveError("QUESTION_CLOSED", serverText("error.question.closed"));
    }
    if (approval) {
      if (!canApprove(human, approvals.get(approval)!)) {
        throw new HiveError("FORBIDDEN", serverText("error.approval.forbidden"));
      }
      if (input.other?.trim()) {
        throw new HiveError("INVALID_ANSWER", serverText("error.approval.invalidAnswer"));
      }
    }
    const spec = question.question;
    const selected = [...new Set(input.selected)];
    if (selected.length !== input.selected.length) {
      throw new HiveError("INVALID_ANSWER", serverText("error.answer.duplicateOption"));
    }
    const labels = new Map(spec.options.map((option) => [option.key, option.label]));
    const unknown = selected.find((key) => !labels.has(key));
    if (unknown)
      throw new HiveError(
        "INVALID_ANSWER",
        serverText("error.answer.unknownOption", { option: unknown }),
      );
    const other = input.other?.trim() || undefined;
    const picks = selected.length + (other ? 1 : 0);
    if (picks === 0) throw new HiveError("INVALID_ANSWER", serverText("error.answer.empty"));
    if (!spec.multiple && picks > 1) {
      throw new HiveError("INVALID_ANSWER", serverText("error.answer.singleChoice"));
    }
    const ordered = spec.options.filter((option) => selected.includes(option.key));
    const parts = [
      ...(ordered.length
        ? [`选择 ${ordered.map((option) => `${option.key}：${option.label}`).join("；")}`]
        : []),
      ...(other ? [`其它：${other}`] : []),
    ];
    return createAndDispatchMessage(human, {
      content: parts.join("；"),
      clientMessageId: input.clientMessageId,
      replyToMessageId: question.id,
      answer: {
        questionMessageId: question.id,
        selected: ordered.map((option) => option.key),
        ...(other ? { other } : {}),
      },
    });
  }

  /**
   * hive_ask_human：Agent 在执行中需要人拍板时，发一条提问并把当前调用转为等人回答。
   * 这一轮照常结束、不占进程；人回复提问后由服务端以回答重新唤醒它，等待期间不算卡住。
   */
  function askHuman(
    agent: Participant,
    input: { question: string; clientMessageId: string; options?: string[]; multiple?: boolean },
  ) {
    const labels = (input.options ?? []).map((label) => label.replace(/\s+/g, " ").trim());
    if (labels.length > 0) {
      if (labels.length < 2 || labels.length > LIMITS.maxQuestionOptions) {
        throw new HiveError(
          "INVALID_OPTIONS",
          serverText("error.question.optionCount", { max: LIMITS.maxQuestionOptions }),
        );
      }
      if (labels.some((label) => !label || label.length > LIMITS.maxQuestionOptionLength)) {
        throw new HiveError(
          "INVALID_OPTIONS",
          serverText("error.question.optionLength", { max: LIMITS.maxQuestionOptionLength }),
        );
      }
      if (new Set(labels.map((label) => label.toLocaleLowerCase())).size !== labels.length) {
        throw new HiveError("INVALID_OPTIONS", serverText("error.question.duplicateOptions"));
      }
    }
    const spec = labels.length
      ? {
          options: labels.map((label, index) => ({
            key: String.fromCharCode(65 + index),
            label,
          })),
          multiple: input.multiple === true,
        }
      : undefined;
    const parent = inferExecutingParent(agent);
    const invocation = parent ? database.getInvocationFor(parent.id, agent.id) : undefined;
    if (!parent || !invocation || invocation.status === "cancelling") {
      throw new HiveError("NOT_EXECUTING", serverText("error.agent.askOutsideTask"));
    }
    const asker =
      invocation.requesterType === "human"
        ? `@${invocation.requesterName} `
        : (() => {
            // 委派链上的子任务：问链条源头的人，没有就不 @ 任何人，靠「等回答」收件箱提醒
            const root = [invocation, ...database.invocationAncestors(invocation.id)].find(
              (item) => item.requesterType === "human",
            );
            return root ? `@${root.requesterName} ` : "";
          })();
    const questionText = serverText("question.ask", {
      asker,
      question: quoteWithoutMentions(input.question, LIMITS.maxMessageLength - 2_000),
      choices: spec
        ? serverText("question.choices", {
            mode: serverText(spec.multiple ? "question.multiple" : "question.single"),
            options: spec.options
              .map((option) => `${option.key}. ${quoteWithoutMentions(option.label, 100)}`)
              .join("\n"),
          })
        : "",
      hint: serverText(spec ? "question.hintOptions" : "question.hintReply", {
        agent: agent.username,
      }),
    });
    const { message } = createAndDispatchMessage(
      agent,
      {
        // 问题里的 @ 换成全角：提问只发给人，不能借机唤醒其他 Agent
        // 选项也逐行写进正文：不渲染选项的客户端和 Agent 读正文就能看懂、照样能手打回答
        content: zhText(questionText),
        text: questionText,
        clientMessageId: input.clientMessageId,
        parentMessageId: parent.id,
        kind: "question",
        ...(spec ? { question: spec } : {}),
      },
      { inferredParent: true },
    );
    const updated = emitInvocation(
      database.updateInvocation(invocation.id, {
        status: "waiting_human",
        progress: null,
        detail: serverText("invocation.waitingAnswer", {
          question: input.question.replace(/\s+/g, " ").slice(0, 440),
        }),
      }),
    );
    return { invocation: updated, message };
  }

  /**
   * Agent 执行中申请权限（Codex 的命令 / 改文件审批、MCP 确认、ACP 权限、Claude 的工具许可）：
   * 发一条带「允许 / 拒绝」的提问给任务源头的人，人点了或回复了，结果直接交回正在跑的这一轮。
   * 只在内存里：Server 重启或超过 LIMITS.approvalTimeoutMs 都按拒绝，Agent 那边同样会超时拒绝。
   */
  type PendingApproval = {
    requestId: string;
    roomId: string;
    agentId: string;
    agentName: string;
    invocationId: string;
    questionId: string;
    timer: NodeJS.Timeout;
  };

  function requestApproval(
    agent: Participant,
    event: Extract<ClientEvent, { type: "approval.request" }>,
  ): void {
    if (approvals.has(event.requestId)) return;
    const deny = (reason: string) => {
      const target = onlineAgent(agent.roomId, agent.username);
      if (target) {
        send(target.socket, {
          type: "approval.decision",
          requestId: event.requestId,
          allow: false,
          reason,
        });
      }
    };
    const invocation = database.getInvocationFor(event.messageId, agent.id);
    if (!invocation || !["running", "waiting_human"].includes(invocation.status)) {
      deny("这一轮已经不在执行，申请作废。");
      return;
    }
    const root = [invocation, ...database.invocationAncestors(invocation.id)].find(
      (item) => item.requesterType === "human",
    );
    const minutes = Math.round(LIMITS.approvalTimeoutMs / 60_000);
    const approvalText = serverText("approval.request", {
      asker: root ? `@${root.requesterName} ` : "",
      agent: agent.username,
      tool: quoteWithoutMentions(event.tool, 64),
      summary: quoteWithoutMentions(event.summary, 1000),
      detail: event.detail ? `\n${quoteWithoutMentions(event.detail, 4000)}` : "",
      minutes,
    });
    let question: ChatMessage;
    try {
      question = createAndDispatchMessage(
        agent,
        {
          content: zhText(approvalText),
          text: approvalText,
          clientMessageId: `approval-${event.requestId}`,
          parentMessageId: event.messageId,
          kind: "question",
          question: {
            options: [
              { key: "A", label: "允许" },
              { key: "B", label: "拒绝" },
            ],
            multiple: false,
          },
          approval: { requestId: event.requestId, tool: event.tool },
        },
        { inferredParent: true },
      ).message;
    } catch (error) {
      deny(`没能把申请发给人：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const timer = setTimeout(
      () => settleApproval(event.requestId, "expired"),
      LIMITS.approvalTimeoutMs,
    );
    timer.unref?.();
    approvals.set(event.requestId, {
      requestId: event.requestId,
      roomId: agent.roomId,
      agentId: agent.id,
      agentName: agent.username,
      invocationId: invocation.id,
      questionId: question.id,
      timer,
    });
    approvalByQuestion.set(question.id, event.requestId);
    if (!isTerminal(invocation)) {
      emitInvocation(
        database.updateInvocation(invocation.id, {
          progress: serverText("invocation.approvalWaiting", {
            summary: event.summary.replace(/\s+/g, " ").slice(0, 160),
          }),
        }),
      );
    }
  }

  function settleApproval(
    requestId: string,
    state: "allowed" | "denied" | "expired",
    by?: string,
  ): void {
    const pending = approvals.get(requestId);
    if (!pending) return;
    approvals.delete(requestId);
    approvalByQuestion.delete(pending.questionId);
    clearTimeout(pending.timer);
    const target = onlineAgent(pending.roomId, pending.agentName);
    if (target) {
      send(target.socket, {
        type: "approval.decision",
        requestId,
        allow: state === "allowed",
        ...(state === "denied"
          ? { reason: `${by ?? "人"} 拒绝了这个申请。` }
          : state === "expired"
            ? { reason: "没人在时限内批准，按拒绝处理。" }
            : {}),
      });
    }
    broadcast(pending.roomId, {
      type: "approval.updated",
      roomId: pending.roomId,
      messageId: pending.questionId,
      state,
    });
    const invocation = database.getInvocation(pending.invocationId);
    if (invocation && !isTerminal(invocation) && invocation.progress?.startsWith("等你批准")) {
      emitInvocation(database.updateInvocation(invocation.id, { progress: null }));
    }
  }

  /** 回复里选的是允许还是拒绝；看不出来时返回 undefined（当普通消息处理） */
  function approvalChoice(message: ChatMessage): boolean | undefined {
    if (message.answer) {
      if (message.answer.selected.includes("A")) return true;
      if (message.answer.selected.includes("B")) return false;
      return undefined;
    }
    const text = message.content.trim().toLocaleLowerCase();
    // 拒绝看开头就够（宁可拒）；允许必须整条就是一个「允许」，「可以，但先别删」这种带条件的不当成批准
    if (/^(?:b|拒绝|不行|不允许|不可以|不同意|不|no|n|deny|reject)(?:$|[\s，。,.!！])/.test(text))
      return false;
    if (
      /^(?:a|允许|同意|批准|可以|行|好|yes|y|ok|okay|approve|approved|allow|allowed)[\s，。,.!！]*$/.test(
        text,
      )
    )
      return true;
    return undefined;
  }

  /** 房主（非访客）都能批；访客只能批自己带入的 Agent 的申请 */
  function canApprove(human: Participant, pending: PendingApproval): boolean {
    const guest = guestSessionOf(human);
    if (!guest) return true;
    if (guest.state !== "active") return false;
    const agent = database.getParticipant(pending.agentId);
    const agentGuest = agent ? guestSessionOf(agent) : undefined;
    return agentGuest?.sponsor?.id === guest.session.id;
  }

  /** Server 所在电脑的时区：Agent 没指定时区时，定时任务按它显示 */
  const serverTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  function validTimeZone(timeZone: string): boolean {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
      return true;
    } catch {
      return false;
    }
  }

  /** 例如「2026-11-04 00:07（Asia/Shanghai）」：绝对时间加时区，人一眼能看出是不是自己要的那天 */
  /** 计划时间：时间本身和语言无关，时区的括号随语言 */
  function scheduleTime(iso: string, timeZone: string): ServerText {
    return serverText("schedule.time", {
      time: formatScheduleTime(iso, timeZone).replace(/（.*$/, ""),
      timeZone,
    });
  }

  /** 引用到回执里的说明：中文原文照旧去掉 @，结构化文案里的字符串参数也一样 */
  function quoteParam(value: ServerTextParam, limit: number): ServerTextParam {
    if (typeof value === "number") return value;
    if (typeof value === "string") return quoteWithoutMentions(value, limit);
    return {
      key: value.key,
      ...(value.params
        ? {
            params: Object.fromEntries(
              Object.entries(value.params).map(([name, param]) => [name, quoteParam(param, limit)]),
            ),
          }
        : {}),
    } as ServerTextParam;
  }

  function quotedDetail(invocation: Invocation, limit: number): ServerTextParam {
    return quoteParam(invocation.detailText ?? invocation.detail ?? "", limit);
  }

  /** 错误的原因：HiveError 带结构化文案就用它，其余用原文 */
  function errorReason(error: unknown): ServerTextParam {
    if (error instanceof HiveError && error.text) return error.text;
    return error instanceof Error ? error.message : String(error);
  }

  /** Bridge 上报的说明：带结构化文案就用它（中文 detail 照旧写进兼容字段） */
  function reportDetail(
    report: { detail?: string | undefined; detailText?: WireServerText | undefined },
    limit = 500,
  ): ServerText | string | undefined {
    if (report.detailText && isServerTextKey(report.detailText.key)) {
      return report.detailText as ServerText;
    }
    return report.detail?.slice(0, limit);
  }

  function formatScheduleTime(iso: string, timeZone: string): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(iso));
    const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}（${timeZone}）`;
  }

  function emitSchedule(schedule: Schedule): Schedule {
    broadcast(schedule.roomId, { type: "schedule.updated", schedule });
    return schedule;
  }

  /**
   * hive_schedule_create：在处理某条消息的过程中登记一个一次性定时任务。
   * 发起人取委派链源头的人，到点后以其名义（标明 Hive 代发）发出触发消息、走普通的调用链路；
   * 只能唤醒创建者自己，正文里的 @ 一律转义。定时任务触发的执行里不能再创建定时任务，避免自我续命；
   * 要重复执行就在创建时给 everyMinutes + until，由服务端到点后一次接一次地登记下去。
   */
  function createSchedule(
    agent: Participant,
    input: {
      runAt: string;
      task: string;
      timeZone?: string;
      clientMessageId: string;
      everyMinutes?: number;
      until?: string;
    },
  ) {
    const parent = inferExecutingParent(agent);
    const invocation = parent ? database.getInvocationFor(parent.id, agent.id) : undefined;
    if (!parent || !invocation || invocation.status === "cancelling") {
      throw new HiveError("NOT_EXECUTING", serverText("error.schedule.outsideTask"));
    }
    const existing = database.createScheduleLookup(agent.id, input.clientMessageId);
    if (existing) return { schedule: existing, created: false };
    const chain = [invocation, ...database.invocationAncestors(invocation.id)];
    if (chain.some((item) => database.getMessage(item.messageId)?.kind === "schedule")) {
      throw new HiveError("SCHEDULE_NESTED", serverText("error.schedule.nested"));
    }
    const root = chain.find((item) => item.requesterType === "human");
    const requester = root?.requesterId ? database.getParticipant(root.requesterId) : undefined;
    if (!requester || requester.type !== "human" || requester.roomId !== agent.roomId) {
      throw new HiveError("NO_HUMAN_REQUESTER", serverText("error.schedule.humanOnly"));
    }
    const guest = guestSessionOf(requester);
    if (guest && guest.state !== "active") {
      throw new HiveError("REQUESTER_EXPIRED", serverText("error.schedule.requesterExpired"));
    }
    const task = input.task.trim();
    if (!task || task.length > LIMITS.maxScheduleTaskLength) {
      throw new HiveError(
        "INVALID_TASK",
        serverText("error.schedule.taskLength", { max: LIMITS.maxScheduleTaskLength }),
      );
    }
    // 只收带时区偏移的绝对时间：「今晚 00:07」这类说法换算成哪一天，必须由 Agent 明确写出来
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i.test(input.runAt)) {
      throw new HiveError("INVALID_RUN_AT", serverText("error.schedule.runAtFormat"));
    }
    const runAtMs = Date.parse(input.runAt);
    const now = clock();
    if (!Number.isFinite(runAtMs)) {
      throw new HiveError("INVALID_RUN_AT", serverText("error.schedule.runAtInvalid"));
    }
    if (runAtMs < now + 30_000) {
      throw new HiveError(
        "INVALID_RUN_AT",
        serverText("error.schedule.runAtTooSoon", {
          now: formatScheduleTime(new Date(now).toISOString(), serverTimeZone),
        }),
      );
    }
    if (runAtMs > now + LIMITS.maxScheduleAheadMs) {
      throw new HiveError(
        "INVALID_RUN_AT",
        serverText("error.schedule.runAtTooFar", {
          days: Math.round(LIMITS.maxScheduleAheadMs / 86_400_000),
        }),
      );
    }
    let recurrence:
      { everyMinutes: number; until: string; seriesId: string; occurrence: number } | undefined;
    if (input.everyMinutes !== undefined || input.until !== undefined) {
      const every = input.everyMinutes;
      if (
        every === undefined ||
        !Number.isInteger(every) ||
        every < LIMITS.minScheduleIntervalMinutes ||
        every > 7 * 24 * 60
      ) {
        throw new HiveError(
          "INVALID_INTERVAL",
          serverText("error.schedule.intervalRange", {
            min: LIMITS.minScheduleIntervalMinutes,
            max: 7 * 24 * 60,
          }),
        );
      }
      if (!input.until || !/(Z|[+-]\d{2}:\d{2})$/i.test(input.until)) {
        throw new HiveError("INVALID_UNTIL", serverText("error.schedule.untilRequired"));
      }
      const untilMs = Date.parse(input.until);
      if (!Number.isFinite(untilMs) || untilMs < runAtMs) {
        throw new HiveError("INVALID_UNTIL", serverText("error.schedule.untilBeforeRunAt"));
      }
      if (untilMs > now + LIMITS.maxScheduleAheadMs) {
        throw new HiveError(
          "INVALID_UNTIL",
          serverText("error.schedule.untilTooFar", {
            days: Math.round(LIMITS.maxScheduleAheadMs / 86_400_000),
          }),
        );
      }
      const occurrences = Math.floor((untilMs - runAtMs) / (every * 60_000)) + 1;
      if (occurrences > LIMITS.maxScheduleOccurrences) {
        throw new HiveError(
          "TOO_MANY_OCCURRENCES",
          serverText("error.schedule.tooManyOccurrences", {
            count: occurrences,
            max: LIMITS.maxScheduleOccurrences,
          }),
        );
      }
      recurrence = {
        everyMinutes: every,
        until: new Date(untilMs).toISOString(),
        seriesId: randomUUID(),
        occurrence: 1,
      };
    }
    const timeZone = input.timeZone?.trim() || serverTimeZone;
    if (!validTimeZone(timeZone)) {
      throw new HiveError("INVALID_TIME_ZONE", serverText("error.schedule.timeZone", { timeZone }));
    }
    if (database.countActiveSchedules(agent.roomId) >= LIMITS.maxActiveSchedulesPerRoom) {
      throw new HiveError(
        "SCHEDULE_LIMIT",
        serverText("error.schedule.roomLimit", { max: LIMITS.maxActiveSchedulesPerRoom }),
      );
    }
    const { schedule, created } = database.createSchedule({
      roomId: agent.roomId,
      agent,
      requester,
      origin: parent,
      clientId: input.clientMessageId,
      task,
      runAt: new Date(runAtMs).toISOString(),
      timeZone,
      ...(recurrence ? { recurrence } : {}),
    });
    if (created) {
      emitSchedule(schedule);
      armScheduleTimer();
    }
    return { schedule, created };
  }

  /**
   * hive_room_create：Agent 替房主新建房间。只认房主本人发起的任务（访客发起的、Agent 之间的对话都不行），
   * Agent 自己也不能是访客带入的；建房间本来就只有房主能做，这里不扩大谁能建。
   */
  /**
   * 房主本人发起、Agent 正在执行的任务：返回执行中的触发消息和发起的房主。
   * 访客带入的 Agent、访客发起的任务、源头不是人的 Agent 对话一律拒绝——跨房间的操作只替房主做。
   */
  function ownerTask(agent: Participant, action: ServerText) {
    if (guestSessionOf(agent)) {
      throw new HiveError("FORBIDDEN", serverText("error.room.guestAgentForbidden", { action }));
    }
    const parent = inferExecutingParent(agent);
    const invocation = parent ? database.getInvocationFor(parent.id, agent.id) : undefined;
    if (!parent || !invocation || invocation.status === "cancelling") {
      throw new HiveError("NOT_EXECUTING", serverText("error.room.outsideTask", { action }));
    }
    const chain = [invocation, ...database.invocationAncestors(invocation.id)];
    const root = chain.find((item) => item.requesterType === "human");
    const requester = root?.requesterId ? database.getParticipant(root.requesterId) : undefined;
    if (!requester || requester.type !== "human" || guestSessionOf(requester)) {
      throw new HiveError("OWNER_ONLY", serverText("error.room.ownerTaskOnly", { action }));
    }
    return { parent, requester };
  }

  function createRoomForAgent(
    agent: Participant,
    input: { id: string; name?: string; workspace?: string },
  ): RoomSummary {
    const { requester } = ownerTask(agent, serverText("action.createRoom"));
    try {
      const room = withBranch(
        database.createRoom({
          id: input.id,
          ...(input.name ? { name: input.name } : {}),
          createdBy: requester.username,
          ...(input.workspace ? { workspace: roomWorkspace(input.workspace) } : {}),
        }),
      );
      broadcastAll({ type: "rooms.changed", room });
      return room;
    } catch (error) {
      if (error instanceof HiveError && error.code.startsWith("LOCAL_AGENT_CWD")) {
        throw new HiveError("ROOM_WORKSPACE_INVALID", error.message);
      }
      throw error;
    }
  }

  /**
   * hive_room_post：替房主到另一个房间给那里的 Agent 派活。以调用者自己（同名 Agent）在那个房间发言，
   * 开一条新的传递链；只在房主本人发起的任务里能用。那个房间里的后续对话源头不是人，
   * 那边的 Agent 就不能再借这个工具往别的房间转，不会跨房间互相派个没完。
   * 刚建的房间 Agent 要几秒才进来：等到消息里 @ 到的 Agent 都进了房间再发，最多等 20 秒。
   */
  async function postToRoomForAgent(
    agent: Participant,
    input: { roomId: string; content: string; clientMessageId: string },
  ): Promise<ChatMessage> {
    const { parent, requester } = ownerTask(agent, serverText("action.postToRoom"));
    const room = database.getRoom(input.roomId);
    if (!room || room.archivedAt) {
      throw new HiveError(
        "ROOM_NOT_FOUND",
        serverText("error.room.targetNotFound", { room: input.roomId }),
      );
    }
    if (room.id === agent.roomId) {
      throw new HiveError("SAME_ROOM", serverText("error.room.samePost"));
    }
    const mentions = parseMentions(input.content);
    if (mentions.length === 0) {
      throw new HiveError("NO_MENTION", serverText("error.room.postNeedsMention"));
    }
    const deadline = clock() + 20_000;
    const missing = () =>
      mentions.filter((name) => {
        if (name.toLocaleLowerCase() === "all") return false;
        const target = database.findParticipant(room.id, name);
        return !target || (target.type === "agent" && !onlineAgent(room.id, target.username));
      });
    let sender = database.findParticipant(room.id, agent.username);
    while ((!sender || missing().length > 0) && clock() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      sender = database.findParticipant(room.id, agent.username);
    }
    if (!sender || sender.type !== "agent") {
      throw new HiveError("NOT_IN_ROOM", serverText("error.room.notJoined", { room: room.id }));
    }
    const absent = missing();
    if (absent.length > 0) {
      throw new HiveError(
        "AGENT_NOT_FOUND",
        serverText("error.room.agentsAbsent", { room: room.id, agents: absent.join("、") }),
      );
    }
    const forwarded = serverText("roomPost.forwarded", {
      content: input.content.trim(),
      agent: agent.username,
      room: agent.roomId,
      seq: parent.seq,
      requester: requester.username,
    });
    const { message } = createAndDispatchMessage(sender, {
      content: zhText(forwarded),
      text: forwarded,
      clientMessageId: input.clientMessageId,
    });
    return message;
  }

  /**
   * 执行中途发给人看的进度：挂在正在执行的触发消息下，不算这一轮的回复（不推进调用），
   * 也不唤醒其他 Agent。人发起的任务每个最多 LIMITS.maxProgressPerTask 条，Agent 之间委派的 1 条。
   */
  function sendProgress(
    agent: Participant,
    input: {
      content: string;
      clientMessageId: string;
      parentMessageId?: string;
      replyToMessageId?: string;
    },
  ): ChatMessage {
    const existing = database.findMessageByClientId(agent.id, input.clientMessageId);
    if (existing) return existing;
    const parent = input.parentMessageId
      ? database.getMessage(input.parentMessageId)
      : inferExecutingParent(agent);
    const invocation = parent ? database.getInvocationFor(parent.id, agent.id) : undefined;
    if (!parent || !invocation || !["running", "waiting_human"].includes(invocation.status)) {
      throw new HiveError("NOT_EXECUTING", serverText("error.progress.outsideTask"));
    }
    // 进度不派发 @：@ 到 Agent 看起来像派了活、其实没人接，直接拒绝；@ 人照常（会提醒到他）
    const agents = parseMentions(input.content).filter(
      (name) => database.findParticipant(agent.roomId, name)?.type === "agent",
    );
    if (agents.length > 0) {
      throw new HiveError(
        "PROGRESS_MENTIONS_AGENT",
        serverText("error.progress.mentionsAgent", {
          agents: agents.map((name) => `@${name}`).join("、"),
        }),
      );
    }
    // 人直接派的任务放宽；Agent 之间委派的子任务只给一条，免得互相刷屏。
    // 按这一轮执行计数：合批时这一轮的几条触发消息共用名额，换个 parent 也绕不过去
    const limit = invocation.requesterType === "human" ? LIMITS.maxProgressPerTask : 1;
    const batch = database
      .listExecutingInvocations(agent.id)
      .filter((item) => item.roomId === agent.roomId);
    const used = batch.reduce((sum, item) => sum + database.progressCount(item.id), 0);
    if (used >= limit) {
      throw new HiveError("PROGRESS_LIMIT", serverText("error.progress.limit", { limit }));
    }
    database.setProgressCount(invocation.id, database.progressCount(invocation.id) + 1);
    return createAndDispatchMessage(
      agent,
      {
        content: input.content,
        clientMessageId: input.clientMessageId,
        parentMessageId: parent.id,
        ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
        kind: "progress",
      },
      { fromTool: true },
    ).message;
  }

  /** 状态行上显示进度正文的第一行 */
  function oneLineProgress(content: string): string {
    const line = content.trim().split(/\r?\n/)[0]!.replace(/\s+/g, " ");
    return line.length > 40 ? `${line.slice(0, 39)}…` : line;
  }

  function cancelSchedule(actor: Participant, scheduleId: string): Schedule {
    const schedule = database.getSchedule(scheduleId);
    if (!schedule || schedule.roomId !== actor.roomId) {
      throw new HiveError("SCHEDULE_NOT_FOUND", serverText("error.schedule.notFound"));
    }
    if (actor.type === "agent" && schedule.agentId !== actor.id) {
      throw new HiveError("FORBIDDEN", serverText("error.schedule.ownOnly"));
    }
    const cancelled = database.transitionSchedule(scheduleId, ["scheduled"], "cancelled", {
      cancelledBy: actor.username,
      detail: serverText("schedule.cancelledBy", { name: actor.username }),
    });
    if (!cancelled) {
      throw new HiveError(
        "SCHEDULE_NOT_PENDING",
        serverText(
          schedule.status === "firing" || schedule.status === "fired"
            ? "error.schedule.alreadyFired"
            : "error.schedule.ended",
        ),
      );
    }
    emitSchedule(cancelled);
    armScheduleTimer();
    return cancelled;
  }

  /**
   * 到点：原子地认领后，以发起人名义发出触发消息并照常派发给执行的 Agent。
   * 触发消息带固定的幂等键：发出途中崩溃，重启后的扫描按同一个键补完，不会发出两条。
   * 晚于宽限期才轮到（Server 当时没在运行）就标为已错过，不自动补跑——定时任务大多带副作用。
   */
  function fireSchedule(scheduleId: string): void {
    if (shuttingDown) return;
    let schedule = database.getSchedule(scheduleId);
    if (!schedule) return;
    if (schedule.status === "scheduled") {
      const late = clock() - Date.parse(schedule.runAt);
      if (late < 0) return;
      // 周期任务：到点就把下一次登记好，这一次不论执行、跳过还是错过，周期都接着走
      if (schedule.everyMinutes) armNextOccurrence(schedule);
      // 上一次还没做完：跳过这一次，不叠着跑；也不补发说明（每次都发会刷屏）
      const busy = schedule.seriesId ? previousOccurrenceRunning(schedule) : undefined;
      if (busy) {
        const skipped = database.transitionSchedule(scheduleId, ["scheduled"], "missed", {
          detail: serverText("schedule.skippedBusy", { occurrence: busy.occurrence ?? "?" }),
        });
        if (skipped) {
          database.markScheduleReported(scheduleId);
          emitSchedule(skipped);
        }
        return;
      }
      if (late > LIMITS.scheduleGraceMs) {
        const missed = database.transitionSchedule(scheduleId, ["scheduled"], "missed", {
          detail: serverText("schedule.missedOffline", { minutes: Math.round(late / 60_000) }),
        });
        if (missed) {
          emitSchedule(missed);
          reportSchedule(scheduleId);
        }
        return;
      }
      const claimed = database.transitionSchedule(scheduleId, ["scheduled"], "firing");
      if (!claimed) return;
      schedule = emitSchedule(claimed);
    }
    if (schedule.status !== "firing") return;
    const fail = (detail: ServerText) => {
      const failed = database.transitionSchedule(scheduleId, ["firing"], "failed", { detail });
      if (failed) {
        emitSchedule(failed);
        reportSchedule(scheduleId);
      }
    };
    const requester = database.getParticipant(schedule.requesterId);
    const agent = database.getParticipant(schedule.agentId);
    if (!requester || !agent || requester.roomId !== schedule.roomId) {
      return fail(serverText("schedule.memberGone"));
    }
    // 到点重新核对权限：定时触发不能当成人的新授权
    const guest = guestSessionOf(requester);
    if (guest && guest.state !== "active") return fail(serverText("schedule.requesterExpired"));
    const clientMessageId = `schedule-${schedule.id}`;
    let message = database.findMessageByClientId(requester.id, clientMessageId);
    // 发出途中停机、很久以后才重启：触发消息还没写入就按错过处理，同样不自动补跑
    const late = clock() - Date.parse(schedule.runAt);
    if (!message && late > LIMITS.scheduleGraceMs) {
      const missed = database.transitionSchedule(scheduleId, ["firing"], "missed", {
        detail: serverText("schedule.missedInFlight", { minutes: Math.round(late / 60_000) }),
      });
      if (missed) {
        emitSchedule(missed);
        reportSchedule(scheduleId);
      }
      return;
    }
    if (!message) {
      const origin = database.getMessage(schedule.originMessageId);
      const text = serverText("schedule.trigger", {
        agent: agent.username,
        originSeq: schedule.originSeq,
        runAt: scheduleTime(schedule.runAt, schedule.timeZone),
        recurrence:
          schedule.everyMinutes && schedule.until
            ? serverText("schedule.recurrence", {
                minutes: schedule.everyMinutes,
                occurrence: schedule.occurrence ?? 1,
                until: scheduleTime(schedule.until, schedule.timeZone),
              })
            : "",
        requester: requester.username,
        task: quoteWithoutMentions(schedule.task, LIMITS.maxScheduleTaskLength + 200),
        seriesHint: schedule.everyMinutes ? serverText("schedule.seriesHint") : "",
        id: schedule.id,
      });
      const content = zhText(text);
      try {
        message = createAndDispatchMessage(requester, {
          content,
          text,
          clientMessageId,
          kind: "schedule",
          ...(origin && !origin.deletedAt && origin.roomId === schedule.roomId
            ? { replyToMessageId: origin.id }
            : {}),
        }).message;
      } catch (error) {
        app.log.warn({ err: error, scheduleId }, "schedule trigger failed");
        if (error instanceof HiveError) {
          fail(serverText("schedule.triggerFailed", { reason: errorReason(error) }));
        }
        return;
      }
    }
    let invocation = database.getInvocationFor(message.id, agent.id);
    if (!invocation) {
      // 消息写入后、派发前中断过：补建调用并投递（幂等，同一条消息对同一个 Agent 只有一条调用）
      invocation = emitInvocation(
        database.createInvocation({ message, agent, status: "queued" }).invocation,
      );
      deliverMention(message, agent);
    }
    const fired = database.transitionSchedule(scheduleId, ["firing"], "fired", {
      triggerMessageId: message.id,
      invocationId: invocation.id,
      firedAt: new Date(clock()).toISOString(),
    });
    if (fired) emitSchedule(fired);
    if (CONTINUATION_READY_STATUSES.includes(invocation.status)) reportSchedule(scheduleId);
  }

  /** 周期任务的下一次：按间隔往后排到当前时间之后（停机错过的几次不补跑），超过 until 就结束 */
  function armNextOccurrence(schedule: Schedule): void {
    if (!schedule.everyMinutes || !schedule.until || !schedule.seriesId) return;
    const step = schedule.everyMinutes * 60_000;
    let next = Date.parse(schedule.runAt) + step;
    let occurrence = (schedule.occurrence ?? 1) + 1;
    while (next <= clock()) {
      next += step;
      occurrence += 1;
    }
    if (next > Date.parse(schedule.until) || occurrence > LIMITS.maxScheduleOccurrences) return;
    const agent = database.getParticipant(schedule.agentId);
    const requester = database.getParticipant(schedule.requesterId);
    const origin = database.getMessage(schedule.originMessageId);
    if (!agent || !requester || !origin) return;
    const { schedule: created, created: isNew } = database.createSchedule({
      roomId: schedule.roomId,
      agent,
      requester,
      origin,
      clientId: `${schedule.seriesId}#${occurrence}`,
      task: schedule.task,
      runAt: new Date(next).toISOString(),
      timeZone: schedule.timeZone,
      recurrence: {
        everyMinutes: schedule.everyMinutes,
        until: schedule.until,
        seriesId: schedule.seriesId,
        occurrence,
      },
    });
    if (isNew) emitSchedule(created);
  }

  /** 同一个周期里，上一次发出的那次还在执行（排队、执行中、停止中、提问后这一轮没结束） */
  function previousOccurrenceRunning(schedule: Schedule): Schedule | undefined {
    return database
      .listSeriesSchedules(schedule.seriesId!)
      .filter((item) => item.id !== schedule.id && item.status === "fired" && item.invocationId)
      .find((item) => {
        const invocation = database.getInvocation(item.invocationId!);
        return (
          invocation &&
          (["queued", "running", "cancelling"].includes(invocation.status) ||
            (invocation.status === "waiting_human" && !invocation.finishedAt))
        );
      });
  }

  /**
   * 定时任务没有正常结果时，由服务端代执行的 Agent 补一条说明并 @ 发起人：
   * 错过、发不出去、执行失败、结果未知、或 Agent 只回了 NO_REPLY。
   * 正常回复、或被人停止（人自己知道）不补发。说明带固定幂等键，发出后才记已补发，失败由扫描重试。
   */
  function reportSchedule(scheduleId: string): void {
    const schedule = database.getSchedule(scheduleId);
    if (!schedule || !database.isScheduleUnreported(scheduleId)) return;
    let status: ServerText | string;
    let detail: ServerTextParam | undefined = schedule.detailText ?? schedule.detail;
    let parentMessageId: string | undefined;
    if (schedule.status === "fired") {
      const invocation = schedule.invocationId
        ? database.getInvocation(schedule.invocationId)
        : undefined;
      if (!invocation || invocation.status === "cancelled") {
        database.markScheduleReported(scheduleId);
        return;
      }
      if (!CONTINUATION_READY_STATUSES.includes(invocation.status)) return;
      if (invocation.status === "completed" && invocation.replyMessageId) {
        database.markScheduleReported(scheduleId);
        return;
      }
      status =
        invocation.status === "completed"
          ? serverText("schedule.status.noReply")
          : (continuationOutcome[invocation.status] ?? invocation.status);
      detail = invocation.detailText ?? invocation.detail;
      parentMessageId = schedule.triggerMessageId;
    } else if (schedule.status === "missed") {
      status = serverText("schedule.status.missed");
    } else if (schedule.status === "failed") {
      status = serverText("schedule.status.failed");
    } else {
      return;
    }
    const agent = database.getParticipant(schedule.agentId);
    if (!agent) {
      database.markScheduleReported(scheduleId);
      return;
    }
    const text = serverText("schedule.report", {
      requester: schedule.requesterName,
      agent: agent.username,
      status,
      runAt: scheduleTime(schedule.runAt, schedule.timeZone),
      task: quoteWithoutMentions(schedule.task, 300),
      note: detail ? serverText("receipt.note", { note: quoteParam(detail, 500) }) : "",
      id: schedule.id,
    });
    const post = (parent: string | undefined) =>
      createAndDispatchMessage(
        agent,
        {
          content: zhText(text),
          text,
          clientMessageId: `schedule-report-${schedule.id}`,
          ...(parent ? { parentMessageId: parent } : {}),
          kind: "receipt",
        },
        { receipt: true },
      );
    try {
      try {
        post(parentMessageId);
      } catch (error) {
        // 挂不到触发消息下（链条到顶、消息已不在）就单独发一条，说明不能因此丢掉
        if (
          parentMessageId &&
          error instanceof HiveError &&
          ["HOP_LIMIT", "TRACE_LIMIT", "PARENT_NOT_FOUND"].includes(error.code)
        ) {
          post(undefined);
        } else {
          throw error;
        }
      }
      database.markScheduleReported(scheduleId);
    } catch (error) {
      // 限流等暂时性错误：留给扫描重试
      app.log.warn({ err: error, scheduleId }, "schedule report failed");
    }
  }

  let scheduleTimer: NodeJS.Timeout | undefined;
  /** 按最近一个待执行的时间定一个闹钟；最多一分钟复查一次，系统睡眠、改时间后也能很快对上 */
  function armScheduleTimer(): void {
    if (scheduleTimer) clearTimeout(scheduleTimer);
    scheduleTimer = undefined;
    if (shuttingDown) return;
    const next = database.nextScheduleRunAt();
    if (next === undefined) return;
    scheduleTimer = setTimeout(runSchedules, Math.min(Math.max(next - clock(), 0), 60_000));
    scheduleTimer.unref();
  }

  /** 到点的发出去；发出途中中断的补完；该补发说明的补发 */
  function runSchedules(): void {
    if (shuttingDown) return;
    // 每个任务单独兜住：一个出错不能让同一轮其余的到点任务和补发说明都跳过
    const each = (schedules: Schedule[], step: (id: string) => void) => {
      for (const schedule of schedules) {
        try {
          step(schedule.id);
        } catch (error) {
          app.log.warn({ err: error, scheduleId: schedule.id }, "schedule sweep failed");
        }
      }
    };
    try {
      each(database.listFiringSchedules(), fireSchedule);
      each(database.listDueSchedules(clock()), fireSchedule);
      each(database.listUnreportedSchedules(), reportSchedule);
    } catch (error) {
      app.log.warn({ err: error }, "schedule sweep failed");
    }
    armScheduleTimer();
  }

  function invocationInRoom(participant: Participant, invocationId: string): Invocation {
    const invocation = database.getInvocation(invocationId);
    if (!invocation || invocation.roomId !== participant.roomId) {
      throw new HiveError("INVOCATION_NOT_FOUND", serverText("error.invocation.notInRoom"));
    }
    return invocation;
  }

  function resetForRedelivery(invocation: Invocation, detail: ServerText): Invocation {
    // 重新执行是新的一次：进度名额重新算
    database.setProgressCount(invocation.id, 0);
    return database.updateInvocation(invocation.id, {
      status: "queued",
      attempts: invocation.attempts + 1,
      blockReason: null,
      detail,
      progress: null,
      runtime: null,
      replyMessageId: null,
      receivedAt: null,
      startedAt: null,
      finishedAt: null,
    });
  }

  function retryInvocation(actor: Participant, invocationId: string): void {
    const invocation = invocationInRoom(actor, invocationId);
    // 结果未知或停止未确认时，上一次执行可能仍在进行；此时重试会让同一任务并行跑两份
    if (invocation.status === "timed_out" || invocation.status === "cancelling") {
      throw new HiveError("INVOCATION_NOT_RETRYABLE", serverText("error.invocation.mayStillRun"));
    }
    const retryable =
      invocation.status === "failed" ||
      invocation.status === "cancelled" ||
      (invocation.status === "blocked" && invocation.blockReason !== "hop_limit");
    if (!retryable) {
      throw new HiveError("INVOCATION_NOT_RETRYABLE", serverText("error.invocation.notRetryable"));
    }
    const message = database.getMessage(invocation.messageId);
    const agent = database.getParticipant(invocation.agentId);
    if (!message || message.deletedAt || !agent) {
      throw new HiveError("INVOCATION_NOT_RETRYABLE", serverText("error.invocation.triggerGone"));
    }
    emitInvocation(
      resetForRedelivery(
        invocation,
        serverText(
          invocation.blockReason === "guest_approval"
            ? "invocation.approved"
            : "invocation.retryRequested",
          { name: actor.username },
        ),
      ),
    );
    deliverMention(message, agent, true);
  }

  /**
   * 撤回并停止：只停这条消息直接派出的任务，它们引出的下游子任务不连带停。
   * 排队中、被拦下的直接取消；执行中、等人回答的按「停止」处理（Agent 把几条合在一轮里做时，
   * 它只丢掉撤回的这条、其余照常做完）。
   */
  function stopRecalledTasks(actor: Participant, message: ChatMessage): void {
    for (const invocation of database.invocationsForMessage(message.id)) {
      if (isTerminal(invocation) || invocation.roomId !== actor.roomId) continue;
      // 消息已经撤回成功：某一条停不下来（例如并发下已被别处结束）不能让撤回报错，也不能挡住其余几条
      try {
        stopRecalledTask(actor, message, invocation);
      } catch (error) {
        app.log.warn({ err: error, invocationId: invocation.id }, "撤回时停止任务失败");
      }
    }
  }

  function stopRecalledTask(
    actor: Participant,
    message: ChatMessage,
    invocation: Invocation,
  ): void {
    // Agent 已经收到的排队任务可能马上就开始：和执行中一样请它停，等它确认，不在这边直接判成没执行
    const delivered = invocation.status === "queued" && invocation.receivedAt;
    if ((invocation.status === "queued" && !delivered) || invocation.status === "blocked") {
      emitInvocation(
        database.updateInvocation(invocation.id, {
          status: "cancelled",
          finishedAt: new Date().toISOString(),
          progress: null,
          detail: serverText("invocation.recalledNotRun"),
        }),
      );
      const target = onlineAgent(invocation.roomId, invocation.agentName);
      if (target) send(target.socket, { type: "agent.cancel", messageId: message.id });
      return;
    }
    cancelInvocation(actor, invocation.id, serverText("invocation.reasonRecalled"));
  }

  /**
   * 停止调用。尚未开始执行的直接给出终态；已开始的进入 cancelling，等 Agent 回报结束才算停下，
   * 期间不允许重试。状态落库，服务端重启或 Agent 断线后仍保持，Agent 重连时会再次收到停止请求。
   */
  function cancelInvocation(actor: Participant, invocationId: string, reason?: ServerText): void {
    const invocation = invocationInRoom(actor, invocationId);
    if (isTerminal(invocation)) return;
    // 等人回答且这一轮已结束：没有在跑的执行需要确认，直接停下
    if (invocation.status === "waiting_human" && invocation.finishedAt) {
      emitInvocation(
        database.updateInvocation(invocation.id, {
          status: "cancelled",
          detail: reason
            ? serverText("invocation.stoppedReason", { reason })
            : serverText("invocation.stoppedNoAnswer", { name: actor.username }),
        }),
      );
      return;
    }
    const target = onlineAgent(invocation.roomId, invocation.agentName);
    if (invocation.status !== "cancelling") {
      emitInvocation(
        database.updateInvocation(invocation.id, {
          status: "cancelling",
          detail: reason
            ? serverText("invocation.stopRequestedReason", {
                reason,
                name: actor.username,
                agent: invocation.agentName,
              })
            : serverText("invocation.stopRequested", {
                name: actor.username,
                agent: invocation.agentName,
              }),
          progress: null,
        }),
      );
    }
    // 重复点击停止时只重发请求，不改动状态
    if (target) send(target.socket, { type: "agent.cancel", messageId: invocation.messageId });
  }

  function extendBudget(actor: Participant, turns: number): void {
    const allowance = database.extendAgentTurns(actor.roomId, turns);
    const afterSeq = database.lastHumanMessageSeq(actor.roomId);
    for (const invocation of database.listBlockedInvocations(actor.roomId, afterSeq)) {
      const message = database.getMessage(invocation.messageId);
      const agent = database.getParticipant(invocation.agentId);
      if (!message || message.deletedAt || !agent) continue;
      emitInvocation(
        resetForRedelivery(
          invocation,
          serverText("invocation.turnsAdded", { name: actor.username, turns, total: allowance }),
        ),
      );
      deliverMention(message, agent, true);
    }
  }

  function handleReport(
    agent: Participant,
    report: Extract<ClientEvent, { type: "invocation.report" }>,
  ): void {
    let invocation = database.getInvocationFor(report.messageId, agent.id);
    if (!invocation) {
      // 功能上线前的旧消息或补拉到的提及：仅为本房间、确实 @ 了该 Agent 的消息补建记录
      const message = database.getMessage(report.messageId);
      if (
        !message ||
        message.roomId !== agent.roomId ||
        !message.mentions.some(
          (mention) => mention.toLocaleLowerCase() === agent.username.toLocaleLowerCase(),
        )
      ) {
        return;
      }
      invocation = database.createInvocation({ message, agent, status: "queued" }).invocation;
    }
    if (report.contextSeq !== undefined) {
      inboxCursors.set(agent.id, Math.max(inboxCursors.get(agent.id) ?? 0, report.contextSeq));
    }
    // 用量先记账，与调用后续状态如何落定无关：迟到或已停止的回合同样花了钱
    if (report.usage) {
      invocation = database.recordUsage(invocation, report.usage);
      emitInvocation(invocation);
    }
    const now = new Date().toISOString();
    if (report.status === "received") {
      if (invocation.status !== "queued" || invocation.receivedAt) return;
      emitInvocation(
        database.updateInvocation(invocation.id, {
          receivedAt: now,
          detail: serverText("invocation.delivered"),
        }),
      );
      return;
    }
    if (report.status === "uncertain") {
      if (isTerminal(invocation)) return;
      // 停止中收到结果未知：Agent 这边的回合已经结束（Claude 只能确认主进程停了），不再占着「停止中」
      // 等 10 分钟超时；改为结果未知，照样不允许直接重试，要人核对后再决定
      const stopping = invocation.status === "cancelling";
      // 撤回并停止的：人已经在确认框里处理过，写明原因，不再算作「需要你处理」
      const recalledBy = stopping ? database.getMessage(invocation.messageId) : undefined;
      const recalled = Boolean(recalledBy?.deletedAt);
      emitInvocation(
        database.updateInvocation(invocation.id, {
          status: "timed_out",
          detail: stopping
            ? serverText(
                recalled ? "invocation.recalledStopUnconfirmed" : "invocation.stopUnconfirmedTools",
                {
                  reason: reportDetail(report, 380) ?? serverText("invocation.outcomeUnknown"),
                },
              )
            : (reportDetail(report) ?? serverText("invocation.unknownNoReplay")),
          progress: null,
        }),
      );
      if (recalled) {
        for (const dismissed of database.dismissInvocations(
          invocation.roomId,
          [invocation.id],
          recalledBy!.senderName,
        )) {
          emitInvocation(dismissed);
        }
      }
      return;
    }
    if (report.status === "running") {
      if (isTerminal(invocation)) return;
      // 停止未确认前、或提问后等人回答期间的进度和心跳只更新运行观测，不把调用冲回 running
      if (invocation.status === "cancelling" || invocation.status === "waiting_human") {
        emitInvocation(
          database.updateInvocation(invocation.id, {
            runtime: observeRuntime(invocation.runtime, report.runtimeEvent, now),
          }),
        );
        return;
      }
      emitInvocation(
        database.updateInvocation(invocation.id, {
          status: "running",
          receivedAt: invocation.receivedAt ?? now,
          startedAt: invocation.startedAt ?? now,
          progress: report.progress ?? invocation.progressText ?? invocation.progress ?? null,
          runtime: observeRuntime(invocation.runtime, report.runtimeEvent, now),
          detail: reportDetail(report) ?? null,
        }),
      );
      return;
    }
    if (isTerminal(invocation)) return;
    // 提问后这一轮正常结束：保持等人回答，只记下回复与结束时间；失败或停止照常落定
    if (invocation.status === "waiting_human" && report.status === "completed") {
      emitInvocation(
        database.updateInvocation(invocation.id, {
          finishedAt: now,
          ...(report.replyMessageId ? { replyMessageId: report.replyMessageId } : {}),
        }),
      );
      return;
    }
    emitInvocation(
      database.updateInvocation(invocation.id, {
        status: invocation.status === "cancelling" ? "cancelled" : report.status,
        finishedAt: now,
        progress: null,
        detail:
          recalledDetail(invocation, report.status) ??
          reportDetail(report) ??
          terminalDetail(invocation, report.status),
        ...(report.replyMessageId ? { replyMessageId: report.replyMessageId } : {}),
      }),
    );
  }

  /** 撤回并停止的任务结束时写明原因，不显示成普通的失败或停止 */
  function recalledDetail(
    invocation: Invocation,
    status: Invocation["status"],
  ): ServerText | undefined {
    if (
      invocation.status !== "cancelling" ||
      !database.getMessage(invocation.messageId)?.deletedAt
    ) {
      return undefined;
    }
    return status === "cancelled" ? serverText("invocation.recalledStopped") : undefined;
  }

  function terminalDetail(invocation: Invocation, status: Invocation["status"]): ServerText | null {
    if (invocation.status === "cancelling") {
      return status === "cancelled"
        ? serverText("invocation.stopConfirmed", { agent: invocation.agentName })
        : serverText("invocation.endedBeforeStop");
    }
    return invocation.status === "timed_out" ? serverText("invocation.lateResult") : null;
  }

  function sweepStaleInvocations(): void {
    // 服务重启前没来得及发出、或因限流暂时失败的回执，在这里补发
    for (const invocation of database.listPendingContinuations())
      deliverContinuation(invocation.id);
    runSchedules();
    // 停止请求长时间没有确认（Agent 已离开、进程丢失）：不再显示「停止中」占着 Agent，改为结果未知。
    // Agent 之后若补报结果，照常按迟到的结果处理
    for (const invocation of database.listStaleCancelling(options.now?.() ?? Date.now())) {
      emitInvocation(
        database.updateInvocation(invocation.id, {
          status: "timed_out",
          detail: serverText("invocation.stopUnconfirmed", {
            minutes: Math.round(LIMITS.invocationStaleMs / 60_000),
          }),
          progress: null,
        }),
      );
    }
    supersedeStale();
    for (const invocation of database.listStaleInvocations(options.now?.() ?? Date.now())) {
      if (invocation.status === "running") {
        emitInvocation(
          database.updateInvocation(invocation.id, {
            status: "timed_out",
            detail: serverText("invocation.stale", {
              minutes: Math.round(LIMITS.invocationStaleMs / 60_000),
            }),
          }),
        );
        continue;
      }
      // 只有 Agent 在线却迟迟不确认才算异常；离线时排队等待它上线是正常的
      if (!onlineAgent(invocation.roomId, invocation.agentName)) continue;
      emitInvocation(
        database.updateInvocation(invocation.id, {
          status: "timed_out",
          detail: serverText("invocation.unacknowledged"),
        }),
      );
    }
  }

  /**
   * Hive MCP 是无状态的，未读游标按 Agent 身份落库：放内存的话服务一重启就丢，
   * 下次调用会把游标重置到最新，重启前后那段消息 Agent 就再也收不到了
   */
  const inboxCursors = {
    get: (agentId: string) => database.getInboxCursor(agentId),
    set: (agentId: string, seq: number) => database.setInboxCursor(agentId, seq),
  };

  function takeInbox(agent: Participant): InboxDigest | undefined {
    const cursor = inboxCursors.get(agent.id);
    if (cursor === undefined) {
      inboxCursors.set(agent.id, database.latestSeq(agent.roomId));
      return undefined;
    }
    const fresh = database
      .getMessages(agent.roomId, cursor, 200)
      .filter((message) => !message.deletedAt && message.senderId !== agent.id);
    const latest = database.latestSeq(agent.roomId);
    if (fresh.length === 0) {
      inboxCursors.set(agent.id, Math.max(cursor, latest));
      return undefined;
    }
    const included = fresh.slice(0, 20);
    inboxCursors.set(agent.id, included.at(-1)!.seq);
    const name = agent.username.toLocaleLowerCase();
    return {
      messages: included.map((message) => {
        const page = readMessageContent(message, 0, 500);
        return {
          seq: message.seq,
          id: message.id,
          sender: message.senderName,
          senderType: message.senderType,
          content: page.content + (page.nextOffset !== null ? "…" : ""),
          ...(page.nextOffset !== null
            ? { totalLength: page.totalLength, nextOffset: page.nextOffset }
            : {}),
          mentionsYou: message.mentions.some((mention) => mention.toLocaleLowerCase() === name),
        };
      }),
      remaining: fresh.length - included.length,
    };
  }

  /**
   * hive_invoke：以当前执行中的调用为上游发出委派消息，并为被委派方的调用登记待回执。
   * 委派消息不推进调用方自己的调用——它只是中间动作，最终答复仍由调用方给出。
   */
  function delegate(
    requester: Participant,
    input: { agent: string; task: string; clientMessageId: string },
  ) {
    const target = database.findParticipant(requester.roomId, input.agent.replace(/^@/, ""));
    if (!target || target.type !== "agent") {
      throw new HiveError(
        "AGENT_NOT_FOUND",
        serverText("error.delegation.agentNotFound", { agent: input.agent }),
      );
    }
    if (target.id === requester.id) {
      throw new HiveError("SELF_DELEGATION", serverText("error.delegation.self"));
    }
    const parent = inferExecutingParent(requester);
    const parentInvocation = parent
      ? database.getInvocationFor(parent.id, requester.id)
      : undefined;
    if (parentInvocation) {
      const waiting = [parentInvocation, ...database.invocationAncestors(parentInvocation.id)].find(
        (invocation) => invocation.agentId === target.id && !isTerminal(invocation),
      );
      if (waiting) {
        throw new HiveError(
          "DELEGATION_CYCLE",
          serverText("error.delegation.cycle", { agent: target.username }),
        );
      }
    }
    const name = target.username.toLocaleLowerCase();
    const content = parseMentions(input.task).some(
      (mention) => mention.toLocaleLowerCase() === name,
    )
      ? input.task
      : `@${target.username} ${input.task}`;
    const { message } = createAndDispatchMessage(
      requester,
      {
        content,
        clientMessageId: input.clientMessageId,
        ...(parent ? { parentMessageId: parent.id } : {}),
        kind: "delegation",
      },
      { inferredParent: true, delegateTo: target.id },
    );
    const invocation = database.getInvocationFor(message.id, target.id);
    if (!invocation) {
      throw new HiveError("DELEGATION_FAILED", serverText("error.delegation.noInvocation"));
    }
    const connection = onlineAgent(requester.roomId, target.username);
    return {
      invocation,
      message,
      targetOnline: Boolean(connection),
      targetBusy: connection?.participant?.status === "busy",
      targetState: describeForAgent(invocation),
    };
  }

  /** 子任务现在为什么是这个状态（离线、排在谁后面、多久没进展），给委派方的一句话 */
  function invocationState(invocation: Invocation) {
    return explainInvocationState({
      invocation,
      agentOnline: Boolean(onlineAgent(invocation.roomId, invocation.agentName)),
      others: database.listOpenInvocationsForAgent(invocation.agentId),
      now: clock(),
    });
  }

  function describeForAgent(invocation: Invocation): string {
    return formatInvocationStateForAgent(invocationState(invocation), invocation.agentName);
  }

  /**
   * hive_wait：轮询调用状态直到结束、被拦下或窗口用完。
   * 调用方亲自拿到了结果，就把回执标成已取走，避免同一结果再唤醒它一次。
   */
  async function waitForInvocation(
    caller: Participant,
    input: { invocationId: string; timeoutMs: number; signal: AbortSignal },
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + input.timeoutMs;
    const id = input.invocationId;
    activeWaits.set(id, (activeWaits.get(id) ?? 0) + 1);
    try {
      return await pollInvocation(caller, input, deadline);
    } finally {
      const remaining = (activeWaits.get(id) ?? 1) - 1;
      if (remaining > 0) activeWaits.set(id, remaining);
      else activeWaits.delete(id);
      // 等待中途被取消、或结束时没能取走结果：照常回执，不能让结果丢在半路
      if (remaining <= 0) deliverContinuation(id);
    }
  }

  async function pollInvocation(
    caller: Participant,
    input: { invocationId: string; signal: AbortSignal },
    deadline: number,
  ): Promise<Record<string, unknown>> {
    for (;;) {
      const invocation = database.getInvocation(input.invocationId);
      if (!invocation || invocation.roomId !== caller.roomId) {
        throw new HiveError("INVOCATION_NOT_FOUND", serverText("error.invocation.notInRoom"));
      }
      const summary = {
        invocationId: invocation.id,
        agent: invocation.agentName,
        status: invocation.status,
        ...(invocation.detail ? { detail: invocation.detail } : {}),
      };
      if (invocation.status === "waiting_human") {
        return {
          ...summary,
          done: false,
          needsHuman: true,
          note: "子任务在等人回答，人回复后它会继续，结果照常回执给你；不需要等，也不要替人回答。",
        };
      }
      if (invocation.status === "blocked") {
        return {
          ...summary,
          done: false,
          needsHuman: true,
          ...(invocation.blockReason ? { blockReason: invocation.blockReason } : {}),
          note: "子任务被预算拦下，需要人在页面上点「继续」；放行后结果仍会回执给你。不要换个方式绕开。",
        };
      }
      if (CONTINUATION_READY_STATUSES.includes(invocation.status)) {
        if (
          invocation.requesterId === caller.id &&
          database.claimContinuation(invocation.id, "consumed")
        ) {
          emitInvocation(database.getInvocation(invocation.id)!);
        }
        const reply = invocation.replyMessageId
          ? database.getMessage(invocation.replyMessageId)
          : undefined;
        return {
          ...summary,
          done: true,
          ...(invocation.status === "timed_out"
            ? { note: "结果未知：子任务超时没有进展，不代表失败。" }
            : {}),
          ...(reply && !reply.deletedAt
            ? { reply: { seq: reply.seq, id: reply.id, content: reply.content } }
            : {}),
        };
      }
      // 派出后迟迟没开始（离线、排在别的任务后面、没确认收到）：不陪着干等，马上告诉委派方原因
      if (invocation.status === "queued") {
        const state = invocationState(invocation);
        if (state.stalled) {
          return {
            ...summary,
            done: false,
            stalled: true,
            state: state.code,
            note: `${formatInvocationStateForAgent(state, invocation.agentName)}结束后照常回执给你；不需要继续等。`,
          };
        }
      }
      if (Date.now() >= deadline || input.signal.aborted) {
        return {
          ...summary,
          done: false,
          state: describeForAgent(invocation),
          note: "等待窗口已用完，子任务仍在进行；这不是失败，结束后会自动回执给你。",
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /* ---------- 外部 IM：房主扫码把飞书 / 个人微信接进房间 ---------- */

  const imHub = new ImHub({
    store: imStore,
    drivers: options.imDrivers ?? {},
    getRoom: (roomId) => database.getRoom(roomId),
    listRoomIds: () => database.listRooms(false).map((room) => room.id),
    findParticipant: (roomId, username) => database.findParticipant(roomId, username),
    getMessage: (id) => database.getMessage(id),
    getInvocation: (id) => database.getInvocation(id),
    invocationAncestors: (id) => database.invocationAncestors(id),
    post: (owner, input) => createAndDispatchMessage(owner, input).message,
    choose: (owner, questionMessageId, selected, clientMessageId, other) =>
      submitAnswer(owner, {
        type: "question.answer",
        questionMessageId,
        selected,
        clientMessageId,
        ...(other ? { other } : {}),
      }).message,
    retry: (owner, invocationId) => retryInvocation(owner, invocationId),
    cancel: (owner, invocationId) => cancelInvocation(owner, invocationId),
    dismiss: (owner, invocationId) => {
      for (const invocation of database.dismissInvocations(
        owner.roomId,
        [invocationId],
        owner.username,
      )) {
        broadcastAll({ type: "invocation.updated", invocation });
        imHub.onInvocationUpdated(invocation);
      }
    },
    extendBudget: (owner, turns) => extendBudget(owner, turns),
    invocationsFor: (messageId) => database.invocationsForMessage(messageId),
    participants: (roomId) => participantsOf(roomId),
    roomTasks: (roomId) => {
      const invocations = database.listInvocations(roomId);
      return {
        running: invocations.filter((item) =>
          ["queued", "running", "cancelling"].includes(item.status),
        ).length,
        waiting: invocations.filter((item) => item.status === "waiting_human").length,
      };
    },
    readAttachment: async (id) => {
      const item = attachments.get(id);
      if (!item || item.revokedAt) return undefined;
      return {
        name: item.name,
        mime: item.mime,
        kind: item.kind,
        data: await readFile(item.filePath),
      };
    },
    // IM 收到的文件存成房主（本机管理员）的待发附件，随这条消息一起认领
    saveFiles: async (owner, files) => {
      const ids: string[] = [];
      for (const file of files) {
        const stored = await attachments.save({
          roomId: owner.roomId,
          uploader: "admin",
          name: file.name,
          stream: Readable.from(file.data),
          truncated: () => false,
        });
        ids.push(stored.id);
      }
      return {
        attachments: attachments.claim(ids, { roomId: owner.roomId, uploader: "admin" }),
        onInsert: (messageId: string) => attachments.bind(ids, messageId),
      };
    },
    isWaiting: (questionId) =>
      Boolean(waitingForQuestion(questionId) || approvalByQuestion.has(questionId)),
    webUrl: (roomId) => {
      const base = webBase();
      return base ? `${base}/#${roomId}` : undefined;
    },
    // 卡片按钮：带 24 小时有效的登录票，手机上点开直接以房主身份进入
    loginUrl: (connectionId, roomId) => {
      const base = webBase();
      return base
        ? `${base}/?login=${ownerDevices.createImTicket(connectionId)}#${roomId}`
        : undefined;
    },
    onConnectionsChanged: () => scheduleKeepAwake(),
    decideHostApproval: (connectionId, actorId, approvalId, allow) => {
      if (!isHostApprover({ id: connectionId, ownerActorId: actorId })) {
        return { ok: false, key: "im.host.notApprover" };
      }
      const decided = decideHostApproval(approvalId, allow, connectionId);
      if (!decided) return { ok: false, key: "im.host.expired" };
      return { ok: true, key: allow ? "im.resolved.allowed" : "im.resolved.denied" };
    },
    markHostApprover: (connectionId, actorId) =>
      ownerDevices.setHostApprover(connectionId, actorId, true),
    log: (message, detail) => app.log.warn({ detail }, message),
    ...(options.now ? { now: options.now } : {}),
  });

  /* ---------- 熄屏后保持在线 ---------- */

  const keepAwake =
    (options.keepAwake ?? !process.env.VITEST)
      ? new KeepAwake({
          loadSettings: () => {
            try {
              const raw = database.getSetting("keepAwake");
              return raw ? keepAwakeSettingsSchema.parse(JSON.parse(raw)) : undefined;
            } catch {
              return undefined;
            }
          },
          saveSettings: (settings) => database.setSetting("keepAwake", JSON.stringify(settings)),
          // 启用中的 IM 连接（含正在重连的）都算：断网时先释放会让机器睡下去，更难连回来
          demand: () => ({
            imConnections: imStore
              .listConnections()
              .filter((connection) => connection.status !== "paused").length,
            runningTasks: database.countActiveInvocations(),
          }),
          log: (message, detail) => app.log.info({ detail }, message),
        })
      : undefined;
  let keepAwakeScheduled = false;
  /** 条件可能变了：合并到下一拍复查一次 */
  function scheduleKeepAwake(): void {
    if (!keepAwake || keepAwakeScheduled) return;
    keepAwakeScheduled = true;
    setImmediate(() => {
      keepAwakeScheduled = false;
      keepAwake.evaluate();
    });
  }
  void keepAwake?.start();

  const imErrorStatus: Record<string, number> = {
    IM_DISABLED: 400,
    IM_NOT_FOUND: 404,
    IM_NO_CODE: 409,
    NOT_A_MEMBER: 400,
  };

  function imError(
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
    error: unknown,
  ) {
    if (error instanceof HiveError && imErrorStatus[error.code]) {
      return reply.code(imErrorStatus[error.code]!).send(hiveErrorBody(error));
    }
    throw error;
  }

  app.get("/api/im/channels", async (request, reply) => {
    if (!adminOnly(request, reply)) return reply;
    return imHub.channels();
  });

  app.get<{ Params: { roomId: string } }>("/api/rooms/:roomId/im", async (request, reply) => {
    const params = roomParamsSchema.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    if (!adminOnly(request, reply)) return reply;
    return { connections: imHub.list(params.data.roomId) };
  });

  app.post<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/im/login",
    async (request, reply) => {
      const params = roomParamsSchema.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      if (!adminOnly(request, reply)) return reply;
      const body = startImLoginRequestSchema.safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      const room = database.getRoom(params.data.roomId);
      if (!room || room.archivedAt) {
        return reply.code(404).send({
          ...errorText(serverText("error.room.notFoundOrArchived")),
          code: "ROOM_NOT_FOUND",
        });
      }
      if (body.data.channel === "wechat" && !body.data.acceptRisk) {
        return reply
          .code(400)
          .send({ ...errorText(serverText("error.im.wechatRisk")), code: "IM_RISK_NOT_ACCEPTED" });
      }
      const owner = database.findParticipant(room.id, body.data.ownerName);
      // 访客不能把自己的 IM 接进来冒充房主：只有房主本人（非访客的人类成员）能作为发言身份
      if (!owner || owner.type !== "human" || guestSessionOf(owner)) {
        return reply
          .code(400)
          .send({ ...errorText(serverText("error.im.ownerIdentity")), code: "NOT_A_MEMBER" });
      }
      try {
        // 在 Server 所在电脑上发起的扫码：这个 IM 账号可以批准其他设备管理这台电脑
        const hostApprover = isLocal(request).local && !isOwnerDeviceToken(bearerToken(request));
        return reply.code(201).send(
          imHub.startLogin(room.id, body.data.channel, owner.username, {
            hostApprover,
            ...(body.data.locale ? { locale: body.data.locale } : {}),
          }),
        );
      } catch (error) {
        return imError(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/im/logins/:id", async (request, reply) => {
    if (!adminOnly(request, reply)) return reply;
    const view = imHub.getLogin(request.params.id);
    if (!view)
      return reply
        .code(404)
        .send({ ...errorText(serverText("error.im.loginNotFound")), code: "IM_NOT_FOUND" });
    return view;
  });

  app.post<{ Params: { id: string } }>("/api/im/logins/:id/code", async (request, reply) => {
    if (!adminOnly(request, reply)) return reply;
    const body = submitImLoginCodeRequestSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ ...errorText(serverText("error.im.pairingCode")) });
    try {
      const view = imHub.submitCode(request.params.id, body.data.code);
      if (!view)
        return reply
          .code(404)
          .send({ ...errorText(serverText("error.im.loginNotFound")), code: "IM_NOT_FOUND" });
      return view;
    } catch (error) {
      return imError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/im/logins/:id", async (request, reply) => {
    if (!adminOnly(request, reply)) return reply;
    const view = imHub.cancelLogin(request.params.id);
    if (!view)
      return reply
        .code(404)
        .send({ ...errorText(serverText("error.im.loginNotFound")), code: "IM_NOT_FOUND" });
    return view;
  });

  app.post<{ Params: { id: string; action: string } }>(
    "/api/im/connections/:id/:action",
    async (request, reply) => {
      if (!adminOnly(request, reply)) return reply;
      try {
        if (request.params.action === "pause") return await imHub.pause(request.params.id);
        if (request.params.action === "resume") return await imHub.resume(request.params.id);
        if (request.params.action === "level") {
          const body = setImDeliveryLevelRequestSchema.safeParse(request.body);
          if (!body.success)
            return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
          return imHub.setLevel(request.params.id, body.data.level);
        }
        if (request.params.action === "locale") {
          const body = setImLocaleRequestSchema.safeParse(request.body);
          if (!body.success)
            return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
          return imHub.setLocale(request.params.id, body.data.locale);
        }
        if (request.params.action === "scope") {
          const body = setImScopeRequestSchema.safeParse(request.body);
          if (!body.success)
            return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
          return imHub.setScope(request.params.id, body.data.scope);
        }
        return reply.code(404).send({ ...errorText(serverText("error.request.invalid")) });
      } catch (error) {
        return imError(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/api/im/connections/:id", async (request, reply) => {
    if (!adminOnly(request, reply)) return reply;
    try {
      await imHub.remove(request.params.id);
      return { ok: true };
    } catch (error) {
      return imError(reply, error);
    }
  });

  app.get("/health", async () => ({
    status: "ok",
    // 本机 Agent 在原 Server 退出后据此认出接管它的新 Server
    pid: process.pid,
    ...(options.instanceId ? { instanceId: options.instanceId } : {}),
  }));
  app.get("/agent.md", async (_request, reply) => {
    return reply.type("text/markdown; charset=utf-8").send(AGENT_INSTRUCTIONS);
  });
  /**
   * 共享 join token 等同房主权限，只交给 Server 所在电脑上的页面（或已持有它的请求）；
   * 远程访问者拿不到它，只能凭限时邀请兑换的访客会话进入。
   */
  function isOwnerRequest(
    request: Parameters<typeof checkLocalRequest>[0] & {
      headers: { authorization?: string | undefined };
    },
  ): boolean {
    const token = bearerToken(request);
    return (
      isLocal(request).local ||
      token === joinToken ||
      Boolean(isOwnerDeviceToken(token) && ownerDevices.resolve(token))
    );
  }

  /** 房主在其他设备上登录时，交给这台设备的是它自己的设备令牌，不是总令牌 */
  function ownerTokenFor(request: { headers: { authorization?: string | undefined } }): string {
    const token = bearerToken(request);
    return isOwnerDeviceToken(token) && ownerDevices.resolve(token) ? token : joinToken;
  }

  /** 退出某台设备：断开它已有的连接 */
  function revokeOwnerDevice(id: string): boolean {
    if (!ownerDevices.revoke(id)) return false;
    hostApprovals.dropDevice(id);
    for (const connection of [...connections]) {
      if (connection.principal?.kind !== "admin" || connection.principal.deviceId !== id) continue;
      send(connection.socket, {
        type: "error",
        code: "SESSION_REVOKED",
        ...wsText(serverText("error.device.signedOutByOwner")),
      });
      connection.socket.close(4401, "revoked");
      disconnect(connection);
    }
    return true;
  }

  /** 用登录票换设备会话（二维码、飞书卡片按钮） */
  /** 登录票兑换失败次数（按来源地址），超过上限暂时拒绝，防止猜票 */
  const loginFailures = new Map<string, number[]>();
  const LOGIN_FAILURE_WINDOW_MS = 10 * 60_000;
  const LOGIN_FAILURE_LIMIT = 10;

  app.post("/api/owner-login", async (request, reply) => {
    const source = request.socket.remoteAddress ?? "";
    const recent = (loginFailures.get(source) ?? []).filter(
      (at) => clock() - at < LOGIN_FAILURE_WINDOW_MS,
    );
    if (recent.length >= LOGIN_FAILURE_LIMIT) {
      return reply.code(429).send({
        ...errorText(serverText("error.login.rateLimited")),
        code: "OWNER_LOGIN_RATE_LIMITED",
      });
    }
    const body = request.body as { ticket?: unknown; deviceName?: unknown } | undefined;
    const ticket = typeof body?.ticket === "string" ? body.ticket : "";
    const deviceName = typeof body?.deviceName === "string" ? body.deviceName : "";
    const result = ownerDevices.redeem(ticket, deviceName, (connectionId) => {
      const connection = imStore.getConnection(connectionId);
      return Boolean(connection && connection.status !== "paused");
    });
    if (!result) {
      recent.push(clock());
      loginFailures.set(source, recent);
      return reply.code(401).send({
        ...errorText(serverText("error.login.invalid")),
        code: "OWNER_LOGIN_INVALID",
      });
    }
    return { token: result.token, device: result.device };
  });

  app.get("/api/meta", async (request) => {
    const httpUrl = requestPublicUrl(request, options.publicUrl);
    const wsUrl = httpUrl.replace(/^http/, "ws") + "/ws";
    const agentCommandPrefix = options.agentCommandPrefix ?? "npx --yes superhive@latest";
    return {
      name: "SuperHive",
      roomId: "general",
      httpUrl,
      wsUrl,
      mcpUrl: `${httpUrl}/mcp`,
      ...(isOwnerRequest(request)
        ? (() => {
            const token = ownerTokenFor(request);
            return {
              joinToken: token,
              // 其他设备上的登录只拿到自己的设备令牌；接入 Agent 的命令要在 Server 所在电脑上复制
              ...(token === joinToken
                ? {
                    agentCommand: `${agentCommandPrefix} join --server ${httpUrl} --name my-agent --token ${joinToken}`,
                  }
                : { ownerDevice: true }),
            };
          })()
        : {}),
    };
  });

  /** 当前访问者是谁：本机房主、有效访客，或没有访问权（含已到期、已被移除） */
  app.get("/api/access", async (request) => {
    const token = bearerToken(request);
    // 带着访客凭证来的按访客对待，即使是在 Server 所在电脑上打开
    if (!(token && isGuestToken(token)) && isOwnerRequest(request)) {
      return { role: "owner", joinToken: ownerTokenFor(request) };
    }
    const resolved = token && isGuestToken(token) ? access.resolveToken(token, clock()) : undefined;
    if (!resolved) return { role: "none", reason: "no_invite" };
    if (resolved.state !== "active") return { role: "none", reason: resolved.state };
    return sessionView(resolved);
  });

  /** 兑换前预览邀请：只透露房间和截止时间，不消耗邀请 */
  app.get<{ Querystring: { token?: string } }>("/api/invites/preview", async (request, reply) => {
    const token = request.query.token;
    const invite = token ? access.peekInvite(token) : undefined;
    if (!invite)
      return reply
        .code(404)
        .send({ ...errorText(serverText("error.invite.invalid")), code: "INVITE_INVALID" });
    const state = invite.revokedAt
      ? "revoked"
      : invite.expiresAt && Date.parse(invite.expiresAt) <= clock()
        ? "expired"
        : "valid";
    return { roomId: invite.roomId, expiresAt: invite.expiresAt, state };
  });

  const inviteErrorStatus: Record<string, number> = {
    INVITE_INVALID: 404,
    INVITE_REVOKED: 410,
    INVITE_EXPIRED: 410,
    USERNAME_TAKEN: 409,
    INVALID_NAME: 400,
  };

  app.post("/api/invites/redeem", async (request, reply) => {
    const body = redeemInviteRequestSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    if (!/^[\p{L}\p{N}_.-]+$/u.test(body.data.username)) {
      return reply.code(400).send({
        ...errorText(serverText("error.name.format")),
        code: "INVALID_NAME",
      });
    }
    try {
      const { session, token } = access.redeemInvite(
        body.data.token,
        body.data.username,
        clock(),
        isNameTaken,
      );
      return { token, ...sessionView(access.resolve(session, clock())) };
    } catch (error) {
      if (error instanceof HiveError && inviteErrorStatus[error.code]) {
        return reply.code(inviteErrorStatus[error.code]!).send(hiveErrorBody(error));
      }
      throw error;
    }
  });

  app.post<{ Params: { roomId: string } }>("/api/rooms/:roomId/invites", async (request, reply) => {
    const params = roomParamsSchema.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    if (!adminOnly(request, reply)) return reply;
    const body = createInviteRequestSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    const room = database.getRoom(params.data.roomId);
    if (!room || room.archivedAt) {
      return reply.code(404).send({
        ...errorText(serverText("error.room.notFoundOrArchived")),
        code: "ROOM_NOT_FOUND",
      });
    }
    const created = access.createInvite({
      roomId: room.id,
      expiresAt: expiresAtFrom(body.data.expiresInMinutes, clock()),
      allowAgents: body.data.allowAgents,
      showTrace: body.data.showTrace,
    });
    return reply.code(201).send(created);
  });

  app.get<{ Params: { roomId: string } }>("/api/rooms/:roomId/invites", async (request, reply) => {
    const params = roomParamsSchema.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    if (!adminOnly(request, reply)) return reply;
    return { invites: access.listInvites(params.data.roomId) };
  });

  /** 撤销邀请：链接失效，凭它进来的人和他们的 Agent 立即被断开 */
  app.delete<{ Params: { inviteId: string } }>("/api/invites/:inviteId", async (request, reply) => {
    if (!adminOnly(request, reply)) return reply;
    try {
      const invite = access.revokeInvite(request.params.inviteId);
      const sessions = access.sessionsOfInvite(invite.id);
      endSessionConnections(sessions, "revoked");
      refreshAccessPresence(sessions);
      return { invite };
    } catch (error) {
      if (error instanceof HiveError) return reply.code(404).send(hiveErrorBody(error));
      throw error;
    }
  });

  /** 续期邀请：链接与凭它进来的所有人一起延到新的截止时间 */
  app.post<{ Params: { inviteId: string } }>(
    "/api/invites/:inviteId/renew",
    async (request, reply) => {
      if (!adminOnly(request, reply)) return reply;
      const body = renewAccessRequestSchema.safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      try {
        const invite = access.renewInvite(
          request.params.inviteId,
          expiresAtFrom(body.data.expiresInMinutes, clock()),
        );
        refreshAccessPresence(access.sessionsOfInvite(invite.id));
        return { invite };
      } catch (error) {
        if (error instanceof HiveError) {
          return reply
            .code(error.code === "INVITE_NOT_FOUND" ? 404 : 409)
            .send(hiveErrorBody(error));
        }
        throw error;
      }
    },
  );

  /** 房主为访客续期；访客带入的 Agent 跟着一起延长 */
  app.post<{ Params: { sessionId: string } }>(
    "/api/guests/:sessionId/renew",
    async (request, reply) => {
      if (!adminOnly(request, reply)) return reply;
      const body = renewAccessRequestSchema.safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      try {
        const session = access.renew(
          request.params.sessionId,
          expiresAtFrom(body.data.expiresInMinutes, clock()),
        );
        refreshAccessPresence(access.familyOf(session.id));
        return { session: sessionView(access.resolve(session, clock())) };
      } catch (error) {
        if (error instanceof HiveError) {
          return reply
            .code(error.code === "SESSION_NOT_FOUND" ? 404 : 409)
            .send(hiveErrorBody(error));
        }
        throw error;
      }
    },
  );

  /** 房主移除访客：立即断开访客与其 Agent，之后都连不上；历史消息保留 */
  app.delete<{ Params: { sessionId: string } }>(
    "/api/guests/:sessionId",
    async (request, reply) => {
      if (!adminOnly(request, reply)) return reply;
      try {
        const session = access.revoke(request.params.sessionId);
        const family = access.familyOf(session.id);
        endSessionConnections(family, "revoked");
        refreshAccessPresence(family);
        return { session: sessionView(access.resolve(session, clock())) };
      } catch (error) {
        if (error instanceof HiveError) return reply.code(404).send(hiveErrorBody(error));
        throw error;
      }
    },
  );

  /** 访客为自己带入一个 Agent：同房间、同期限，访客到期或被移除时一起失效 */
  app.post("/api/guest-agents", async (request, reply) => {
    const principal = guard(request, reply);
    if (!principal) return reply;
    if (principal.kind !== "guest" || principal.resolved.session.kind !== "human") {
      return reply
        .code(403)
        .send({ ...errorText(serverText("error.guest.agentGuestOnly")), code: "GUEST_ONLY" });
    }
    const body = createGuestAgentRequestSchema.safeParse(request.body);
    if (!body.success || !/^[\p{L}\p{N}_.-]+$/u.test(body.data.username)) {
      return reply.code(400).send({
        ...errorText(serverText("error.name.agentFormat")),
        code: "INVALID_NAME",
      });
    }
    const sponsor = principal.resolved.session;
    if (database.findParticipant(sponsor.roomId, body.data.username)) {
      return reply
        .code(409)
        .send({ ...errorText(serverText("error.name.taken")), code: "USERNAME_TAKEN" });
    }
    const { session, token } = access.createAgentSession(sponsor, body.data.username);
    return reply.code(201).send({
      token,
      command: guestAgentCommand(request, session, token),
      ...sessionView(access.resolve(session, clock())),
    });
  });

  function connectedMcpAgent(request: {
    headers: Record<string, string | string[] | undefined>;
  }): Participant | undefined {
    const principal = principalForToken(
      bearerToken(request as { headers: { authorization?: string } }),
    );
    if (!principal) return undefined;
    const roomId = headerString(request.headers["x-hive-room"]);
    const username = headerString(request.headers["x-hive-agent-name"]);
    if (!roomId || !username) return undefined;
    // 访客 Agent 的凭证只代表它自己：房间与名字都必须对上，访客本人的凭证不能用来调 Agent 工具
    if (
      principal.kind === "guest" &&
      (principal.resolved.session.kind !== "agent" ||
        principal.resolved.session.roomId !== roomId ||
        principal.resolved.session.username.toLocaleLowerCase() !== username.toLocaleLowerCase())
    ) {
      return undefined;
    }
    const connection = onlineAgent(roomId, username);
    return connection?.participant?.type === "agent" ? connection.participant : undefined;
  }

  /** 交给模型看的图片上限：多数看图接口按 base64 后约 5 MB 计 */
  const MCP_IMAGE_MAX_BYTES = 3_750_000;

  async function readAttachmentForAgent(
    agent: Participant,
    input: { id: string; offset: number; maxBytes: number },
  ): Promise<AttachmentReadResult> {
    const item = attachments.get(input.id);
    const message = item?.messageId ? database.getMessage(item.messageId) : undefined;
    if (!item || item.roomId !== agent.roomId || item.revokedAt || !message || message.deletedAt) {
      throw new HiveError("ATTACHMENT_NOT_FOUND", serverText("error.attachment.notInRoom"));
    }
    const attachment = publicAttachment(item);
    if (item.kind === "image") {
      if (item.size > MCP_IMAGE_MAX_BYTES) {
        return {
          kind: "file",
          attachment,
          note: "图片超过 3.75 MB，无法作为图片内容返回；如果你能读取本机文件，请用提示里给出的本地路径。",
        };
      }
      return {
        kind: "image",
        attachment,
        data: (await readFile(item.filePath)).toString("base64"),
      };
    }
    if (item.kind !== "text") {
      return {
        kind: "file",
        attachment,
        note: "二进制文件，无法以文本读取；如果你能读取本机文件，请用提示里给出的本地路径。",
      };
    }
    const handle = await open(item.filePath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(input.maxBytes, Math.max(0, item.size - input.offset)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, input.offset);
      let end = bytesRead;
      // 不在多字节字符中间截断：回退到最后一个完整字符的边界
      if (end > 0 && input.offset + end < item.size) {
        let lead = end - 1;
        while (lead > 0 && end - lead < 4 && (buffer[lead]! & 0xc0) === 0x80) lead -= 1;
        const first = buffer[lead]!;
        const length = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
        if (lead + length > end) end = lead;
      }
      const next = input.offset + end;
      return {
        kind: "text",
        attachment,
        text: buffer.subarray(0, end).toString("utf8"),
        nextOffset: next < item.size ? next : null,
      };
    } finally {
      await handle.close();
    }
  }

  /* ---------- 附件：HTTP 上传与鉴权下载，WebSocket 只传附件 ID ---------- */

  /** 房主与本机 Agent 共用一个上传者身份；访客按会话区分，看不到彼此待发的附件 */
  function uploaderOf(principal: Principal): string {
    return principal.kind === "admin" ? "admin" : `guest:${principal.resolved.session.id}`;
  }

  function attachmentError(reply: FastifyReply, error: unknown) {
    const hiveError = error instanceof HiveError ? error : undefined;
    const status =
      hiveError?.code === "ATTACHMENT_TOO_LARGE"
        ? 413
        : hiveError?.code === "UPLOAD_RATE_LIMIT"
          ? 429
          : hiveError?.code?.endsWith("_QUOTA")
            ? 413
            : hiveError
              ? 400
              : 500;
    return reply
      .code(status)
      .send(
        hiveError
          ? hiveErrorBody(hiveError)
          : { ...errorText(serverText("error.attachment.failed")), code: "ATTACHMENT_FAILED" },
      );
  }

  /**
   * 读权限：撤回的不再提供；还没发出的只有上传者本人能读；发出后按所在房间的权限。
   * 内容相同的文件共享磁盘，但每条记录各自鉴权。
   */
  function readableAttachment(
    principal: Principal,
    id: string,
  ): { item: StoredAttachment } | { status: number; code: string; error: string } {
    const item = attachments.get(id);
    if (!item)
      return {
        status: 404,
        code: "ATTACHMENT_NOT_FOUND",
        ...errorText(serverText("error.attachment.notFound")),
      };
    if (!canAccessRoom(principal, item.roomId)) {
      return {
        status: 403,
        code: "ROOM_FORBIDDEN",
        ...errorText(serverText("error.auth.roomForbidden")),
      };
    }
    if (item.revokedAt) {
      return {
        status: 410,
        code: "ATTACHMENT_REVOKED",
        ...errorText(serverText("error.attachment.messageRecalled")),
      };
    }
    if (!item.messageId) {
      if (item.uploader !== uploaderOf(principal)) {
        return {
          status: 404,
          code: "ATTACHMENT_NOT_FOUND",
          ...errorText(serverText("error.attachment.notFound")),
        };
      }
      if (Date.parse(item.expiresAt) <= clock()) {
        return {
          status: 410,
          code: "ATTACHMENT_EXPIRED",
          ...errorText(serverText("error.attachment.expired")),
        };
      }
    }
    return { item };
  }

  app.post<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/attachments",
    async (request, reply) => {
      const roomId = roomParamsSchema.parse(request.params).roomId;
      const principal = guard(request, reply, roomId);
      if (!principal) return;
      if (!database.getRoom(roomId)) {
        return reply
          .code(404)
          .send({ ...errorText(serverText("error.room.notFound")), code: "ROOM_NOT_FOUND" });
      }
      if (!request.isMultipart()) {
        return reply.code(415).send({
          ...errorText(serverText("error.attachment.multipartRequired")),
          code: "MULTIPART_REQUIRED",
        });
      }
      const uploader = uploaderOf(principal);
      try {
        attachments.checkRate(uploader);
        // 先按声明的长度预检配额，明知超限就不必把文件收下来
        const declared = Number(request.headers["content-length"] ?? 0);
        attachments.checkQuota(roomId, uploader, Number.isFinite(declared) ? declared : 0);
        const file = await request.file();
        if (!file) {
          return reply.code(400).send({
            ...errorText(serverText("error.attachment.fileRequired")),
            code: "FILE_REQUIRED",
          });
        }
        const stored = await attachments.save({
          roomId,
          uploader,
          name: file.filename,
          stream: file.file,
          truncated: () => file.file.truncated,
        });
        return reply.code(201).send({
          ...publicAttachment(stored),
          roomId: stored.roomId,
          expiresAt: stored.expiresAt,
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "FST_REQ_FILE_TOO_LARGE") {
          return attachmentError(
            reply,
            new HiveError("ATTACHMENT_TOO_LARGE", serverText("error.attachment.tooLarge")),
          );
        }
        // 客户端中途取消：连接已断开，不再回复
        if (request.raw.socket?.destroyed) return reply.hijack();
        return attachmentError(reply, error);
      }
    },
  );

  /** 移除还没发出的附件（上传队列里点 ×） */
  app.delete<{ Params: { id: string } }>("/api/attachments/:id", async (request, reply) => {
    const principal = guard(request, reply);
    if (!principal) return;
    const id = z.string().uuid().safeParse(request.params.id);
    if (!id.success || !attachments.discardPending(id.data, uploaderOf(principal))) {
      return reply.code(404).send({
        ...errorText(serverText("error.attachment.pendingNotFound")),
        code: "ATTACHMENT_NOT_FOUND",
      });
    }
    return reply.code(204).send();
  });

  /**
   * 下载原件：只接受 Authorization 头（不接受 URL 里的凭证）。
   * 图片按嗅探出的类型内联；其余一律 attachment 下载，并用 nosniff + sandbox CSP 防止被当网页执行。
   */
  app.get<{ Params: { id: string } }>("/api/attachments/:id", async (request, reply) => {
    const principal = guard(request, reply);
    if (!principal) return;
    const id = z.string().uuid().safeParse(request.params.id);
    if (!id.success) {
      return reply.code(404).send({
        ...errorText(serverText("error.attachment.notFound")),
        code: "ATTACHMENT_NOT_FOUND",
      });
    }
    const result = readableAttachment(principal, id.data);
    if (!("item" in result)) {
      return reply.code(result.status).send({ error: result.error, code: result.code });
    }
    const { item } = result;
    if (!existsSync(item.filePath)) {
      return reply
        .code(410)
        .send({ ...errorText(serverText("error.attachment.gone")), code: "ATTACHMENT_GONE" });
    }
    const inline = item.kind === "image";
    reply
      .header("Content-Type", item.kind === "text" ? "text/plain; charset=utf-8" : item.mime)
      .header("Content-Length", String(item.size))
      .header(
        "Content-Disposition",
        `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(item.name)}`,
      )
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header("Cache-Control", "private, no-store")
      .header("X-Hive-Attachment-Sha256", item.sha256);
    return reply.send(createReadStream(item.filePath));
  });

  /**
   * 与 Server 同在一台电脑上的房主 Agent 直接拿 Server 存的那份文件路径，不再下载第二份；
   * 远程 Bridge 拿不到这个接口，改为下载到自己机器上的缓存。
   */
  app.get<{ Params: { id: string } }>("/api/attachments/:id/local-path", async (request, reply) => {
    const principal = guard(request, reply);
    if (!principal) return;
    if (principal.kind !== "admin" || !isLocal(request).local) {
      return reply
        .code(403)
        .send({ ...errorText(serverText("error.attachment.localOnly")), code: "LOCAL_ONLY" });
    }
    const id = z.string().uuid().safeParse(request.params.id);
    const result = id.success
      ? readableAttachment(principal, id.data)
      : {
          status: 404,
          code: "ATTACHMENT_NOT_FOUND",
          ...errorText(serverText("error.attachment.notFound")),
        };
    if (!("item" in result)) {
      return reply.code(result.status).send({ error: result.error, code: result.code });
    }
    if (!result.item.messageId || !existsSync(result.item.filePath)) {
      return reply.code(404).send({
        ...errorText(serverText("error.attachment.notFound")),
        code: "ATTACHMENT_NOT_FOUND",
      });
    }
    return { path: result.item.filePath, sha256: result.item.sha256 };
  });

  app.post("/mcp", async (request, reply) => {
    const participant = connectedMcpAgent(request);
    if (!participant) {
      return reply.code(401).send({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message:
            "Hive MCP requires a valid Bearer token and an online Agent identity in X-Hive-Room / X-Hive-Agent-Name.",
        },
        id: null,
      });
    }
    const mcpServer = createHiveMcpServer({
      roomId: participant.roomId,
      username: participant.username,
      // 只读当前话题：开启新话题或清空房间后，之前的消息不再作为 Agent 的上下文
      readMessages: (afterSeq, limit) => ({
        messages: database
          .getMessages(
            participant.roomId,
            Math.max(afterSeq, database.currentTopicSeq(participant.roomId) - 1),
            limit,
          )
          .filter((message) => !message.deletedAt),
        latestSeq: database.latestSeq(participant.roomId),
      }),
      readMessage: (id) => {
        const message = database.getMessage(id);
        if (
          !message ||
          message.roomId !== participant.roomId ||
          message.deletedAt ||
          message.seq < database.currentTopicSeq(participant.roomId)
        ) {
          throw new HiveError("MESSAGE_NOT_FOUND", serverText("error.message.unreadable"));
        }
        return message;
      },
      listMembers: () => participantsOf(participant.roomId),
      sendMessage: ({ progress, ...input }) => {
        if (progress) return sendProgress(participant, input);
        if (input.parentMessageId) {
          return createAndDispatchMessage(participant, input, { fromTool: true }).message;
        }
        const parent = inferExecutingParent(participant);
        return createAndDispatchMessage(
          participant,
          parent ? { ...input, parentMessageId: parent.id } : input,
          { inferredParent: Boolean(parent) },
        ).message;
      },
      readWhiteboard: () => database.listWhiteboard(participant.roomId),
      updateWhiteboard: (input) => {
        const result = database.upsertWhiteboardEntry(participant, input);
        if (result.changed) {
          broadcast(participant.roomId, { type: "whiteboard.updated", entry: result.entry });
          for (const entryId of result.evicted) {
            broadcast(participant.roomId, {
              type: "whiteboard.removed",
              roomId: participant.roomId,
              entryId,
            });
          }
        }
        return { entry: result.entry, changed: result.changed };
      },
      takeInbox: () => takeInbox(participant),
      markRead: (seq) =>
        inboxCursors.set(participant.id, Math.max(inboxCursors.get(participant.id) ?? 0, seq)),
      invoke: (input) => delegate(participant, input),
      askHuman: (input) => askHuman(participant, input),
      now: clock,
      timeZone: serverTimeZone,
      createSchedule: (input) => createSchedule(participant, input),
      listSchedules: () => database.listSchedules(participant.roomId),
      cancelSchedule: (id) => cancelSchedule(participant, id),
      createRoom: (input) => createRoomForAgent(participant, input),
      postToRoom: (input) => postToRoomForAgent(participant, input),
      formatScheduleTime,
      wait: (input) => waitForInvocation(participant, input),
      readAttachment: (input) => readAttachmentForAgent(participant, input),
    });
    const transport = new StreamableHTTPServerTransport();
    try {
      await mcpServer.connect(transport as unknown as Transport);
      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, request.body);
      reply.raw.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });
      return reply;
    } catch (error) {
      await transport.close().catch(() => undefined);
      await mcpServer.close().catch(() => undefined);
      if (!reply.raw.headersSent) {
        return reply.code(500).send({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Hive MCP request failed.",
          },
          id: null,
        });
      }
      request.log.error(error);
      return reply;
    }
  });

  for (const method of ["GET", "DELETE"] as const) {
    app.route({
      method,
      url: "/mcp",
      handler: async (_request, reply) =>
        reply.code(405).send({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed in stateless MCP mode." },
          id: null,
        }),
    });
  }

  app.get<{
    Params: { roomId: string };
    Querystring: { afterSeq?: string; limit?: string };
  }>("/api/rooms/:roomId/messages", async (request, reply) => {
    const params = roomParamsSchema.safeParse(request.params);
    const query = messagesQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    }
    if (!guard(request, reply, params.data.roomId)) return reply;
    return {
      messages: database.getMessages(params.data.roomId, query.data.afterSeq, query.data.limit),
      latestSeq: database.latestSeq(params.data.roomId),
    };
  });

  app.get<{ Querystring: { q?: string; limit?: string } }>(
    "/api/search",
    async (request, reply) => {
      const query = searchQuerySchema.safeParse(request.query);
      if (!query.success)
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      const principal = guard(request, reply);
      if (!principal) return reply;
      return {
        messages: database
          .searchMessages(query.data.q, query.data.limit)
          .filter((message) => canAccessRoom(principal, message.roomId)),
      };
    },
  );

  app.get<{ Querystring: { username?: string; limit?: string } }>(
    "/api/mentions",
    async (request, reply) => {
      const query = mentionsQuerySchema.safeParse(request.query);
      if (!query.success)
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      const principal = guard(request, reply);
      if (!principal) return reply;
      return {
        messages: database
          .listMentions(query.data.username, query.data.limit)
          .filter((message) => canAccessRoom(principal, message.roomId)),
      };
    },
  );

  app.get("/api/invocations", async (request, reply) => {
    const principal = guard(request, reply);
    if (!principal) return reply;
    const invocations = database
      .listActiveInvocations()
      .filter((invocation) => canAccessRoom(principal, invocation.roomId));
    // 附带触发消息，任务列表无需逐条再查
    const messages = invocations
      .map((invocation) => database.getMessage(invocation.messageId))
      .filter((message): message is ChatMessage => Boolean(message && !message.deletedAt));
    // 列表需要区分"排队中"与"等待上线"，附带各调用目标 Agent 当前是否在线
    const onlineInvocationIds = invocations
      .filter((invocation) => onlineAgent(invocation.roomId, invocation.agentName))
      .map((invocation) => invocation.id);
    return { invocations, messages, onlineInvocationIds };
  });

  /**
   * 忽略不再需要处理的失败、被拦、结果未知（「Agent 任务」面板跨房间，走 HTTP）。
   * 房主可以忽略任何房间的；访客只能忽略自己在本房间发起的。
   */
  app.post("/api/invocations/dismiss", async (request, reply) => {
    const principal = guard(request, reply);
    if (!principal) return reply;
    const body = z
      .object({
        invocationIds: z.array(z.string().uuid()).min(1).max(500),
        by: z.string().trim().min(1).max(32).optional(),
      })
      .safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    let ids = body.data.invocationIds;
    let by = body.data.by ?? "房主";
    if (principal.kind === "guest") {
      const session = principal.resolved.session;
      const self = database.findParticipant(session.roomId, session.username);
      ids = ids.filter((id) => {
        const invocation = database.getInvocation(id);
        return invocation?.roomId === session.roomId && invocation.requesterId === self?.id;
      });
      by = session.username;
    }
    const changed = database.dismissInvocations(null, ids, by);
    for (const invocation of changed) broadcastAll({ type: "invocation.updated", invocation });
    return { dismissed: changed.map((invocation) => invocation.id) };
  });

  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/whiteboard",
    async (request, reply) => {
      const params = roomParamsSchema.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      if (!guard(request, reply, params.data.roomId)) return reply;
      return { entries: database.listWhiteboard(params.data.roomId) };
    },
  );

  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/invocations",
    async (request, reply) => {
      const params = roomParamsSchema.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      if (!guard(request, reply, params.data.roomId)) return reply;
      return { invocations: database.listInvocations(params.data.roomId) };
    },
  );

  app.get<{ Params: { roomId: string }; Querystring: { days?: string; alert?: string } }>(
    "/api/rooms/:roomId/usage",
    async (request, reply) => {
      const params = roomParamsSchema.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      if (!guard(request, reply, params.data.roomId)) return reply;
      const days = Math.min(90, Math.max(1, Number.parseInt(request.query.days ?? "7", 10) || 7));
      const since = new Date((options.now?.() ?? Date.now()) - days * 86_400_000).toISOString();
      // 大额写入的阈值由网页设置传入，缺省用默认值
      const alert = Number.parseInt(request.query.alert ?? "", 10);
      return database.usageSummary(
        params.data.roomId,
        since,
        Number.isFinite(alert) && alert > 0
          ? Math.min(alert, 1e12)
          : DEFAULT_CACHE_WRITE_ALERT_TOKENS,
      );
    },
  );

  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/participants",
    async (request, reply) => {
      const params = roomParamsSchema.safeParse(request.params);
      if (!params.success)
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      if (!guard(request, reply, params.data.roomId)) return reply;
      return { participants: participantsOf(params.data.roomId) };
    },
  );

  /** 房间工作区当前的 git 分支：侧栏房间名下面显示，切换分支后由定时检查推送 */
  const roomBranches = new Map<string, string | undefined>();
  function withBranch(room: RoomSummary): RoomSummary {
    if (!room.workspace) return room;
    const branch = gitBranch(room.workspace);
    roomBranches.set(room.id, branch);
    return branch ? { ...room, branch } : room;
  }
  function checkRoomBranches(): void {
    for (const room of database.listRooms(false)) {
      if (!room.workspace) continue;
      const before = roomBranches.get(room.id);
      const next = withBranch(room);
      if (roomBranches.has(room.id) && next.branch !== before) {
        broadcastAll({ type: "rooms.changed", room: next });
      }
    }
  }

  app.get<{ Querystring: { includeArchived?: string } }>("/api/rooms", async (request, reply) => {
    const query = roomsQuerySchema.safeParse(request.query);
    if (!query.success)
      return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    const principal = guard(request, reply);
    if (!principal) return reply;
    return {
      rooms: database
        .listRooms(query.data.includeArchived)
        .filter((room) => canAccessRoom(principal, room.id))
        .map(withBranch),
    };
  });

  /** 房间工作区必须是 Server 所在电脑上真实存在的目录，存解析后的真实路径 */
  function roomWorkspace(input: string): string {
    return resolveWorkspace(input);
  }

  app.post("/api/rooms", async (request, reply) => {
    if (!adminOnly(request, reply)) return reply;
    const body = createRoomRequestSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    try {
      const room = database.createRoom({
        ...body.data,
        ...(body.data.workspace ? { workspace: roomWorkspace(body.data.workspace) } : {}),
      });
      broadcastAll({ type: "rooms.changed", room: withBranch(room) });
      return reply.code(201).send({ room: withBranch(room) });
    } catch (error) {
      if (error instanceof HiveError && error.code === "ROOM_EXISTS") {
        return reply.code(409).send(hiveErrorBody(error));
      }
      if (error instanceof HiveError && error.code.startsWith("LOCAL_AGENT_CWD")) {
        return reply.code(400).send({ ...hiveErrorBody(error), code: "ROOM_WORKSPACE_INVALID" });
      }
      throw error;
    }
  });

  app.patch<{ Params: { roomId: string } }>("/api/rooms/:roomId", async (request, reply) => {
    const params = roomParamsSchema.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    if (!adminOnly(request, reply)) return reply;
    const body = updateRoomRequestSchema.safeParse(request.body);
    if (
      !body.success ||
      (body.data.name === undefined &&
        body.data.archived === undefined &&
        body.data.workspace === undefined &&
        body.data.leadAgent === undefined)
    ) {
      return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    }
    // 主 Agent 只能是这个房间里的 Agent；按房间里的大小写存
    let leadAgent = body.data.leadAgent;
    if (leadAgent) {
      const agent = database.findParticipant(params.data.roomId, leadAgent);
      if (!agent || agent.type !== "agent") {
        return reply.code(400).send({
          ...errorText(serverText("error.room.leadInvalid", { agent: leadAgent })),
          code: "ROOM_LEAD_INVALID",
        });
      }
      leadAgent = agent.username;
    }
    try {
      const room = withBranch(
        database.updateRoom(params.data.roomId, {
          ...body.data,
          ...(body.data.workspace ? { workspace: roomWorkspace(body.data.workspace) } : {}),
          ...(leadAgent !== undefined ? { leadAgent } : {}),
        }),
      );
      broadcastAll({ type: "rooms.changed", room });
      return { room };
    } catch (error) {
      if (error instanceof HiveError && error.code === "ROOM_NOT_FOUND") {
        return reply.code(404).send(hiveErrorBody(error));
      }
      if (error instanceof HiveError && error.code === "ROOM_PROTECTED") {
        return reply.code(400).send(hiveErrorBody(error));
      }
      if (error instanceof HiveError && error.code.startsWith("LOCAL_AGENT_CWD")) {
        return reply.code(400).send({ ...hiveErrorBody(error), code: "ROOM_WORKSPACE_INVALID" });
      }
      throw error;
    }
  });

  if (!hasWebUi) {
    app.get("/", async (_request, reply) => {
      return reply
        .type("text/html; charset=utf-8")
        .send(
          "<h1>SuperHive server is running</h1><p>Run <code>pnpm dev</code> for the Web UI.</p>",
        );
    });
  }

  app.get("/ws", { websocket: true }, (socket) => {
    const connection: Connection = { socket, lastHeartbeat: Date.now() };
    connections.add(connection);

    socket.on("message", (raw) => {
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        send(socket, {
          type: "error",
          code: "INVALID_JSON",
          ...wsText(serverText("error.ws.invalidJson")),
        });
        return;
      }
      const parsed = clientEventSchema.safeParse(json);
      if (!parsed.success) {
        const messageTooLong = parsed.error.issues.some(
          (issue) => issue.code === "too_big" && issue.path.join(".") === "content",
        );
        send(socket, {
          type: "error",
          code: messageTooLong ? "MESSAGE_TOO_LONG" : "INVALID_EVENT",
          ...wsText(
            messageTooLong
              ? serverText("error.message.tooLong", { max: LIMITS.maxMessageLength })
              : serverText("error.ws.invalidEvent"),
          ),
        });
        return;
      }
      const event = parsed.data;

      if (event.type === "participant.join") {
        if (connection.participant) {
          send(socket, {
            type: "error",
            code: "ALREADY_JOINED",
            ...wsText(serverText("error.ws.alreadyJoined")),
          });
          return;
        }
        const principal = principalForToken(event.token);
        if (!principal) {
          // 区分「从没被邀请」和「访问已到期 / 被移除」，后者给出明确原因
          const ended = isGuestToken(event.token)
            ? access.resolveToken(event.token, clock())
            : undefined;
          send(
            socket,
            ended && ended.state !== "active"
              ? { type: "error", ...endedMessages[ended.state] }
              : {
                  type: "error",
                  code: "UNAUTHORIZED",
                  ...wsText(serverText("error.ws.invalidToken")),
                },
          );
          socket.close(1008, "Unauthorized");
          return;
        }
        if (principal.kind === "guest") {
          const session = principal.resolved.session;
          if (
            session.roomId !== event.roomId ||
            session.kind !== event.participantType ||
            session.username.toLocaleLowerCase() !== event.username.toLocaleLowerCase()
          ) {
            send(socket, {
              type: "error",
              code: "ROOM_FORBIDDEN",
              ...wsText(
                serverText("error.invite.identity", {
                  name: session.username,
                  room: session.roomId,
                }),
              ),
            });
            socket.close(1008, "Forbidden");
            return;
          }
          if (!database.getRoom(session.roomId)) {
            send(socket, {
              type: "error",
              code: "ROOM_NOT_FOUND",
              ...wsText(serverText("error.room.notFound")),
            });
            socket.close(1008, "Room not found");
            return;
          }
        }
        connection.principal = principal;
        if (!/^[\p{L}\p{N}_.-]+$/u.test(event.username) || !/^[A-Za-z0-9_-]+$/.test(event.roomId)) {
          send(socket, {
            type: "error",
            code: "INVALID_NAME",
            ...wsText(serverText("error.name.format")),
          });
          return;
        }
        const { room, created: roomCreated } = database.ensureRoom(event.roomId, event.username);
        if (room.archivedAt) {
          send(socket, {
            type: "error",
            code: "ROOM_ARCHIVED",
            ...wsText(serverText("error.room.archivedJoin")),
          });
          socket.close(1008, "Room archived");
          return;
        }
        if (roomCreated) broadcastAll({ type: "rooms.changed", room });
        const key = participantKey(event.roomId, event.username);
        const namedConnections = onlineByName.get(key);
        const existingConnection = namedConnections?.values().next().value;
        const existingParticipant = existingConnection?.participant;
        if (
          existingParticipant &&
          (event.participantType !== "human" || existingParticipant.type !== "human")
        ) {
          send(socket, {
            type: "error",
            code: "USERNAME_TAKEN",
            ...wsText(serverText("error.name.online")),
          });
          return;
        }
        try {
          const participant =
            existingParticipant ??
            database.upsertParticipant({
              roomId: event.roomId,
              username: event.username,
              type: event.participantType,
              ...(event.persona ? { persona: event.persona } : {}),
              ...(event.provider ? { provider: event.provider } : {}),
            });
          connection.participant = participant;
          connection.lastHeartbeat = Date.now();
          const activeConnections = namedConnections ?? new Set<Connection>();
          activeConnections.add(connection);
          onlineByName.set(key, activeConnections);
          send(socket, {
            type: "room.snapshot",
            self: withAccess(participant),
            participants: participantsOf(event.roomId),
            messages: database.getRecentMessages(event.roomId),
            latestSeq: database.latestSeq(event.roomId),
            invocations: database.listInvocations(event.roomId),
            whiteboard: database.listWhiteboard(event.roomId),
            schedules: database.listSchedules(event.roomId),
            approvals: [...approvals.values()]
              .filter((item) => item.roomId === event.roomId)
              .map((item) => item.questionId),
            features: ["trace", "approval", "session"],
          });
          // 房主（或允许看过程的访客）刚打开或重连：把正在执行的调用的过程补上
          if (canSeeTrace(connection, event.roomId)) {
            for (const [invocationId, trace] of traces) {
              if (trace.roomId !== event.roomId) continue;
              send(socket, {
                type: "invocation.trace",
                roomId: trace.roomId,
                invocationId,
                steps: [...trace.steps.values()],
              });
            }
          }
          if (participant.type === "agent") {
            for (const invocation of database.listCancellingInvocations(participant.id)) {
              send(socket, { type: "agent.cancel", messageId: invocation.messageId });
            }
          }
          if (!existingParticipant) {
            broadcast(event.roomId, {
              type: "presence.changed",
              participant: withAccess(participant),
            });
            broadcastRoomActivity(event.roomId);
          }
        } catch (error) {
          const hiveError = error instanceof HiveError ? error : undefined;
          send(socket, {
            type: "error",
            code: hiveError?.code ?? "JOIN_FAILED",
            ...wsText(
              hiveError?.text ??
                (hiveError ? hiveError.message : serverText("error.ws.joinFailed")),
            ),
          });
        }
        return;
      }

      const participant = connection.participant;
      if (!participant) {
        send(socket, {
          type: "error",
          code: "NOT_JOINED",
          ...wsText(serverText("error.ws.notJoined")),
        });
        return;
      }
      // 访客每次操作前都复核期限：到期或被移除后，已建立的连接也不能再收发
      if (!ensureActive(connection)) return;
      const guest = connection.principal?.kind === "guest";
      const ownerOnly =
        event.type === "topic.start" ||
        event.type === "budget.extend" ||
        event.type === "whiteboard.remove";
      if (guest && ownerOnly) {
        send(socket, {
          type: "error",
          code: "OWNER_ONLY",
          ...wsText(serverText("error.guest.ownerActions")),
        });
        return;
      }
      if (guest && event.type === "invocation.dismiss") {
        const foreign = event.invocationIds.some(
          (id) => database.getInvocation(id)?.requesterId !== participant.id,
        );
        if (foreign) {
          send(socket, {
            type: "error",
            code: "OWNER_ONLY",
            ...wsText(serverText("error.guest.dismissOwn")),
          });
          return;
        }
      }
      if (guest && event.type === "schedule.cancel") {
        // 访客只能取消以自己名义排的定时任务
        if (database.getSchedule(event.scheduleId)?.requesterId !== participant.id) {
          send(socket, {
            type: "error",
            code: "OWNER_ONLY",
            ...wsText(serverText("error.guest.cancelScheduleOwn")),
          });
          return;
        }
      }
      if (guest && event.type === "invocation.preempt") {
        // 停下别人正在执行的任务：只有房主能做
        send(socket, {
          type: "error",
          code: "OWNER_ONLY",
          ...wsText(serverText("error.guest.preempt")),
        });
        return;
      }
      if (
        guest &&
        (event.type === "invocation.retry" ||
          event.type === "invocation.cancel" ||
          event.type === "invocation.steer")
      ) {
        const invocation = database.getInvocation(event.invocationId);
        // 访客只能管自己发起的调用；房主批准访客的请求不能由访客自己点
        if (
          !invocation ||
          invocation.requesterId !== participant.id ||
          (event.type === "invocation.retry" && invocation.blockReason === "guest_approval")
        ) {
          send(socket, {
            type: "error",
            code: "OWNER_ONLY",
            ...wsText(serverText("error.guest.manageOwn")),
          });
          return;
        }
      }

      if (event.type === "presence.heartbeat") {
        connection.lastHeartbeat = Date.now();
        if (connection.participant?.status === "offline") setStatus(connection, "online");
        return;
      }
      if (event.type === "agent.typing") {
        if (participant.type === "agent") setStatus(connection, event.active ? "busy" : "online");
        return;
      }
      if (event.type === "message.ack") return;
      if (event.type === "invocation.trace") {
        if (participant.type === "agent") recordTrace(participant, event.messageId, event.steps);
        return;
      }
      if (event.type === "approval.request") {
        if (participant.type === "agent") requestApproval(participant, event);
        return;
      }
      if (event.type === "agent.session") {
        // 只认房主自己的 Agent（joinToken 接入）：访客带入的 Agent 不能冒充本机 Agent 上报，
        // 否则房主点「在终端打开」时会 cd 进它给的目录（那里的配置、钩子可以跑任意代码）
        if (participant.type === "agent" && !guest) {
          agentSessions.set(participant.id, { sessionId: event.sessionId, cwd: event.cwd });
        }
        return;
      }
      if (
        event.type === "invocation.report" ||
        event.type === "invocation.retry" ||
        event.type === "invocation.cancel" ||
        event.type === "invocation.dismiss" ||
        event.type === "budget.extend" ||
        event.type === "whiteboard.remove" ||
        event.type === "schedule.cancel" ||
        event.type === "invocation.steer" ||
        event.type === "invocation.preempt"
      ) {
        try {
          if (event.type === "invocation.report") {
            if (participant.type !== "agent") {
              throw new HiveError("FORBIDDEN", serverText("error.auth.agentsReportOnly"));
            }
            handleReport(participant, event);
            return;
          }
          if (participant.type !== "human") {
            throw new HiveError("FORBIDDEN", serverText("error.auth.humansManageTasks"));
          }
          if (event.type === "invocation.dismiss") {
            for (const invocation of database.dismissInvocations(
              participant.roomId,
              event.invocationIds,
              participant.username,
            )) {
              broadcastAll({ type: "invocation.updated", invocation });
            }
          } else if (event.type === "invocation.retry")
            retryInvocation(participant, event.invocationId);
          else if (event.type === "invocation.cancel") {
            cancelInvocation(participant, event.invocationId);
          } else if (event.type === "budget.extend") extendBudget(participant, event.turns);
          else if (event.type === "schedule.cancel") cancelSchedule(participant, event.scheduleId);
          else if (event.type === "invocation.steer")
            steerInvocation(participant, event.invocationId);
          else if (event.type === "invocation.preempt") {
            preemptInvocation(participant, event.invocationId);
          } else if (database.removeWhiteboardEntry(participant.roomId, event.entryId)) {
            broadcast(participant.roomId, {
              type: "whiteboard.removed",
              roomId: participant.roomId,
              entryId: event.entryId,
            });
          }
        } catch (error) {
          const hiveError = error instanceof HiveError ? error : undefined;
          send(socket, {
            type: "error",
            code: hiveError?.code ?? "REQUEST_FAILED",
            ...wsText(
              hiveError?.text ??
                (hiveError ? hiveError.message : serverText("error.ws.requestFailed")),
            ),
          });
        }
        return;
      }
      if (event.type === "topic.start") {
        // 只有人能开启新话题；Agent 不能借此清掉其他 Agent 的上下文
        if (participant.type !== "human") {
          send(socket, {
            type: "error",
            code: "TOPIC_FORBIDDEN",
            ...wsText(serverText("error.topic.humansOnly")),
          });
          return;
        }
        const started = serverText("topic.started", { name: participant.username });
        createAndDispatchMessage(participant, {
          content: zhText(started),
          text: started,
          clientMessageId: `topic-${randomUUID()}`,
          kind: "topic",
        });
        return;
      }
      if (event.type === "message.delete") {
        try {
          const message = database.deleteMessage(participant, event.messageId);
          attachments.revokeForMessage(message.id);
          broadcast(participant.roomId, { type: "message.deleted", message });
          if (event.stop) stopRecalledTasks(participant, message);
        } catch (error) {
          const hiveError = error instanceof HiveError ? error : undefined;
          send(socket, {
            type: "error",
            code: hiveError?.code ?? "DELETE_FAILED",
            ...wsText(
              hiveError?.text ??
                (hiveError ? hiveError.message : serverText("error.ws.recallFailed")),
            ),
          });
        }
        return;
      }

      if (event.type === "question.answer") {
        try {
          if (participant.type !== "human") {
            throw new HiveError("FORBIDDEN", serverText("error.auth.humansAnswer"));
          }
          const result = submitAnswer(participant, event);
          if (!result.created) send(socket, { type: "message.created", message: result.message });
        } catch (error) {
          const hiveError = error instanceof HiveError ? error : undefined;
          send(socket, {
            type: "error",
            code: hiveError?.code ?? "ANSWER_FAILED",
            ...wsText(
              hiveError?.text ??
                (hiveError ? hiveError.message : serverText("error.ws.answerFailed")),
            ),
          });
        }
        return;
      }

      try {
        // 重发同一条消息（断线重试）直接返回已有结果，附件此时已经绑定在那条消息上
        const sent = database.findMessageByClientId(participant.id, event.clientMessageId);
        if (sent) {
          send(socket, { type: "message.created", message: sent });
          return;
        }
        const attachmentIds = [...new Set(event.attachmentIds ?? [])];
        const claimed =
          attachmentIds.length && connection.principal
            ? attachments.claim(attachmentIds, {
                roomId: participant.roomId,
                uploader: uploaderOf(connection.principal),
              })
            : undefined;
        const result = createAndDispatchMessage(
          participant,
          {
            content: event.content,
            clientMessageId: event.clientMessageId,
            ...(event.replyToMessageId ? { replyToMessageId: event.replyToMessageId } : {}),
            ...(event.parentMessageId ? { parentMessageId: event.parentMessageId } : {}),
            ...(claimed
              ? {
                  attachments: claimed,
                  onInsert: (messageId: string) => attachments.bind(attachmentIds, messageId),
                }
              : {}),
          },
          event.steer ? { steer: true } : {},
        );
        if (!result.created) {
          send(socket, { type: "message.created", message: result.message });
          return;
        }
      } catch (error) {
        const hiveError = error instanceof HiveError ? error : undefined;
        send(socket, {
          type: "error",
          code: hiveError?.code ?? "MESSAGE_FAILED",
          ...wsText(
            hiveError?.text ?? (hiveError ? hiveError.message : serverText("error.ws.sendFailed")),
          ),
        });
      }
    });

    socket.on("close", () => disconnect(connection));
    socket.on("error", () => disconnect(connection));
  });

  const heartbeatTimer = setInterval(
    () => {
      const now = Date.now();
      for (const connection of connections) {
        if (connection.participant && now - connection.lastHeartbeat > heartbeatTimeoutMs) {
          connection.socket.close(1001, "Heartbeat timeout");
          disconnect(connection);
        }
      }
    },
    Math.min(15_000, Math.max(1_000, heartbeatTimeoutMs / 3)),
  );
  heartbeatTimer.unref();
  const invocationTimer = setInterval(sweepStaleInvocations, options.invocationSweepMs ?? 30_000);
  // 分支是在工作区里切的（Agent 或人在终端里切），没有事件可听：隔一会儿读一下 HEAD
  const branchTimer = setInterval(() => {
    try {
      checkRoomBranches();
    } catch (error) {
      app.log.warn({ err: error }, "room branch check failed");
    }
  }, options.branchCheckMs ?? 10_000);
  branchTimer.unref();
  // 到点就断开访客，不等它下一次操作；每次操作和重连时也会复核
  const accessTimer = setInterval(sweepExpiredAccess, options.accessSweepMs ?? 10_000);
  // 测试里直接触发清理
  app.decorate("attachmentStore", attachments);
  app.decorate("runSchedules", runSchedules);
  app.decorate("hiveDatabase", database);
  /**
   * 关闭前先让本机 Agent 正常下线：要趁 WebSocket 还连着（Windows 上靠它通知 Agent 退出），
   * app.close() 时连接已经被关掉了。换代交接时不下线，由 onClose 交给下一个 Server。
   */
  app.decorate("prepareClose", async () => {
    if (localAgents && !handoverPending(options.handoverFile)) await localAgents.shutdown();
  });
  const attachmentTimer = setInterval(
    () => {
      try {
        attachments.sweep();
      } catch (error) {
        app.log.warn({ err: error }, "attachment sweep failed");
      }
    },
    options.attachmentSweepMs ?? 10 * 60_000,
  );
  attachmentTimer.unref();
  invocationTimer.unref();

  app.addHook("onReady", async () => {
    localAgents?.start();
    imHub.start();
    supersedeStale();
    for (const invocation of database.listPendingContinuations())
      deliverContinuation(invocation.id);
    // 重启前到点没发出的定时任务：宽限期内照常发出，超过的标为错过
    runSchedules();
  });

  app.addHook("onClose", async () => {
    shuttingDown = true;
    keepAwake?.close();
    // 换代重启：本机 Agent 交给下一个 Server 接管，正在跑的任务不中断；否则先让它们正常离线
    if (localAgents && consumeHandover(options.handoverFile)) {
      localAgents.detach();
      app.log.info("本机 Agent 已交接给下一个 Server，进程保持运行");
    } else {
      await localAgents?.shutdown();
    }
    await imHub.close();
    clearInterval(heartbeatTimer);
    clearInterval(invocationTimer);
    clearInterval(branchTimer);
    clearInterval(accessTimer);
    clearInterval(attachmentTimer);
    if (scheduleTimer) clearTimeout(scheduleTimer);
    for (const connection of connections) {
      if (connection.participant)
        database.setParticipantStatus(connection.participant.id, "offline");
      connection.socket.close(1001, "Server shutting down");
    }
    connections.clear();
    onlineByName.clear();
    database.close();
  });

  return app;
}
