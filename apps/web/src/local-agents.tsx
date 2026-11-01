import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  CreateLocalAgentRequest,
  KeepAwakeSettings,
  KeepAwakeState,
  LocalAgent,
  LocalAgentMcpResponse,
  LocalAgentProvider,
  LocalDirectoryListing,
  LocalProviderInfo,
  LocalSessionResponse,
} from "@superhive/protocol";
import { localized, t } from "./i18n";
import { McpChecklist } from "./agent-settings-dialog";

/**
 * 管理 Hive Server 所在电脑（本机 Agent、目录、保持在线…）：
 * - 页面就开在这台电脑上（local）：服务端下发进程房主凭证（X-Hive-Owner），全部可用；
 * - 房主在其他设备上登录（device）：凭设备令牌（Authorization）使用，查看直接可用；
 *   启动 Agent、改设置要先申请管理权（经本机或飞书批准），用完全权限起进程还要逐次批准。
 * 其他访问者看到的仍是"复制命令"。
 */

type AgentAction = "start" | "stop" | "restart";

export type LocalAgentsState = {
  /** undefined：还在确认；false：不是本机或房主设备，或服务端已关闭 */
  enabled: boolean | undefined;
  reason?: string | undefined;
  /** local：页面开在 Server 所在电脑上；device：房主登录的其他设备 */
  mode: "local" | "device" | undefined;
  /** Server 所在电脑的名字 */
  hostLabel: string | undefined;
  /** 房主设备模式下这台设备的 ID */
  deviceId: string | undefined;
  /** 能不能启动 Agent、改设置（本机总是可以；设备要获批） */
  canManage: boolean;
  manageUntil: string | null | undefined;
  /** 设备申请在哪里批准：im=飞书卡片（也可在本机）；local=只能到本机 */
  approvalVia: "im" | "local" | undefined;
  /** 设备申请管理权；返回申请，批准后 canManage 会变为 true */
  requestManage(): Promise<HostApproval>;
  /** 正在等批准的申请（管理权或单次操作） */
  waitingApproval: HostApproval | undefined;
  /** 本机：待批准的申请 */
  approvals: HostApproval[];
  decideApproval(id: string, allow: boolean): Promise<void>;
  /** 本机：哪些 IM 账号可以在卡片上批准 */
  hostApprovers(): Promise<HostApprover[]>;
  setHostApprover(connectionId: string, allowed: boolean): Promise<HostApprover[]>;
  revokeAllOwnerDevices(): Promise<number>;
  providers: LocalProviderInfo[] | undefined;
  agents: LocalAgent[];
  create(request: CreateLocalAgentRequest): Promise<LocalAgent>;
  act(id: string, action: AgentAction): Promise<void>;
  remove(id: string): Promise<void>;
  logs(id: string): Promise<string[]>;
  directories(path?: string): Promise<LocalDirectoryListing>;
  /** 清空房间的消息和调用记录（白板保留）；只有本机房主可用 */
  clearRoom(roomId: string, username: string): Promise<void>;
  /** Agent 会加载的本机 MCP；measure 时逐个连上估算开局 token */
  mcpServers(id: string, measure?: boolean): Promise<LocalAgentMcpResponse>;
  /** 接入前预览：provider 在该目录下会加载的本机 MCP */
  mcpCandidates(
    provider: LocalAgentProvider,
    cwd: string | undefined,
    measure?: boolean,
  ): Promise<LocalAgentMcpResponse>;
  updateSettings(id: string, settings: { mcpDisabled: string[] }): Promise<LocalAgent>;
  /** 熄屏后保持在线：这台电脑的设置与实际状态（不是本机房主时为 undefined） */
  keepAwake: KeepAwakeState | undefined;
  updateKeepAwake(patch: Partial<KeepAwakeSettings>): Promise<void>;
  /** 房主在其他设备上的登录 */
  ownerDevices(): Promise<OwnerDevice[]>;
  revokeOwnerDevice(id: string): Promise<void>;
  pairOwnerDevice(): Promise<{ url: string; expiresAt: string; qrDataUrl: string }>;
  ownerToken(): Promise<string>;
};

