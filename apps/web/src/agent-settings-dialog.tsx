import { useCallback, useEffect, useState } from "react";
import type {
  LocalAgent,
  LocalAgentMcpResponse,
  LocalAgentModelsResponse,
  LocalMcpServer,
} from "@superhive/protocol";
import { localized, t } from "./i18n";
import { LogViewer, localAgentStatusLabels, type LocalAgentsState } from "./local-agents";
import { RestartNowButton, agentUpdateNotes } from "./local-agent-updates";
import { EffortPicker, ModelPicker } from "./model-picker";

function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function SettingsGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.86a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const scopeLabels: Record<LocalMcpServer["scope"], string> = localized(() => ({
  user: t("全局"),
  local: t("本项目"),
  project: t("项目 .mcp.json"),
  plugin: t("插件"),
}));

/** 1234 → 1.2k，123456 → 12.3 万（中文）/ 123k（英文） */
export function formatTokens(tokens: number): string {
  if (tokens >= 10_000 && t("万") === "万") {
    return `${(tokens / 10_000).toFixed(tokens >= 100_000 ? 0 : 1)} 万`;
  }
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}k`;
  return String(tokens);
}

/** 估算的开局 token：不带 MCP 的基础量 + 启用的各项 */
function estimateStartTokens(
  data: LocalAgentMcpResponse,
  disabled: Set<string>,
): number | undefined {
  if (data.baselineTokens === null) return undefined;
  let total = data.baselineTokens;
  for (const server of data.servers) {
    const on = server.configurable ? !disabled.has(server.name) : server.enabled;
    if (!on) continue;
    if (!server.measurement?.ok) return undefined;
    total += server.measurement.tokens;
  }
  return total;
}

/** 本机 MCP 勾选列表与开局 token 估算；Agent 设置弹窗和接入表单共用 */
export function McpChecklist({
  data,
  failed,
  disabled,
  measuring,
  busy,
  onToggle,
}: {
  data: LocalAgentMcpResponse | undefined;
  failed: boolean;
  disabled: Set<string>;
  measuring: boolean;
  busy: boolean;
  onToggle: (name: string) => void;
}) {
  const estimate = data ? estimateStartTokens(data, disabled) : undefined;
  return (
    <>
      {!data && !failed && <p className="agent-mcp-hint">{t("正在读取 MCP 列表…")}</p>}
      {data && !data.supported && (
        <p className="agent-mcp-hint">{t("这个 Agent 类型暂不支持在 Hive 里开关 MCP。")}</p>
      )}
      {data?.supported && data.servers.length === 0 && (
        <p className="agent-mcp-hint">{t("这台电脑上没有配置额外的 MCP，只加载 hive。")}</p>
      )}
      {data?.supported && data.servers.length > 0 && (
        <ul className="agent-mcp-list" aria-label={t("本机 MCP")}>
          {data.servers.map((server) => {
            const on = server.configurable ? !disabled.has(server.name) : server.enabled;
            const size = server.measurement
              ? server.measurement.ok
                ? t("{0} 个工具 · 约 {1} token", {
                    0: server.measurement.tools,
                    1: formatTokens(server.measurement.tokens),
                  })
                : t("无法估算：{0}", { 0: server.measurement.error })
              : measuring
                ? t("正在估算…")
                : "";
            const heavy = server.measurement?.ok === true && server.measurement.tokens >= 50_000;
            return (
              <li key={server.name} className={on ? "" : "off"}>
                <label>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!server.configurable || busy}
                    onChange={() => onToggle(server.name)}
                  />
                  <span className="agent-mcp-copy">
                    <strong>{server.name}</strong>
                    <small>
                      {scopeLabels[server.scope]} · {server.transport}
                      {size ? " · " : ""}
                      {size && <span className={heavy ? "agent-mcp-heavy" : ""}>{size}</span>}
                      {!server.configurable &&
                        ` · ${server.disabledByCli ? t("已在 CLI 配置里关闭") : t("插件提供，不能在这里开关")}`}
                    </small>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {estimate !== undefined && (
        <p className="agent-mcp-estimate">
          {t("按当前勾选，每个新会话开局约 {0} token（估算）。", { 0: formatTokens(estimate) })}
        </p>
      )}
    </>
  );
}

/**
 * 本机 Agent 的设置：勾选它加载哪些本机 MCP。每个 MCP 的工具定义都会在每个会话开局整段发给模型，
 * 体积大的会让每次新会话、每次缓存过期都多花一大笔，所以把大小标出来让房主自己取舍。
 */
export function AgentSettingsDialog({
  agent,
  local,
  onClose,
  onOpenTerminal,
}: {
  agent: LocalAgent;
  /** 在终端里接着它在当前房间的会话 */
  onOpenTerminal?: () => void;
  local: Pick<
    LocalAgentsState,
    "mcpServers" | "updateSettings" | "act" | "canManage" | "logs" | "remove" | "models"
  >;
  onClose: () => void;
}) {
  const [data, setData] = useState<LocalAgentMcpResponse | undefined>();
  const [disabled, setDisabled] = useState(() => new Set(agent.mcpDisabled));
  const [measuring, setMeasuring] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState<"saved" | "restarted" | undefined>();
  const [autoSteer, setAutoSteer] = useState(agent.autoSteer);
  const [savingSteer, setSavingSteer] = useState(false);
  const [acting, setActing] = useState<"start" | "stop" | "restart" | "remove">();
  const [models, setModels] = useState<LocalAgentModelsResponse | undefined>();
  const [model, setModel] = useState(agent.model ?? "");
  const [savedModel, setSavedModel] = useState(agent.model ?? "");
  const [effort, setEffort] = useState(agent.effort ?? "");
  const [savedEffort, setSavedEffort] = useState(agent.effort ?? "");
  const [savingModel, setSavingModel] = useState(false);
  const [modelSaved, setModelSaved] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const live = agent.status !== "stopped" && agent.status !== "crashed";

  /** 启动、停止、重启：和「接入 Agent」里本机 Agent 列表的按钮是同一个操作 */
  async function control(action: "start" | "stop" | "restart" | "remove") {
    setActing(action);
    setError(undefined);
    try {
      if (action === "remove") {
        await local.remove(agent.id);
        onClose();
        return;
      }
      await local.act(agent.id, action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActing(undefined);
    }
  }

  const loadModels = useCallback(
    async (refresh: boolean) => {
      if (refresh) setModels(undefined);
      try {
        setModels(await local.models(agent.id, refresh));
      } catch (cause) {
        setModels({
          source: "preset",
          models: [],
          efforts: [],
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
    [agent.id, local],
  );

  useEffect(() => {
    void loadModels(false);
  }, [loadModels]);

  // 运行时能切思考强度才显示、才保存（不支持的运行时 Server 也会拒绝）
  const effortSupported = (models?.efforts.length ?? 0) > 0;
  const modelDirty = model.trim() !== savedModel || (effortSupported && effort !== savedEffort);

  /** 模型和思考强度写进设置文件，下一次回复就按新的跑，不用重启 */
  async function saveModel() {
    setSavingModel(true);
    setError(undefined);
    try {
      const updated = await local.updateSettings(agent.id, {
        model: model.trim() || null,
        ...(effortSupported ? { effort: effort || null } : {}),
      });
      setModel(updated.model ?? "");
      setSavedModel(updated.model ?? "");
      setEffort(updated.effort ?? "");
      setSavedEffort(updated.effort ?? "");
      setModelSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingModel(false);
    }
  }

  /** 自动引导：服务端在派发时判断，改了立即生效，不用重启 */
  async function toggleAutoSteer(next: boolean) {
    setSavingSteer(true);
    setError(undefined);
    try {
      const updated = await local.updateSettings(agent.id, { autoSteer: next });
      setAutoSteer(updated.autoSteer);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingSteer(false);
    }
  }

  const load = useCallback(
    async (measure: boolean) => {
      if (measure) setMeasuring(true);
      try {
        setData(await local.mcpServers(agent.id, measure));
        setError(undefined);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (measure) setMeasuring(false);
      }
    },
    [agent.id, local],
  );

  useEffect(() => {
    // 先秒出列表，再在后台逐个估算大小（要起进程，没有管理权的设备只列出来）
    void load(false).then(() => (local.canManage ? load(true) : undefined));
  }, [load, local.canManage]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const changed =
    disabled.size !== agent.mcpDisabled.length ||
    agent.mcpDisabled.some((name) => !disabled.has(name));

  function toggle(name: string) {
    setSaved(undefined);
    setDisabled((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function save(restart: boolean) {
    setSaving(true);
    setError(undefined);
    try {
      // 列表里已不存在的旧名字一并清掉，避免越积越多
      const known = new Set(data?.servers.map((server) => server.name) ?? []);
      const next = [...disabled].filter((name) => known.size === 0 || known.has(name));
      const updated = await local.updateSettings(agent.id, { mcpDisabled: next });
      if (restart) await local.act(agent.id, "restart");
      setDisabled(new Set(updated.mcpDisabled));
      setSaved(restart ? "restarted" : "saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  const needsRestart = agent.settingsPendingRestart === true;

  return (
    <div className="room-dialog-layer">
      <button
        className="room-dialog-scrim"
        type="button"
        aria-label={t("关闭")}
        onClick={onClose}
      />
      <div
        className="invite-dialog agent-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-settings-title"
      >
        <header className="invite-dialog-header">
          <div>
            <h2 id="agent-settings-title">{t("{0} 的设置", { 0: agent.name })}</h2>
            <p>
              {t(
                "重启、停止这个 Agent，选择它用的模型和加载哪些本机 MCP。每个 MCP 的工具说明会在每个会话开局整段发给模型，体积大的会明显增加新会话和缓存过期时的费用。hive 始终加载。",
              )}
            </p>
          </div>
          <button type="button" className="invite-close" aria-label={t("关闭")} onClick={onClose}>
            <CloseGlyph />
          </button>
        </header>

        <div className="invite-dialog-body">
          <div className={`agent-run-control local-agent ${agent.status}`}>
            <span className="local-agent-dot" aria-hidden="true" />
            <span className="agent-run-status">
              <strong>
                {[localAgentStatusLabels[agent.status], ...agentUpdateNotes(agent)].join(" · ")}
                {agent.outdated && <span className="agent-update-badge">{t("旧版本")}</span>}
              </strong>
              <small>
                {!live
                  ? t("已停止，房间里不会再有人接它的 @。")
                  : agent.restartWhenIdle
                    ? t("已安排重启：手上的任务都做完就重启。")
                    : t("「重启」等它手上的任务都做完再重启；「立即重启」会中断正在执行的任务。")}
              </small>
            </span>
            {live ? (
              <>
                {onOpenTerminal && (
                  <button type="button" onClick={onOpenTerminal}>
                    {t("在终端打开会话")}
                  </button>
                )}
                <button
                  type="button"
                  disabled={
                    acting !== undefined || !local.canManage || agent.restartWhenIdle === true
                  }
                  onClick={() => void control("restart")}
                >
                  {acting === "restart" ? t("重启中…") : t("重启")}
                </button>
                <RestartNowButton
                  agent={agent}
                  local={local}
                  disabled={acting !== undefined || !local.canManage}
                  onError={setError}
                />
                <button
                  type="button"
                  disabled={acting !== undefined || !local.canManage}
                  onClick={() => void control("stop")}
                >
                  {acting === "stop" ? t("停止中…") : t("停止")}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={acting !== undefined || !local.canManage}
                  onClick={() => void control("start")}
                >
                  {acting === "start" ? t("启动中…") : t("启动")}
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={acting !== undefined || !local.canManage}
                  onClick={() => setConfirmRemove(true)}
                >
                  {t("删除")}
                </button>
              </>
            )}
            <button type="button" aria-expanded={logsOpen} onClick={() => setLogsOpen(!logsOpen)}>
              {t("日志")}
            </button>
          </div>
          {agent.status === "crashed" && agent.lastError && (
            <p className="local-agent-error">{agent.lastError}</p>
          )}
          {agent.cwdFallback && (
            <p className="local-agent-notice" role="status">
              {cwdFallbackText(agent.cwdFallback)}
            </p>
          )}
          {confirmRemove && (
            <div className="agent-remove-confirm" role="alert">
              <span>
                {t("删除 {0}？它会退出所有房间，之后要用得重新接入。", { 0: agent.name })}
              </span>
              <button type="button" onClick={() => setConfirmRemove(false)}>
                {t("取消")}
              </button>
              <button
                type="button"
                className="danger"
                disabled={acting !== undefined}
                onClick={() => void control("remove")}
              >
                {t("删除")}
              </button>
            </div>
          )}
          {logsOpen && <LogViewer load={local.logs} agentId={agent.id} />}
          <section className="agent-model" aria-labelledby="agent-model-title">
            <h3 id="agent-model-title">{effortSupported ? t("模型与思考强度") : t("模型")}</h3>
            <ModelPicker
              aria-label={t("模型")}
              data={models}
              value={model}
              allowDefault
              disabled={savingModel || !local.canManage}
              onChange={(next) => {
                setModel(next);
                setModelSaved(false);
              }}
              onRefresh={() => void loadModels(true)}
            />
            {effortSupported && (
              <>
                <h4>{t("思考强度")}</h4>
                <EffortPicker
                  data={models}
                  model={model}
                  value={effort}
                  disabled={savingModel || !local.canManage}
                  onChange={(next) => {
                    setEffort(next);
                    setModelSaved(false);
                  }}
                />
              </>
            )}
            <div className="agent-model-actions">
              <small>
                {agent.settingsPendingRestart
                  ? t("这个 Agent 是在支持此设置之前启动的，保存后需要重启一次才会生效。")
                  : t(
                      "从下一次回复开始生效，不用重启。失败的任务也可以点「换个模型重试」只换这一次。",
                    )}
              </small>
              {modelSaved && (
                <span className="agent-mcp-saved" role="status">
                  {t("已保存。")}
                </span>
              )}
              <button
                type="button"
                disabled={savingModel || !modelDirty || !local.canManage}
                onClick={() => void saveModel()}
              >
                {savingModel ? t("保存中…") : effortSupported ? t("保存模型和强度") : t("保存模型")}
              </button>
            </div>
          </section>
          <label className="agent-auto-steer">
            <input
              type="checkbox"
              checked={autoSteer}
              disabled={savingSteer || !local.canManage}
              onChange={(event) => void toggleAutoSteer(event.target.checked)}
            />
            <span>
              <strong>{t("人发的消息自动引导")}</strong>
              <small>
                {t(
                  "它正在执行任务时，人 @ 它的新消息直接用来引导当前任务，不排队。默认关：先排队，需要时在那条消息上或输入框旁点「引导」。其他 Agent 的消息始终排队。",
                )}
              </small>
            </span>
          </label>
          <McpChecklist
            data={data}
            failed={error !== undefined}
            disabled={disabled}
            measuring={measuring}
            busy={saving || !local.canManage}
            onToggle={toggle}
          />
          {!local.canManage && (
            <p className="agent-mcp-hint">{t("这台设备只能查看。要修改，先申请管理权。")}</p>
          )}
          <p className="agent-mcp-hint">
            {needsRestart
              ? t("这个 Agent 是在支持此设置之前启动的，保存后需要重启一次才会生效。")
              : t(
                  "保存后从下一次回复开始生效；会话里已有的上下文会在下一次回复时按新的工具重新缓存一次。",
                )}
          </p>
          {error && (
            <p className="room-dialog-error" role="alert">
              {error}
            </p>
          )}
          {saved && (
            <p className="agent-mcp-saved" role="status">
              {saved === "restarted" ? t("已保存并重启。") : t("已保存。")}
            </p>
          )}
          <button
            type="button"
            className="invite-submit"
            disabled={!changed || saving || !data?.supported || !local.canManage}
            onClick={() => void save(needsRestart)}
          >
            {saving ? t("保存中…") : needsRestart ? t("保存并重启") : t("保存")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 工作目录用不了、退回主目录时给人看的说明 */
export function cwdFallbackText(fallback: NonNullable<LocalAgent["cwdFallback"]>): string {
  return fallback.reason === "installDir"
    ? t("原来的工作目录 {0} 是桌面端的安装目录，升级后会被删掉，已自动改成 {1}。", {
        0: fallback.from,
        1: fallback.to,
      })
    : t("工作目录 {0} 不存在，这次先在 {1} 启动；目录恢复后重启这个 Agent 即回到原目录。", {
        0: fallback.from,
        1: fallback.to,
      });
}
