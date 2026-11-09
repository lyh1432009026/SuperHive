import { serverText } from "@superhive/protocol";
import { errorText, hiveErrorBody } from "./texts.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createLocalAgentRequestSchema,
  localAgentProviderSchema,
  updateLocalAgentSettingsRequestSchema,
  keepAwakeSettingsSchema,
  type KeepAwakeSettings,
  type KeepAwakeState,
  type LocalAgent,
  type LocalSessionResponse,
  resumeCommand,
} from "@superhive/protocol";
import QRCode from "qrcode";
import { HiveError } from "./database.js";
import type { HostApproval, HostApprovals } from "./host-approvals.js";
import type { OwnerDevice } from "./owner-devices.js";
import { checkLocalRequest, type LocalCheck } from "./local-access.js";
import { listDirectories } from "./local-directories.js";
import { openTerminal } from "./open-terminal.js";
import type { LocalAgentSupervisor } from "./local-agents.js";

/**
 * 本机 Agent 的 HTTP 接口（管理 Hive Server 所在电脑）。请求方必须是下面两种之一：
 * 1. 本机房主：来自 Server 所在电脑（checkLocalRequest），且携带本次进程启动时生成的房主 token
 *    （X-Hive-Owner），它只经 /api/local/session 交给本机页面；
 * 2. 房主设备：房主扫码或经飞书登录的其他设备，Authorization 携带有效的设备令牌（hod_）。
 *    令牌放在请求头里，跨站页面带不上；可以单独退出。
 * 总令牌（join token）不算：Agent 也持有它，放行就等于远程 Agent 能在这台电脑上起进程。访客更不算。
 *
 * 接口分三级：
 * - read：只读（列目录、Agent 状态、MCP 列表、日志），登录的设备直接可用；
 * - manage：会在这台电脑上起进程或改设置。设备要先申请、经本机或可批准的 IM 账号批准，获批后 12 小时内可用，
 *   每次操作记审计日志并推到房主 IM；用完全权限起进程还要逐次批准（stepUp）；
 * - local：凭据类（生成登录二维码、显示总令牌、登记可批准的 IM 账号），只限本机。
 */

const OWNER_HEADER = "x-hive-owner";

const ERROR_STATUS: Record<string, number> = {
  LOCAL_AGENT_NOT_FOUND: 404,
  LOCAL_AGENT_NAME_TAKEN: 409,
  LOCAL_AGENT_CWD_REQUIRED: 400,
  LOCAL_AGENT_CWD_INVALID: 400,
  LOCAL_DIRECTORY_INVALID: 400,
  LOCAL_DIRECTORY_NOT_FOUND: 404,
  ROOM_NOT_FOUND: 404,
  NOT_A_MEMBER: 403,
  LOCAL_AGENT_MCP_UNSUPPORTED: 400,
  LOCAL_AGENT_MCP_LIST_FAILED: 502,
  LOCAL_AGENT_BUSY: 409,
  LOCAL_AGENT_CONFIG_CHANGED: 409,
};

/** 批准单绑定的 Agent 配置：获批后权限、目录、模型、MCP 任一变化都不算同一件事 */
function configFingerprint(agent: LocalAgent): string {
  return JSON.stringify({
    provider: agent.provider,
    name: agent.name,
    access: agent.access,
    cwd: agent.cwd,
    model: agent.model,
    mcpDisabled: [...agent.mcpDisabled].sort(),
  });
}

export type LocalCaller = { kind: "local" } | { kind: "device"; id: string; name: string };

/** read：只读；manage：会在这台电脑上起进程或改设置；local：凭据类，只限本机 */
type Level = "read" | "manage" | "local";

/** 设备获批后能管理这台电脑多久 */
export const MANAGE_GRANT_MS = 12 * 60 * 60_000;

const APPROVAL_HEADER = "x-hive-approval";