export type OwnerDevice = {
  id: string;
  name: string;
  source: "pair" | "im";
  createdAt: string;
  lastSeenAt: string;
  manageUntil: string | null;
};

export type HostApproval = {
  id: string;
  kind: "manage" | "action";
  deviceId: string;
  deviceName: string;
  summary: string;
  status: "pending" | "approved" | "denied" | "expired" | "used";
  createdAt: string;
  expiresAt: string;
};

export type HostApprover = {
  connectionId: string;
  channel: string;
  label: string;
  allowed: boolean;
};

/** 接口返回的错误：带上服务端的错误码和正文，便于按码处理（例如需要批准） */
export class LocalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** 保持在线状态的刷新间隔（侧栏小月亮用） */
const KEEP_AWAKE_POLL_MS = 30_000;

const POLL_MS = 2_000;

async function readError(response: Response): Promise<LocalApiError> {
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // 非 JSON 响应
  }
  const message =
    typeof body.error === "string" ? body.error : t("请求失败（{0}）", { 0: response.status });
  return new LocalApiError(
    message,
    response.status,
    typeof body.code === "string" ? body.code : undefined,
    body,
  );
}

const APPROVAL_POLL_MS = 2_000;
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * active 为 true（接入面板打开）时每 2 秒刷新状态；关闭后保留最后一次结果。
 * authToken 是这个页面的登录凭证：房主设备的令牌（hod_）用来在其他设备上管理 Server 所在电脑。
 */
export function useLocalAgents(
  base: string,
  active: boolean,
  authToken?: string,
): LocalAgentsState {
  const [session, setSession] = useState<LocalSessionResponse | undefined>();
  const [providers, setProviders] = useState<LocalProviderInfo[] | undefined>();
  const [agents, setAgents] = useState<LocalAgent[]>([]);
  const tokenRef = useRef<string | undefined>(undefined);
  const deviceToken = authToken?.startsWith("hod_") ? authToken : undefined;
  const deviceRef = useRef(deviceToken);
  deviceRef.current = deviceToken;

  const loadSession = useCallback(async () => {
    try {
      const response = await fetch(`${base}/api/local/session`, {
        ...(deviceToken ? { headers: { Authorization: `Bearer ${deviceToken}` } } : {}),
      });
      const value = response.ok ? ((await response.json()) as LocalSessionResponse) : null;
      const resolved = value ?? { enabled: false as const, reason: t("无法确认是否在本机") };
      tokenRef.current =
        resolved.enabled && resolved.mode !== "device" ? resolved.ownerToken : undefined;
      setSession(resolved);
    } catch {
      setSession({ enabled: false, reason: t("无法连接 Hive Server") });
    }
  }, [base, deviceToken]);
  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  // 旧版 Server 不返回 mode：那时只有本机这一种
  const mode = session?.enabled ? (session.mode ?? "local") : undefined;
  const request = useCallback(
    async (path: string, init: RequestInit = {}, extra: Record<string, string> = {}) => {
      const response = await fetch(`${base}${path}`, {
        ...init,
        headers: {
          ...(mode === "device" && deviceRef.current
            ? { Authorization: `Bearer ${deviceRef.current}` }
            : { "X-Hive-Owner": tokenRef.current ?? "" }),
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...extra,
        },
      });
      if (!response.ok) {
        const error = await readError(response);
        // 设备被退出或会话过期：本机功能整体收起，停掉轮询
        if (error.code === "DEVICE_SESSION_INVALID") {
          setSession({ enabled: false, reason: error.message });
        }
        // 服务端说没有管理权（被拒、已过期、两边时钟不一致）：以服务端为准刷新
        if (error.code === "MANAGE_REQUIRED") void loadSession();
        throw error;
      }
      return response;
    },
    [base, mode, loadSession],
  );

  const [waitingApproval, setWaitingApproval] = useState<HostApproval>();
  // 页面卸载后不再轮询批准单
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  /** 等一张批准单出结果：批准返回 true，拒绝或过期返回 false */
  const awaitApproval = useCallback(
    async (approval: HostApproval): Promise<boolean> => {
      setWaitingApproval(approval);
      try {
        while (mountedRef.current) {
          await sleep(APPROVAL_POLL_MS);
          const response = await request(`/api/local/approvals/${approval.id}`);
          const current = ((await response.json()) as { approval: HostApproval }).approval;
          if (current.status !== "pending") return current.status === "approved";
        }
        return false;
      } finally {
        setWaitingApproval((current) => (current?.id === approval.id ? undefined : current));
      }
    },
    [request],
  );
  /** 需要逐次批准的操作：先试一次，要批准就等批准后带着批准单重发 */
  const requestApproved = useCallback(
    async (path: string, init: RequestInit): Promise<Response> => {
      try {
        return await request(path, init);
      } catch (error) {
        if (!(error instanceof LocalApiError) || error.code !== "APPROVAL_REQUIRED") throw error;
        const approval = error.body.approval as HostApproval;
        if (!(await awaitApproval(approval))) throw new Error(t("没有获得批准，操作已取消。"));
        return request(path, init, { "X-Hive-Approval": approval.id });
      }
    },
    [awaitApproval, request],
  );

  const refreshAgents = useCallback(async () => {
    const response = await request("/api/local/agents");
    setAgents(((await response.json()) as { agents: LocalAgent[] }).agents);
  }, [request]);

  const enabled = session?.enabled;
  useEffect(() => {
    if (!enabled) return;
    void refreshAgents().catch(() => undefined);
    if (!active) return;
    void request("/api/local/providers")
      .then((response) => response.json() as Promise<{ providers: LocalProviderInfo[] }>)
      .then((value) => setProviders(value.providers))
      .catch(() => undefined);
    const timer = window.setInterval(() => void refreshAgents().catch(() => undefined), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, enabled, refreshAgents, request]);

  const create = useCallback(
    async (input: CreateLocalAgentRequest) => {
      const response = await requestApproved("/api/local/agents", {
        method: "POST",
        body: JSON.stringify(input),
      });
      const { agent } = (await response.json()) as { agent: LocalAgent };
      setAgents((current) => [...current.filter((item) => item.id !== agent.id), agent]);
      return agent;
    },
    [requestApproved],
  );

  const act = useCallback(
    async (id: string, action: AgentAction) => {
      const response = await requestApproved(`/api/local/agents/${id}/${action}`, {
        method: "POST",
      });
      const { agent } = (await response.json()) as { agent: LocalAgent };
      setAgents((current) => current.map((item) => (item.id === id ? agent : item)));
    },
    [requestApproved],
  );

  const remove = useCallback(
    async (id: string) => {
      await request(`/api/local/agents/${id}`, { method: "DELETE" });
      setAgents((current) => current.filter((item) => item.id !== id));
    },
    [request],
  );

  const logs = useCallback(
    async (id: string) => {
      const response = await request(`/api/local/agents/${id}/logs`);
      return ((await response.json()) as { lines: string[] }).lines;
    },
    [request],
  );

  const directories = useCallback(
    async (target?: string) => {
      const query = target ? `?path=${encodeURIComponent(target)}` : "";
      const response = await request(`/api/local/directories${query}`);
      return (await response.json()) as LocalDirectoryListing;
    },
    [request],
  );

  const clearRoom = useCallback(
    async (roomId: string, username: string) => {
      await request(`/api/local/rooms/${encodeURIComponent(roomId)}/clear`, {
        method: "POST",
        body: JSON.stringify({ username }),
      });
    },
    [request],
  );

  const mcpServers = useCallback(
    async (id: string, measure = false) => {
      // 测量会在 Server 所在电脑上真的连上各个 MCP（起进程），走 POST
      const response = measure
        ? await request(`/api/local/agents/${id}/mcp/measure`, { method: "POST" })
        : await request(`/api/local/agents/${id}/mcp`);
      return (await response.json()) as LocalAgentMcpResponse;
    },
    [request],
  );

  const mcpCandidates = useCallback(
    async (provider: LocalAgentProvider, cwd: string | undefined, measure = false) => {
      const query = new URLSearchParams({ provider });
      if (cwd) query.set("cwd", cwd);
      const response = measure
        ? await request("/api/local/mcp/measure", {
            method: "POST",
            body: JSON.stringify({ provider, ...(cwd ? { cwd } : {}) }),
          })
        : await request(`/api/local/mcp?${query.toString()}`);
      return (await response.json()) as LocalAgentMcpResponse;
    },
    [request],
  );

  const updateSettings = useCallback(
    async (id: string, settings: { mcpDisabled: string[] }) => {
      const response = await request(`/api/local/agents/${id}/settings`, {
        method: "PUT",
        body: JSON.stringify(settings),
      });
      const { agent } = (await response.json()) as { agent: LocalAgent };
      setAgents((current) => current.map((item) => (item.id === id ? agent : item)));
      return agent;
    },
    [request],
  );

  const [keepAwake, setKeepAwake] = useState<KeepAwakeState | undefined>();
  const refreshKeepAwake = useCallback(async () => {
    const response = await request("/api/local/keep-awake");
    setKeepAwake((await response.json()) as KeepAwakeState);
  }, [request]);
  useEffect(() => {
    if (!enabled) return;
    void refreshKeepAwake().catch(() => setKeepAwake(undefined));
    const timer = window.setInterval(
      () => void refreshKeepAwake().catch(() => undefined),
      KEEP_AWAKE_POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [enabled, refreshKeepAwake]);
  const updateKeepAwake = useCallback(
    async (patch: Partial<KeepAwakeSettings>) => {
      const response = await request("/api/local/keep-awake", {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      setKeepAwake((await response.json()) as KeepAwakeState);
    },
    [request],
  );

  const ownerDevices = useCallback(async () => {
    const response = await request("/api/local/owner-devices");
    return ((await response.json()) as { devices: OwnerDevice[] }).devices;
  }, [request]);
  const revokeOwnerDevice = useCallback(
    async (id: string) => {
      await request(`/api/local/owner-devices/${id}`, { method: "DELETE" });
    },
    [request],
  );
  const pairOwnerDevice = useCallback(async () => {
    const response = await request("/api/local/owner-devices/pair", {
      method: "POST",
      body: JSON.stringify({ origin: window.location.origin }),
    });
    return (await response.json()) as { url: string; expiresAt: string; qrDataUrl: string };
  }, [request]);
  const ownerToken = useCallback(async () => {
    const response = await request("/api/local/owner-token");
    return ((await response.json()) as { token: string }).token;
  }, [request]);
  const revokeAllOwnerDevices = useCallback(async () => {
    const response = await request("/api/local/owner-devices/revoke-all", { method: "POST" });
    return ((await response.json()) as { revoked: number }).revoked;
  }, [request]);

  /* ---------- 其他设备管理这台电脑：申请与批准 ---------- */

  const requestManage = useCallback(async () => {
    const response = await request("/api/local/manage-request", { method: "POST" });
    const { approval } = (await response.json()) as { approval: HostApproval };
    void awaitApproval(approval)
      .then(() => loadSession())
      .catch(() => undefined);
    return approval;
  }, [awaitApproval, loadSession, request]);

  // 本机页面：轮询待批准的申请，页面上直接弹出来
  const [approvals, setApprovals] = useState<HostApproval[]>([]);
  const refreshApprovals = useCallback(async () => {
    const response = await request("/api/local/approvals");
    setApprovals(((await response.json()) as { approvals: HostApproval[] }).approvals);
  }, [request]);
  useEffect(() => {
    if (mode !== "local") return;
    void refreshApprovals().catch(() => undefined);
    const timer = window.setInterval(
      () => void refreshApprovals().catch(() => undefined),
      APPROVAL_POLL_MS * 2,
    );
    return () => window.clearInterval(timer);
  }, [mode, refreshApprovals]);
  const decideApproval = useCallback(
    async (id: string, allow: boolean) => {
      await request(`/api/local/approvals/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ allow }),
      });
      await refreshApprovals();
    },
    [refreshApprovals, request],
  );
  const hostApprovers = useCallback(async () => {
    const response = await request("/api/local/host-approvers");
    return ((await response.json()) as { approvers: HostApprover[] }).approvers;
  }, [request]);
  const setHostApprover = useCallback(
    async (connectionId: string, allowed: boolean) => {
      const response = await request(`/api/local/host-approvers/${connectionId}`, {
        method: "PUT",
        body: JSON.stringify({ allowed }),
      });
      return ((await response.json()) as { approvers: HostApprover[] }).approvers;
    },
    [request],
  );

  // 管理权到期时刷新一次，界面回到「只能查看」
  const manageUntil =
    session?.enabled && session.mode === "device" ? session.manageUntil : undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!manageUntil) return;
    const remaining = Date.parse(manageUntil) - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(remaining + 500, 2 ** 31 - 1),
    );
    return () => window.clearTimeout(timer);
  }, [manageUntil]);
  const canManage = mode === "local" || Boolean(manageUntil && Date.parse(manageUntil) > now);

  return {
    enabled,
    reason: session && !session.enabled ? session.reason : undefined,
    mode,
    hostLabel: session?.enabled ? session.hostLabel : undefined,
    deviceId: session?.enabled && session.mode === "device" ? session.deviceId : undefined,
    canManage,
    manageUntil,
    approvalVia: session?.enabled && session.mode === "device" ? session.approval : undefined,
    requestManage,
    waitingApproval,
    approvals,
    decideApproval,
    hostApprovers,
    setHostApprover,
    revokeAllOwnerDevices,
    keepAwake,
    updateKeepAwake,
    ownerDevices,
    revokeOwnerDevice,
    pairOwnerDevice,
    ownerToken,
    providers,
    agents,
    create,
    act,
    remove,
    logs,
    directories,
    clearRoom,
    mcpServers,
    mcpCandidates,
    updateSettings,
  };
}

/**
 * 工作目录选择器：浏览器拿不到真实路径，所以由本机 Server 列目录。
 * 默认停在启动 Hive 的目录，可往上走、点进子目录，也可以直接手输（支持 ~）。
 */
/** 家目录开头的路径显示成 ~/...，避免长路径把选择器挤爆 */
function shortenPath(target: string, home: string): string {
  if (target === home) return "~";
  return target.startsWith(`${home}/`) ? `~${target.slice(home.length)}` : target;
}

export function DirectoryPicker({
  load,
  value,
  onPick,
  onClose,
}: {
  load: LocalAgentsState["directories"];
  value: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<LocalDirectoryListing>();
  const [error, setError] = useState<string>();
  const browse = useCallback(
    (target?: string) => {
      setError(undefined);
      load(target).then(setListing, (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
    },
    [load],
  );
  useEffect(() => browse(value || undefined), [browse, value]);

  return (
    <div className="directory-picker" role="group" aria-label={t("选择工作目录")}>
      <div className="directory-picker-bar">
        <button
          type="button"
          disabled={!listing?.parent}
          aria-label={t("上一级目录")}
          onClick={() => listing?.parent && browse(listing.parent)}
        >
          {t("↑ 上一级")}
        </button>
        <code title={listing?.path}>
          {listing ? shortenPath(listing.path, listing.defaults.home) : t("加载中…")}
        </code>
        {listing && (
          <>
            <button type="button" onClick={() => browse(listing.defaults.launch)}>
              {t("Hive 目录")}
            </button>
            <button type="button" onClick={() => browse(listing.defaults.home)}>
              {t("家目录")}
            </button>
          </>
        )}
      </div>
      {error && <p className="local-agent-error">{error}</p>}
      <ul className="directory-picker-list">
        {listing?.entries.map((entry) => (
          <li key={entry.path}>
            <button type="button" onClick={() => browse(entry.path)}>
              {entry.name}
            </button>
          </li>
        ))}
        {listing && listing.entries.length === 0 && (
          <li className="directory-picker-empty">{t("（没有子目录）")}</li>
        )}
      </ul>
      {listing?.truncated && (
        <p className="directory-picker-empty">{t("子目录过多，只列出了前 500 个。")}</p>
      )}
      <div className="directory-picker-actions">
        <button type="button" onClick={onClose}>
          {t("取消")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!listing}
          onClick={() => {
            if (listing) onPick(listing.path);
          }}
        >
          {t("选择当前目录")}
        </button>
      </div>
    </div>
  );
}

export function providerInfo(
  local: LocalAgentsState,
  provider: string,
): LocalProviderInfo | undefined {
  return local.providers?.find((item) => item.provider === provider);
}

const statusLabels: Record<LocalAgent["status"], string> = localized(() => ({
  starting: t("启动中"),
  running: t("运行中"),
  restarting: t("重启中"),
  stopped: t("已停止"),
  crashed: t("已崩溃"),
}));

const accessLabels: Record<LocalAgent["access"], string> = localized(() => ({
  "read-only": t("只读"),
  workspace: t("工作区"),
  full: t("完全访问"),
}));

function LogViewer({
  load: fetchLogs,
  agentId,
}: {
  load: LocalAgentsState["logs"];
  agentId: string;
}) {
  const [lines, setLines] = useState<string[] | undefined>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchLogs(agentId).then(
        (value) => !cancelled && setLines(value),
        (cause: unknown) =>
          !cancelled && setError(cause instanceof Error ? cause.message : String(cause)),
      );
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [agentId, fetchLogs]);
  if (error) return <p className="local-agent-error">{error}</p>;
  return (
    <pre className="local-agent-logs" aria-label={t("最近日志")}>
      {lines === undefined ? t("加载中…") : lines.slice(-200).join("\n") || t("（暂无输出）")}
    </pre>
  );
}

/** 面板顶部的"本机 Agent"列表：状态、停止 / 启动 / 重启 / 删除、日志 */
export function LocalAgentList({ local }: { local: LocalAgentsState }) {
  const [openLogs, setOpenLogs] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  if (!local.enabled || local.agents.length === 0) return null;
  // 房主设备没获批时只能看：按钮置灰，点不了
  const locked = !local.canManage;
  const title =
    local.mode === "device"
      ? t("{0} 上的 Agent", { 0: local.hostLabel ?? t("Server 所在电脑") })
      : t("本机 Agent");

  const run = async (id: string, task: () => Promise<void>) => {
    setBusy(id);
    setError(undefined);
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section className="local-agents" aria-label={title}>
      <h4>{title}</h4>
      {locked && (
        <p className="settings-note">{t("这台设备只能查看。要启动、停止或删除，先申请管理权。")}</p>
      )}
      <ul>
        {local.agents.map((agent) => {
          const live = agent.status !== "stopped" && agent.status !== "crashed";
          return (
            <li key={agent.id} className={`local-agent ${agent.status}`}>
              <div className="local-agent-row">
                <span className="local-agent-dot" aria-hidden="true" />
                <span className="local-agent-name">{agent.name}</span>
                <span className="local-agent-meta">
                  {agent.provider} · {accessLabels[agent.access]} · {statusLabels[agent.status]}
                  {agent.restarts > 0 ? t(" · 重启 {0} 次", { 0: agent.restarts }) : ""}
                </span>
                <span className="local-agent-actions">
                  {live ? (
                    <>
                      <button
                        type="button"
                        disabled={busy === agent.id || locked}
                        onClick={() => void run(agent.id, () => local.act(agent.id, "restart"))}
                      >
                        {t("重启")}
                      </button>
                      <button
                        type="button"
                        disabled={busy === agent.id || locked}
                        onClick={() => void run(agent.id, () => local.act(agent.id, "stop"))}
                      >
                        {t("停止")}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={busy === agent.id || locked}
                        onClick={() => void run(agent.id, () => local.act(agent.id, "start"))}
                      >
                        {t("启动")}
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={busy === agent.id || locked}
                        aria-label={t("删除 {0}", { 0: agent.name })}
                        onClick={() => void run(agent.id, () => local.remove(agent.id))}
                      >
                        {t("删除")}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    aria-expanded={openLogs === agent.id}
                    onClick={() =>
                      setOpenLogs((current) => (current === agent.id ? undefined : agent.id))
                    }
                  >
                    {t("日志")}
                  </button>
                </span>
              </div>
              {agent.status === "crashed" && agent.lastError && (
                <p className="local-agent-error">{agent.lastError}</p>
              )}
              {openLogs === agent.id && <LogViewer load={local.logs} agentId={agent.id} />}
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="local-agent-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** 第 3 步：在本机启动；下方保留"复制命令"作为备选 */
export function LocalLaunch({
  local,
  provider,
  access,
  defaultName,
  providerLabel,
  children,
}: {
  local: LocalAgentsState;
  provider: LocalAgentProvider;
  access: "read-only" | "workspace" | "full";
  defaultName: string;
  providerLabel: string;
  /** 命令区块，折叠在"或复制命令"里 */
  children: ReactNode;
}) {
  const [name, setName] = useState(defaultName);
  const [cwd, setCwd] = useState("");
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [launchedId, setLaunchedId] = useState<string>();
  useEffect(() => setName(defaultName), [defaultName]);
  // 默认用启动 Hive 服务的目录，省掉大多数情况下的输入
  const { directories } = local;
  useEffect(() => {
    if (access === "read-only") return;
    let cancelled = false;
    directories().then(
      (listing) => !cancelled && setCwd((current) => current || listing.defaults.launch),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [access, directories]);

  const info = providerInfo(local, provider);
  const launched = local.agents.find((agent) => agent.id === launchedId);

  // Claude Code / Codex 接入时就能选加载哪些本机 MCP，不必先接入再去设置里改
  const mcpSelectable = provider === "claude" || provider === "codex";
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpData, setMcpData] = useState<LocalAgentMcpResponse | undefined>();
  const [mcpFailed, setMcpFailed] = useState(false);
  const [mcpMeasuring, setMcpMeasuring] = useState(false);
  const [mcpDisabled, setMcpDisabled] = useState<Set<string>>(() => new Set());
  const { mcpCandidates, canManage } = local;
  const mcpCwd = access === "read-only" ? undefined : cwd.trim() || undefined;
  useEffect(() => {
    if (!mcpSelectable || !mcpOpen) return;
    let cancelled = false;
    setMcpFailed(false);
    const load = async () => {
      try {
        const listed = await mcpCandidates(provider, mcpCwd);
        if (cancelled) return;
        setMcpData(listed);
        // 估算大小要在 Server 所在电脑上起进程：没有管理权的设备只列出来
        if (!canManage) return;
        setMcpMeasuring(true);
        const measured = await mcpCandidates(provider, mcpCwd, true);
        if (!cancelled) setMcpData(measured);
      } catch {
        if (!cancelled) setMcpFailed(true);
      } finally {
        if (!cancelled) setMcpMeasuring(false);
      }
    };
    // 手输目录时等停下来再读
    const timer = window.setTimeout(() => void load(), 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [canManage, mcpCandidates, mcpCwd, mcpOpen, mcpSelectable, provider]);

  const submit = async () => {
    setSubmitting(true);
    setError(undefined);
    try {
      const agent = await local.create({
        provider,
        name: name.trim(),
        access,
        ...(access === "read-only" ? {} : { cwd: cwd.trim() }),
        ...(mcpSelectable && mcpDisabled.size > 0 ? { mcpDisabled: [...mcpDisabled] } : {}),
      });
      setLaunchedId(agent.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="local-launch">
      {launched ? (
        <div className={`local-launch-result ${launched.status}`} role="status">
          {launched.status === "running" ? (
            <p>
              <strong>{launched.name}</strong> {t("已上线，在消息里输入")}{" "}
              <code>@{launched.name}</code> {t("试试。")}
            </p>
          ) : launched.status === "crashed" ? (
            <p>
              <strong>{launched.name}</strong> {t("启动失败：")}
              {launched.lastError ?? t("请查看上方的日志")}
            </p>
          ) : (
            <p>
              {t("正在启动")} <strong>{launched.name}</strong>
              {t("…首次启动可能需要十几秒。")}
            </p>
          )}
        </div>
      ) : (
        <form
          className="local-launch-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label>
            <span>{t("名称")}</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={32}
              required
              aria-label={t("Agent 名称")}
            />
          </label>
          {access === "full" && (
            <p className="local-launch-warning" role="note">
              {t(
                "完全访问没有任何沙箱：Agent 可以执行你这个系统用户能做的一切，包括读写任意文件、运行命令和联网。",
              )}
            </p>
          )}
          {access !== "read-only" && (
            <div className="local-launch-cwd">
              <label>
                <span>{t("工作目录")}</span>
                <div className="local-launch-cwd-row">
                  <input
                    value={cwd}
                    onChange={(event) => setCwd(event.target.value)}
                    placeholder={t("默认使用启动 Hive 的目录，也可输入 ~/project")}
                    required
                    aria-label={t("工作目录")}
                  />
                  <button
                    type="button"
                    aria-expanded={picking}
                    onClick={() => setPicking((current) => !current)}
                  >
                    {t("选择…")}
                  </button>
                </div>
              </label>
              {picking && (
                <DirectoryPicker
                  load={local.directories}
                  value={cwd}
                  onPick={(picked) => {
                    setCwd(picked);
                    setPicking(false);
                  }}
                  onClose={() => setPicking(false)}
                />
              )}
            </div>
          )}
          {mcpSelectable && (
            <details
              className="local-launch-mcp"
              onToggle={(event) => setMcpOpen((event.currentTarget as HTMLDetailsElement).open)}
            >
              <summary>
                {mcpDisabled.size > 0
                  ? t("本机 MCP：已关闭 {0} 个", { 0: mcpDisabled.size })
                  : t("本机 MCP：全部加载（可选择）")}
              </summary>
              <McpChecklist
                data={mcpData}
                failed={mcpFailed}
                disabled={mcpDisabled}
                measuring={mcpMeasuring}
                busy={submitting}
                onToggle={(name) =>
                  setMcpDisabled((current) => {
                    const next = new Set(current);
                    if (next.has(name)) next.delete(name);
                    else next.add(name);
                    return next;
                  })
                }
              />
              {mcpFailed && <p className="agent-mcp-hint">{t("没能读取 MCP 列表。")}</p>}
            </details>
          )}
          {info && !info.installed && (
            <p className="local-agent-error">
              {local.mode === "device"
                ? t("{0} 上没有找到", { 0: local.hostLabel ?? t("Server 所在电脑") })
                : t("本机没有找到")}{" "}
              <code>{info.command}</code> {t("命令，请先安装")} {providerLabel} {t("并完成登录。")}
            </p>
          )}
          {error && (
            <p className="local-agent-error" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            className="local-launch-button"
            disabled={
              submitting || !canManage || !name.trim() || (info !== undefined && !info.installed)
            }
          >
            {submitting
              ? t("正在启动…")
              : local.mode === "device"
                ? t("在 {0} 上启动", { 0: local.hostLabel ?? t("Server 所在电脑") })
                : t("在本机启动")}
          </button>
        </form>
      )}
      <details className="local-launch-command">
        <summary>{t("或复制命令，到其他终端运行")}</summary>
        {children}
      </details>
    </div>
  );
}