export type LocalRoomActions = {
  /** 请求是否来自 Server 所在电脑；默认 checkLocalRequest（不放行别的端口上的网页） */
  isLocal?: (request: FastifyRequest) => LocalCheck;
  clearRoom: (roomId: string, username: string) => { messages: number; invocations: number };
  /** 房主在其他设备上的登录 */
  ownerDevices?: {
    list(): OwnerDevice[];
    revoke(id: string): boolean;
    revokeAll(except?: string): string[];
    pair(): { ticket: string; expiresAt: string };
    webBase(): string | undefined;
    joinToken(): string;
    /** 设备令牌对应的设备；无效、已退出、超期或闲置过久时为 undefined */
    resolve(token: string): OwnerDevice | undefined;
  };
  /** 其他设备管理这台电脑要经过的批准 */
  approvals?: {
    store: HostApprovals;
    /** 把批准卡推到可批准的 IM 账号，返回推出去的数量（0 表示只能回本机批准） */
    send(approval: HostApproval): number;
    /** 有没有可批准的 IM 账号 */
    remote(): boolean;
    /** 批准或拒绝（本机网页和 IM 卡片共用）：manage 获批时给设备授予管理权 */
    decide(id: string, allow: boolean, by: string): HostApproval | undefined;
    /** 可以批准的 IM 账号：只能在本机登记 */
    approvers(): Array<{ connectionId: string; channel: string; label: string; allowed: boolean }>;
    setApprover(connectionId: string, allowed: boolean): boolean;
  };
  /** 房主设备上做了会在这台电脑上起进程、改设置的操作：推到房主 IM，便于发现设备被盗用 */
  notifyOwner?: (text: string) => void;
  /** Agent 在某个房间当前的 Provider 会话（Bridge 上报）；busy：这一轮还在执行 */
  agentSession?: (
    roomId: string,
    agentName: string,
  ) => { sessionId: string; cwd: string; busy: boolean } | undefined;
  /** 在这台电脑上开终端执行命令；测试里替换掉 */
  openTerminal?: (command: string) => Promise<void>;
  /** 熄屏后保持在线 */
  keepAwake?: {
    state(): KeepAwakeState | undefined;
    update(patch: Partial<KeepAwakeSettings>): KeepAwakeState | undefined;
  };
};

export function registerLocalAgentRoutes(
  app: FastifyInstance,
  supervisor: LocalAgentSupervisor | undefined,
  rooms: LocalRoomActions,
): void {
  const ownerToken = randomBytes(32).toString("hex");
  const ownerBuffer = Buffer.from(ownerToken);

  const hostLabel = hostname().replace(/\.local$/, "");
  const isLocal = rooms.isLocal ?? ((request: FastifyRequest) => checkLocalRequest(request));
  /** 带了设备令牌但无效（退出、超期）：直接拒绝，不能退回去按本机身份放行 */
  const staleDevice = (request: FastifyRequest, device: OwnerDevice | undefined) =>
    !device && Boolean(request.headers.authorization?.startsWith("Bearer hod_"));

  /** 带着有效设备令牌的请求：房主在其他设备上登录 */
  function deviceOf(request: FastifyRequest): OwnerDevice | undefined {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return undefined;
    return rooms.ownerDevices?.resolve(header.slice(7));
  }

  app.get("/api/local/session", async (request): Promise<LocalSessionResponse> => {
    if (!supervisor) return { enabled: false, reason: "本机 Agent 已在服务端关闭" };
    // 带着设备令牌来的按设备对待，即使页面开在这台电脑上：只下发和它身份相符的能力
    const device = deviceOf(request);
    if (staleDevice(request, device)) {
      return { enabled: false, reason: "这台设备的登录已失效，请重新扫码或在飞书里发 /web。" };
    }
    if (device) {
      return {
        enabled: true,
        mode: "device",
        deviceId: device.id,
        hostLabel,
        manageUntil: device.manageUntil,
        approval: rooms.approvals?.remote() ? "im" : "local",
      };
    }
    const check = isLocal(request);
    if (!check.local) return { enabled: false, reason: check.reason };
    return { enabled: true, mode: "local", ownerToken, hostLabel };
  });

  /** 校验请求方能否调用这一级接口；不能时发出响应并返回 undefined */
  function authorize(
    request: FastifyRequest,
    reply: FastifyReply,
    level: Level,
  ): LocalCaller | undefined {
    if (!supervisor) {
      void reply.code(404).send({ ...errorText(serverText("error.localAgent.disabled")) });
      return undefined;
    }
    const provided = request.headers[OWNER_HEADER];
    const device = deviceOf(request);
    if (staleDevice(request, device)) {
      void reply.code(401).send({
        ...errorText(serverText("error.device.sessionInvalid")),
        code: "DEVICE_SESSION_INVALID",
      });
      return undefined;
    }
    // 带了本机凭证就只按本机校验：设备令牌不能和本机凭证混用
    if (provided === undefined) {
      if (device) {
        if (level === "local") {
          void reply.code(403).send({
            ...errorText(serverText("error.device.localOnly")),
            code: "LOCAL_ONLY",
          });
          return undefined;
        }
        if (
          level === "manage" &&
          !(device.manageUntil && Date.parse(device.manageUntil) > Date.now())
        ) {
          void reply.code(403).send({
            ...errorText(serverText("error.device.manageRequired")),
            code: "MANAGE_REQUIRED",
          });
          return undefined;
        }
        return { kind: "device", id: device.id, name: device.name };
      }
    }
    const check = isLocal(request);
    if (!check.local) {
      void reply.code(403).send({ error: check.reason });
      return undefined;
    }
    const buffer = Buffer.from(typeof provided === "string" ? provided : "");
    if (buffer.length !== ownerBuffer.length || !timingSafeEqual(buffer, ownerBuffer)) {
      void reply.code(401).send({ ...errorText(serverText("error.device.ownerCredential")) });
      return undefined;
    }
    return { kind: "local" };
  }

  /**
   * 单次高危操作（用完全权限起进程）：设备上每次都要批准。
   * 带着已批准、未用过、同一设备同一参数的批准单才放行；否则发起批准并回 403 APPROVAL_REQUIRED。
   */
  function stepUp(
    request: FastifyRequest,
    reply: FastifyReply,
    caller: LocalCaller,
    fingerprint: string,
    summary: string,
  ): boolean {
    if (caller.kind === "local") return true;
    const approvals = rooms.approvals;
    if (!approvals) {
      void reply.code(403).send({ ...errorText(serverText("error.device.localOnly")) });
      return false;
    }
    const presented = request.headers[APPROVAL_HEADER];
    if (
      typeof presented === "string" &&
      approvals.store.consume(presented, caller.id, fingerprint)
    ) {
      return true;
    }
    const approval = approvals.store.create({
      kind: "action",
      deviceId: caller.id,
      deviceName: caller.name,
      summary,
      fingerprint,
    });
    const delivered = approvals.send(approval);
    void reply.code(403).send({
      error: delivered
        ? "这项操作需要你在飞书里确认一次。"
        : "这项操作需要在 Hive Server 所在的电脑上确认一次。",
      code: "APPROVAL_REQUIRED",
      approval,
      delivered,
    });
    return false;
  }

  /** 房主设备上的操作：记审计日志；notify 时再推一条到房主 IM */
  function audit(request: FastifyRequest, caller: LocalCaller, action: string, notify = false) {
    if (caller.kind !== "device") return;
    request.log.info(
      { ownerDevice: { id: caller.id, name: caller.name }, action },
      "owner device action",
    );
    if (notify)
      rooms.notifyOwner?.(
        `已登录的设备「${caller.name}」在 ${hostLabel} 上${action}。如果不是你本人操作，请立即在设置 → 已登录设备里全部退出。`,
      );
  }

  function fail(reply: FastifyReply, error: unknown) {
    if (error instanceof HiveError && ERROR_STATUS[error.code]) {
      return reply.code(ERROR_STATUS[error.code]!).send(hiveErrorBody(error));
    }
    throw error;
  }

  app.get("/api/local/owner-devices", async (request, reply) => {
    if (!authorize(request, reply, "read")) return reply;
    if (!rooms.ownerDevices) return reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });
    return { devices: rooms.ownerDevices.list() };
  });

  /** 退出一台设备：退出自己随时可以；退出别的设备要有管理权 */
  app.delete<{ Params: { id: string } }>("/api/local/owner-devices/:id", async (request, reply) => {
    const self = deviceOf(request)?.id === request.params.id;
    const caller = authorize(request, reply, self ? "read" : "manage");
    if (!caller) return reply;
    if (!rooms.ownerDevices?.revoke(request.params.id)) {
      return reply.code(404).send({ ...errorText(serverText("error.device.notFound")) });
    }
    rooms.approvals?.store.dropDevice(request.params.id);
    if (!self) audit(request, caller, "退出了另一台已登录的设备", true);
    return { ok: true };
  });

  /** 全部退出：丢了设备时用。在设备上操作时保留它自己 */
  app.post("/api/local/owner-devices/revoke-all", async (request, reply) => {
    const caller = authorize(request, reply, "manage");
    if (!caller) return reply;
    const owner = rooms.ownerDevices;
    if (!owner) return reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });
    const revoked = owner.revokeAll(caller.kind === "device" ? caller.id : undefined);
    for (const id of revoked) rooms.approvals?.store.dropDevice(id);
    audit(request, caller, `退出了其他 ${revoked.length} 台已登录的设备`, true);
    return { revoked: revoked.length };
  });

  /* ---------- 其他设备申请管理这台电脑 ---------- */

  app.post("/api/local/manage-request", async (request, reply) => {
    const device = deviceOf(request);
    if (!device) {
      return reply
        .code(400)
        .send({ ...errorText(serverText("error.device.notADevice")), code: "NOT_A_DEVICE" });
    }
    if (!authorize(request, reply, "read")) return reply;
    const approvals = rooms.approvals;
    if (!approvals) return reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });
    const approval = approvals.store.create({
      kind: "manage",
      deviceId: device.id,
      deviceName: device.name,
      summary: `设备「${device.name}」申请在 12 小时内管理 ${hostLabel}（启动、停止本机 Agent，修改设置）。获批后它能启动的 Agent 和 MCP 可能在没有沙箱的情况下执行命令；只有用完全权限启动时会再逐次确认。`,
    });
    return { approval, delivered: approvals.send(approval) };
  });

  /** 设备查自己的申请批了没有；本机能查全部 */
  app.get<{ Params: { id: string } }>("/api/local/approvals/:id", async (request, reply) => {
    const caller = authorize(request, reply, "read");
    if (!caller) return reply;
    const approval = rooms.approvals?.store.get(request.params.id);
    if (!approval || (caller.kind === "device" && approval.deviceId !== caller.id)) {
      return reply.code(404).send({ ...errorText(serverText("error.approval.requestNotFound")) });
    }
    return { approval };
  });

  /** 本机网页：待批准的申请 */
  app.get("/api/local/approvals", async (request, reply) => {
    if (!authorize(request, reply, "local")) return reply;
    return { approvals: rooms.approvals?.store.pending() ?? [] };
  });

  app.post<{ Params: { id: string }; Body: { allow?: unknown } }>(
    "/api/local/approvals/:id/decision",
    async (request, reply) => {
      if (!authorize(request, reply, "local")) return reply;
      if (typeof request.body?.allow !== "boolean") {
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      }
      const approval = rooms.approvals?.decide(request.params.id, request.body.allow, "local");
      if (!approval) return reply.code(404).send({ ...errorText(serverText("error.approval.requestHandled")) });
      return { approval };
    },
  );

  /** 哪些 IM 账号可以在卡片上批准：登记本身只限本机 */
  app.get("/api/local/host-approvers", async (request, reply) => {
    if (!authorize(request, reply, "local")) return reply;
    return { approvers: rooms.approvals?.approvers() ?? [] };
  });

  app.put<{ Params: { connectionId: string }; Body: { allowed?: unknown } }>(
    "/api/local/host-approvers/:connectionId",
    async (request, reply) => {
      if (!authorize(request, reply, "local")) return reply;
      if (typeof request.body?.allowed !== "boolean") {
        return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
      }
      if (!rooms.approvals?.setApprover(request.params.connectionId, request.body.allowed)) {
        return reply.code(404).send({ ...errorText(serverText("error.im.connectionNotFound")) });
      }
      return { approvers: rooms.approvals.approvers() };
    },
  );

  /** 在其他设备上登录：一次性链接和二维码，5 分钟内有效 */
  app.post<{ Body: { origin?: string } }>(
    "/api/local/owner-devices/pair",
    async (request, reply) => {
      if (!authorize(request, reply, "local")) return reply;
      const owner = rooms.ownerDevices;
      if (!owner) return reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });
      const { ticket, expiresAt } = owner.pair();
      // 页面自己的地址（开发时是 Vite 端口）优先；页面开在 localhost 上时换成服务公布的地址
      const origin = typeof request.body?.origin === "string" ? request.body.origin : "";
      const base =
        origin && !/^https?:\/\/(localhost|127\.|\[::1\])/i.test(origin)
          ? origin.replace(/\/$/, "")
          : (owner.webBase() ?? origin.replace(/\/$/, ""));
      const url = `${base}/?login=${ticket}`;
      return { url, expiresAt, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 240 }) };
    },
  );

  /** 显示总令牌：只给本机房主，用于手动在其他设备上填入或接入远程 Agent */
  app.get("/api/local/owner-token", async (request, reply) => {
    if (!authorize(request, reply, "local")) return reply;
    if (!rooms.ownerDevices) return reply.code(404).send({ ...errorText(serverText("error.feature.disabled")) });
    return { token: rooms.ownerDevices.joinToken() };
  });

  app.get("/api/local/keep-awake", async (request, reply) => {
    if (!authorize(request, reply, "read")) return reply;
    const state = rooms.keepAwake?.state();
    if (!state) return reply.code(404).send({ ...errorText(serverText("error.keepAwake.disabled")) });
    return state;
  });

  app.put("/api/local/keep-awake", async (request, reply) => {
    const caller = authorize(request, reply, "manage");
    if (!caller) return reply;
    const parsed = keepAwakeSettingsSchema.partial().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    const patch = Object.fromEntries(
      Object.entries(parsed.data).filter(([, value]) => value !== undefined),
    ) as Partial<KeepAwakeSettings>;
    const state = rooms.keepAwake?.update(patch);
    if (!state) return reply.code(404).send({ ...errorText(serverText("error.keepAwake.disabled")) });
    audit(request, caller, "修改了熄屏后保持在线的设置", true);
    return state;
  });

  app.get("/api/local/providers", async (request, reply) => {
    if (!authorize(request, reply, "read")) return reply;
    return { providers: await supervisor!.providers() };
  });

  app.get<{ Querystring: { path?: string } }>("/api/local/directories", async (request, reply) => {
    if (!authorize(request, reply, "read")) return reply;
    try {
      return listDirectories(request.query.path);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/api/local/agents", async (request, reply) => {
    if (!authorize(request, reply, "read")) return reply;
    return { agents: supervisor!.list() };
  });

  app.post("/api/local/agents", async (request, reply) => {
    const caller = authorize(request, reply, "manage");
    if (!caller) return reply;
    const parsed = createLocalAgentRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    if (
      parsed.data.access === "full" &&
      !stepUp(
        request,
        reply,
        caller,
        `create:${JSON.stringify(parsed.data)}`,
        `用完全权限启动本机 Agent ${parsed.data.name}（${parsed.data.provider}${parsed.data.cwd ? `，目录 ${parsed.data.cwd}` : ""}）`,
      )
    ) {
      return reply;
    }
    try {
      const agent = supervisor!.create(parsed.data);
      audit(
        request,
        caller,
        `启动了本机 Agent ${agent.name}（${agent.provider}，${agent.access}）`,
        true,
      );
      return reply.code(201).send({ agent });
    } catch (error) {
      return fail(reply, error);
    }
  });

  for (const action of ["start", "stop", "restart"] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/local/agents/:id/${action}`,
      async (request, reply) => {
        const caller = authorize(request, reply, "manage");
        if (!caller) return reply;
        const id = request.params.id;
        const target = supervisor!.list().find((agent) => agent.id === id);
        if (
          action !== "stop" &&
          target?.access === "full" &&
          !stepUp(
            request,
            reply,
            caller,
            // 绑定这次要执行的配置：获批后改了权限、目录、MCP，旧批准单就不算数
            `${action}:${id}:${configFingerprint(target)}`,
            `${action === "start" ? "启动" : "重启"}完全权限的本机 Agent ${target.name}`,
          )
        ) {
          return reply;
        }
        // 重启要先等旧进程退出：真正启动前再核对一次配置还是批准时那份
        const approved =
          caller.kind === "device" && target?.access === "full"
            ? configFingerprint(target)
            : undefined;
        try {
          const agent =
            action === "start"
              ? supervisor!.startAgent(id)
              : action === "stop"
                ? await supervisor!.stop(id)
                : await supervisor!.restart(
                    id,
                    approved ? (current) => configFingerprint(current) === approved : undefined,
                  );
          const verb = { start: "启动", stop: "停止", restart: "重启" }[action];
          audit(request, caller, `${verb}了本机 Agent ${agent.name}`, action !== "stop");
          return { agent };
        } catch (error) {
          return fail(reply, error);
        }
      },
    );
  }

  /**
   * 接入前预览：某个 provider 在该目录下会加载的本机 MCP（只读配置）。
   * 估算开局 token 要真的连上各个 MCP（会起进程），走 POST …/measure，按 manage 校验。
   */
  async function mcpCandidates(
    request: FastifyRequest,
    reply: FastifyReply,
    input: { provider?: unknown; cwd?: unknown },
    measure: boolean,
  ) {
    const caller = authorize(request, reply, measure ? "manage" : "read");
    if (!caller) return reply;
    const provider = localAgentProviderSchema.safeParse(input.provider);
    if (!provider.success) return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    if (measure) audit(request, caller, "测量了本机 MCP");
    try {
      return await supervisor!.mcpCandidates(
        provider.data,
        (typeof input.cwd === "string" && input.cwd.trim()) || undefined,
        measure,
      );
    } catch (error) {
      return fail(reply, error);
    }
  }

  app.get<{ Querystring: { provider?: string; cwd?: string } }>(
    "/api/local/mcp",
    (request, reply) => mcpCandidates(request, reply, request.query, false),
  );
  app.post<{ Body: { provider?: unknown; cwd?: unknown } }>(
    "/api/local/mcp/measure",
    (request, reply) => mcpCandidates(request, reply, request.body ?? {}, true),
  );

  /** 这个 Agent 会加载的本机 MCP；POST …/measure 时逐个连上估算开局 token（较慢，会起进程） */
  async function mcpServers(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    measure: boolean,
  ) {
    const caller = authorize(request, reply, measure ? "manage" : "read");
    if (!caller) return reply;
    if (measure) audit(request, caller, "测量了本机 MCP");
    try {
      return await supervisor!.mcpServers(request.params.id, measure);
    } catch (error) {
      return fail(reply, error);
    }
  }

  app.get<{ Params: { id: string } }>("/api/local/agents/:id/mcp", (request, reply) =>
    mcpServers(request, reply, false),
  );
  app.post<{ Params: { id: string } }>("/api/local/agents/:id/mcp/measure", (request, reply) =>
    mcpServers(request, reply, true),
  );

  /** 这个 Agent 在房间里的会话：能不能在终端里接着它、用什么命令 */
  function sessionFor(id: string, roomId: string | undefined) {
    const agent = supervisor!.get(id);
    const session = roomId ? rooms.agentSession?.(roomId, agent.name) : undefined;
    const command = session
      ? resumeCommand({
          provider: agent.provider,
          sessionId: session.sessionId,
          cwd: session.cwd,
          platform: process.platform,
        })
      : undefined;
    return { agent, session, command };
  }

  app.get<{ Params: { id: string }; Querystring: { roomId?: string } }>(
    "/api/local/agents/:id/session",
    async (request, reply) => {
      if (!authorize(request, reply, "read")) return reply;
      try {
        const { session, command } = sessionFor(request.params.id, request.query.roomId);
        return session && command
          ? {
              available: true,
              sessionId: session.sessionId,
              cwd: session.cwd,
              command,
              busy: session.busy,
            }
          : { available: false };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /**
   * 在这台电脑上开终端，接着 Agent 在这个房间的同一个会话（只限本机）。
   * 它正在执行时不开：两边同时写一个会话会把上下文搅乱。
   */
  app.post<{ Params: { id: string }; Body: { roomId?: unknown; force?: unknown } }>(
    "/api/local/agents/:id/terminal",
    async (request, reply) => {
      const caller = authorize(request, reply, "local");
      if (!caller) return reply;
      const roomId = typeof request.body?.roomId === "string" ? request.body.roomId : undefined;
      try {
        const { agent, session, command } = sessionFor(request.params.id, roomId);
        if (!session || !command) {
          return reply.code(409).send({
            ...errorText(serverText("error.terminal.noSession", { agent: agent.name })),
            code: "SESSION_UNAVAILABLE",
          });
        }
        // 执行中也能打开（人想看它做到哪了），只是先提醒一次，确认后带 force 再来
        if (session.busy && request.body?.force !== true) {
          return reply.code(409).send({
            ...errorText(serverText("error.terminal.agentBusy", { agent: agent.name })),
            code: "AGENT_BUSY",
            command,
          });
        }
        await (rooms.openTerminal ?? openTerminal)(command);
        audit(request, caller, `在终端里打开了本机 Agent ${agent.name} 的会话`);
        return { opened: true, command };
      } catch (error) {
        if (error instanceof Error && !(error instanceof HiveError)) {
          return reply.code(500).send({ error: error.message, code: "TERMINAL_FAILED" });
        }
        return fail(reply, error);
      }
    },
  );

  app.put<{ Params: { id: string } }>("/api/local/agents/:id/settings", async (request, reply) => {
    const caller = authorize(request, reply, "manage");
    if (!caller) return reply;
    const parsed = updateLocalAgentSettingsRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ...errorText(serverText("error.request.invalid")) });
    try {
      const agent = supervisor!.updateSettings(request.params.id, parsed.data);
      audit(
        request,
        caller,
        parsed.data.mcpDisabled !== undefined
          ? `修改了本机 Agent ${agent.name} 加载的 MCP`
          : `${parsed.data.autoSteer ? "打开" : "关闭"}了本机 Agent ${agent.name} 的自动插话`,
        true,
      );
      return { agent };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/local/agents/:id", async (request, reply) => {
    const caller = authorize(request, reply, "manage");
    if (!caller) return reply;
    try {
      const name = supervisor!.list().find((agent) => agent.id === request.params.id)?.name;
      await supervisor!.remove(request.params.id);
      audit(request, caller, `删除了本机 Agent ${name ?? request.params.id}`, true);
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** 清空房间：不可恢复，和启动进程同级；房主设备上清空时推到 IM */
  app.post<{ Params: { roomId: string }; Body: { username?: unknown } }>(
    "/api/local/rooms/:roomId/clear",
    async (request, reply) => {
      const caller = authorize(request, reply, "manage");
      if (!caller) return reply;
      const username = request.body?.username;
      if (typeof username !== "string" || !username.trim()) {
        return reply.code(400).send({ ...errorText(serverText("error.request.missingActor")) });
      }
      try {
        const removed = rooms.clearRoom(request.params.roomId, username.trim());
        audit(request, caller, `清空了房间 ${request.params.roomId}`, true);
        return { removed };
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/local/agents/:id/logs", async (request, reply) => {
    // 日志里可能有路径或密钥片段：设备上查看也记审计日志
    const caller = authorize(request, reply, "read");
    if (!caller) return reply;
    audit(request, caller, "查看了本机 Agent 日志");
    try {
      return { lines: supervisor!.logs(request.params.id) };
    } catch (error) {
      return fail(reply, error);
    }
  });
}
