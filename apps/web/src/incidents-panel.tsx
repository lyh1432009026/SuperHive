import { useCallback, useEffect, useState } from "react";
import type {
  Incident,
  IncidentActionRequest,
  IncidentSettings,
  IncidentsResponse,
  RuleProposal,
} from "@superhive/protocol";
import type { LocalAgentsState } from "./local-agents";
import { SettingsSwitch } from "./settings-switch";
import { localized, t } from "./i18n";
import { serverString } from "./server-text";
import "./styles/incidents.css";

export const incidentStatusLabel: Record<Incident["status"], string> = localized(() => ({
  open: t("待处理"),
  fixing: t("修复中"),
  fix_submitted: t("等合入"),
  resolved: t("已解决"),
  escalated: t("需要你处理"),
  ignored: t("已忽略"),
}));

const sourceLabel: Record<Incident["source"], string> = localized(() => ({
  invocation: t("Agent 调用"),
  server: "Server",
  protocol: t("协议"),
  web: t("网页"),
}));

export type IncidentGroups = {
  /** 我们的问题里还要人或 Agent 管的：升级给人的在最前，其余按最近出现 */
  active: Incident[];
  /** 我们的问题里已解决、已忽略的 */
  closed: Incident[];
  /** 外部原因：只重试和提示，不派修 */
  external: Incident[];
  /** 说不清是谁的 */
  unknown: Incident[];
};

export function groupIncidents(incidents: readonly Incident[]): IncidentGroups {
  const groups: IncidentGroups = { active: [], closed: [], external: [], unknown: [] };
  for (const incident of incidents) {
    if (incident.origin === "external") groups.external.push(incident);
    else if (incident.origin === "unknown") groups.unknown.push(incident);
    else if (incident.status === "resolved" || incident.status === "ignored")
      groups.closed.push(incident);
    else groups.active.push(incident);
  }
  groups.active.sort(
    (a, b) =>
      Number(b.status === "escalated") - Number(a.status === "escalated") ||
      Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt),
  );
  return groups;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function failureText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** 左侧「故障」入口和顶栏任务目录下拉一样，只给这台电脑上的房主 */
export function incidentsAvailable(
  isOwner: boolean,
  local: Pick<LocalAgentsState, "enabled" | "mode">,
): boolean {
  return isOwner && Boolean(local.enabled) && local.mode === "local";
}

/** 故障入口上的数字：我们自己的问题里还没人管的（待处理、升级给人的）+ 待批准的规则提议 */
export function unhandledIncidentCount(data: IncidentsResponse): number {
  return (
    data.incidents.filter(
      (incident) =>
        incident.origin === "internal" &&
        (incident.status === "open" || incident.status === "escalated"),
    ).length + data.proposals.filter((proposal) => proposal.status === "pending").length
  );
}

/** 进左侧「需要你处理」的：升级给人的故障单、待批准的规则提议 */
export type IncidentAttentionItem = {
  id: string;
  kind: "incident" | "proposal";
  title: string;
};

export function incidentAttentionItems(
  data: IncidentsResponse | undefined,
): IncidentAttentionItem[] {
  if (!data) return [];
  return [
    ...data.incidents
      .filter((incident) => incident.status === "escalated")
      .map((incident) => ({ id: incident.id, kind: "incident" as const, title: incident.title })),
    ...data.proposals
      .filter((proposal) => proposal.status === "pending")
      .map((proposal) => ({ id: proposal.id, kind: "proposal" as const, title: proposal.text })),
  ];
}

export type IncidentsState = {
  /** 只有这台电脑上的房主页面用得上 */
  enabled: boolean;
  data: IncidentsResponse | undefined;
  error: string | undefined;
  /** 入口上的数字；还没拉到详情时先用 Server 推来的「需要你处理」数 */
  unhandled: number;
  attentionItems: IncidentAttentionItem[];
  refresh(): void;
  updateSettings(patch: Partial<IncidentSettings>): void;
  act(id: string, action: IncidentActionRequest["action"]): void;
  decide(id: string, decision: "approve" | "reject" | "retire"): void;
};

/**
 * 本机房主页面上的故障单。Server 每次有变化都推 incidents.changed（signal 随之变），
 * 这里稍等一下再拉 /api/local/incidents：同一种错误连着出现时只拉一次。
 */
export function useIncidents(
  local: LocalAgentsState,
  enabled: boolean,
  signal: { attention: number; version: number } | undefined,
): IncidentsState {
  const [data, setData] = useState<IncidentsResponse>();
  const [error, setError] = useState<string>();
  const { incidents } = local;
  const refresh = useCallback(() => {
    incidents().then(
      (next) => {
        setData(next);
        setError(undefined);
      },
      (reason: unknown) => setError(failureText(reason)),
    );
  }, [incidents]);
  const version = signal?.version;
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(refresh, version === undefined ? 0 : 300);
    return () => window.clearTimeout(timer);
  }, [enabled, refresh, version]);
  const run = (action: Promise<unknown>) =>
    void action.then(refresh, (reason: unknown) => setError(failureText(reason)));
  const shown = enabled ? data : undefined;
  return {
    enabled,
    data: shown,
    error: enabled ? error : undefined,
    unhandled: shown ? unhandledIncidentCount(shown) : enabled ? (signal?.attention ?? 0) : 0,
    attentionItems: incidentAttentionItems(shown),
    refresh,
    updateSettings: (patch) => run(local.updateIncidentSettings(patch)),
    act: (id, action) => run(local.incidentAction(id, action)),
    decide: (id, decision) => run(local.decideRuleProposal(id, decision)),
  };
}

/**
 * 「这台电脑」设置里和故障单有关的只有自动派修这一组设置；
 * 故障单、规则提议、经验库和慢操作在左侧「故障」入口里看。
 */
export function IncidentSettingsGroup({
  state,
  rooms,
  currentRoomId,
  username,
  onOpenIncidents,
}: {
  state: IncidentsState;
  rooms: ReadonlyArray<{ id: string; name: string }>;
  currentRoomId: string;
  username: string;
  onOpenIncidents: () => void;
}) {
  if (!state.enabled) return null;
  const { data } = state;
  return (
    <div className="settings-group">
      <div className="settings-section-heading">
        <div>
          <h4>{t("故障自动派修")}</h4>
          <p>
            {t(
              "我们自己的问题按同一种错误合并计数，到次数后自动派给 Agent 先写复现测试再修，合入仍要人 review。外部原因（模型服务、凭证、Agent 自己崩溃）只重试和提示，不派修。",
            )}
          </p>
        </div>
      </div>
      {state.error && <p className="settings-note error">{state.error}</p>}
      {data && (
        <>
          <IncidentSettingsForm
            settings={data.settings}
            dispatchedToday={data.dispatchedToday}
            canDispatch={Boolean(data.runningCommit)}
            rooms={rooms}
            currentRoomId={currentRoomId}
            username={username}
            onSave={state.updateSettings}
          />
          <details className="incident-more">
            <summary>
              {t("自动修复不许改的代码（{0} 处）", { 0: data.protectedPaths.length })}
            </summary>
            <p className="settings-note">
              {t("权限、协作规则、门禁、审计和故障单系统本身；修复动了这些会直接升级给你：{0}", {
                0: data.protectedPaths.join(t("、")),
              })}
            </p>
          </details>
        </>
      )}
      <button type="button" className="incident-link" onClick={onOpenIncidents}>
        {t("故障单和慢操作在左侧「故障」里查看")}
      </button>
    </div>
  );
}

export function IncidentsPanel({
  data,
  focusId,
  onAction,
  onDecide,
}: {
  data: IncidentsResponse;
  /** 从「需要你处理」点进来的那一条：滚到它、展开现场 */
  focusId?: string;
  onAction: (id: string, action: "ignore" | "reopen" | "resolve" | "dispatch") => void;
  onDecide: (id: string, decision: "approve" | "reject" | "retire") => void;
}) {
  const groups = groupIncidents(data.incidents);
  const pending = data.proposals.filter((proposal) => proposal.status === "pending");
  const approved = data.proposals.filter((proposal) => proposal.status === "approved");
  return (
    <div className="incidents">
      {pending.length > 0 && (
        <section aria-label={t("待批准的规则提议")}>
          <h5>{t("待批准的规则提议")}</h5>
          <ul className="incident-list">
            {pending.map((proposal) => (
              <ProposalRow
                key={proposal.id}
                proposal={proposal}
                focused={proposal.id === focusId}
                onDecide={onDecide}
              />
            ))}
          </ul>
        </section>
      )}
      <IncidentSection
        title={t("我们的问题")}
        empty={t("没有待处理的故障单。")}
        incidents={groups.active}
        focusId={focusId}
        onAction={onAction}
      />
      {approved.length > 0 && (
        <details className="incident-more">
          <summary>{t("已生效的补充规则（{0} 条）", { 0: approved.length })}</summary>
          <p className="settings-note">
            {t("接在所有 Agent 的规则后面，Agent 重启后生效。撤下后不再加进去。")}
          </p>
          <ul className="incident-list">
            {approved.map((proposal) => (
              <ProposalRow key={proposal.id} proposal={proposal} onDecide={onDecide} />
            ))}
          </ul>
        </details>
      )}
      {data.lessons.length > 0 && (
        <details className="incident-more">
          <summary>{t("经验库（{0} 条）", { 0: data.lessons.length })}</summary>
          <p className="settings-note">{t("每次修完记下的症状、原因和修法，派修时附给 Agent。")}</p>
          <ul className="incident-list">
            {data.lessons.map((lesson) => (
              <li key={lesson.id} className="incident-lesson">
                <strong>{lesson.title}</strong>
                <small>
                  {[
                    lesson.agentName,
                    when(lesson.createdAt),
                    lesson.commit?.slice(0, 8),
                    lesson.verified ? t("已验证") : t("未验证"),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
                <dl>
                  <dt>{t("症状")}</dt>
                  <dd>{lesson.symptom}</dd>
                  <dt>{t("原因")}</dt>
                  <dd>{lesson.cause}</dd>
                  <dt>{t("修法")}</dt>
                  <dd>{lesson.fix}</dd>
                </dl>
              </li>
            ))}
          </ul>
        </details>
      )}
      {groups.closed.length > 0 && (
        <IncidentSection
          collapsed
          title={t("已解决、已忽略（{0}）", { 0: groups.closed.length })}
          incidents={groups.closed}
          onAction={onAction}
        />
      )}
      {groups.external.length > 0 && (
        <IncidentSection
          collapsed
          title={t("外部原因（{0}）", { 0: groups.external.length })}
          note={t("模型服务、网络、凭证或 Agent 自己的 CLI：只重试和提示，不派修。")}
          incidents={groups.external}
          onAction={onAction}
        />
      )}
      {groups.unknown.length > 0 && (
        <IncidentSection
          collapsed
          title={t("说不清是谁的（{0}）", { 0: groups.unknown.length })}
          note={t(
            "旧版 Agent 没给出结构化原因，或是新的失败类型：只记下来，不自动派修，可以手动派。",
          )}
          incidents={groups.unknown}
          onAction={onAction}
        />
      )}
    </div>
  );
}

function IncidentSettingsForm({
  settings,
  dispatchedToday,
  canDispatch,
  rooms,
  currentRoomId,
  username,
  onSave,
}: {
  settings: IncidentSettings;
  dispatchedToday: number;
  canDispatch: boolean;
  rooms: ReadonlyArray<{ id: string; name: string }>;
  currentRoomId: string;
  username: string;
  onSave: (patch: Partial<IncidentSettings>) => void;
}) {
  const initial = useCallback(
    () => ({
      roomId: settings.roomId ?? currentRoomId,
      requester: settings.requester ?? username,
      fixer: settings.fixer ?? "",
      reviewer: settings.reviewer ?? "",
      threshold: String(settings.threshold),
      dailyLimit: String(settings.dailyLimit),
      maxAttempts: String(settings.maxAttempts),
    }),
    [settings, currentRoomId, username],
  );
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial()), [initial]);
  const set = (patch: Partial<typeof draft>) => setDraft((current) => ({ ...current, ...patch }));
  const number = (value: string, fallback: number) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return (
    <form
      className="incident-settings"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          roomId: draft.roomId,
          requester: draft.requester.trim(),
          fixer: draft.fixer.trim(),
          reviewer: draft.reviewer.trim(),
          threshold: number(draft.threshold, settings.threshold),
          dailyLimit: number(draft.dailyLimit, settings.dailyLimit),
          maxAttempts: number(draft.maxAttempts, settings.maxAttempts),
        });
      }}
    >
      <SettingsSwitch
        checked={settings.autoDispatch}
        disabled={!canDispatch}
        label={t("自动派修")}
        description={
          canDispatch
            ? t("同一种错误出现到次数，就派给下面的 Agent 修；今天已派 {0} 次。", {
                0: dispatchedToday,
              })
            : t("Server 不是从源码仓库运行的，核对不了修复有没有合入，只归类、不派修。")
        }
        onChange={(checked) => onSave({ autoDispatch: checked })}
      />
      <div className="incident-settings-grid">
        <label>
          <span>{t("在哪个房间派活")}</span>
          <select value={draft.roomId} onChange={(event) => set({ roomId: event.target.value })}>
            {rooms.map((room) => (
              <option key={room.id} value={room.id}>
                # {room.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("以谁的名义派活")}</span>
          <input
            value={draft.requester}
            onChange={(event) => set({ requester: event.target.value })}
          />
        </label>
        <label>
          <span>{t("修的 Agent")}</span>
          <input
            value={draft.fixer}
            placeholder="rd-claude2"
            onChange={(event) => set({ fixer: event.target.value })}
          />
        </label>
        <label>
          <span>{t("review 的 Agent")}</span>
          <input
            value={draft.reviewer}
            placeholder="rd-claude"
            onChange={(event) => set({ reviewer: event.target.value })}
          />
        </label>
        <label>
          <span>{t("出现几次派修")}</span>
          <input
            type="number"
            min={1}
            max={100}
            value={draft.threshold}
            onChange={(event) => set({ threshold: event.target.value })}
          />
        </label>
        <label>
          <span>{t("每天最多派几次")}</span>
          <input
            type="number"
            min={0}
            max={50}
            value={draft.dailyLimit}
            onChange={(event) => set({ dailyLimit: event.target.value })}
          />
        </label>
        <label>
          <span>{t("修失败几次就找你")}</span>
          <input
            type="number"
            min={1}
            max={10}
            value={draft.maxAttempts}
            onChange={(event) => set({ maxAttempts: event.target.value })}
          />
        </label>
      </div>
      <div className="incident-settings-actions">
        <button type="submit" className="settings-action">
          {t("保存")}
        </button>
      </div>
    </form>
  );
}

function IncidentSection({
  title,
  note,
  empty,
  incidents,
  collapsed = false,
  focusId,
  onAction,
}: {
  title: string;
  note?: string;
  empty?: string;
  incidents: Incident[];
  collapsed?: boolean;
  focusId?: string;
  onAction: (id: string, action: "ignore" | "reopen" | "resolve" | "dispatch") => void;
}) {
  const list =
    incidents.length > 0 ? (
      <ul className="incident-list">
        {incidents.map((incident) => (
          <IncidentRow
            key={incident.id}
            incident={incident}
            focused={incident.id === focusId}
            onAction={onAction}
          />
        ))}
      </ul>
    ) : empty ? (
      <p className="settings-note">{empty}</p>
    ) : null;
  if (collapsed) {
    return (
      <details className="incident-more">
        <summary>{title}</summary>
        {note && <p className="settings-note">{note}</p>}
        {list}
      </details>
    );
  }
  return (
    <section aria-label={title}>
      <h5>{title}</h5>
      {note && <p className="settings-note">{note}</p>}
      {list}
    </section>
  );
}

function IncidentRow({
  incident,
  focused = false,
  onAction,
}: {
  incident: Incident;
  focused?: boolean;
  onAction: (id: string, action: "ignore" | "reopen" | "resolve" | "dispatch") => void;
}) {
  const note = serverString(incident.noteText);
  const sample = incident.samples[0];
  const canDispatch =
    incident.origin !== "external" && ["open", "escalated"].includes(incident.status);
  const canReopen = ["resolved", "ignored", "escalated"].includes(incident.status);
  return (
    <li
      className={`incident ${incident.status}${focused ? " focused" : ""}`}
      data-incident-id={incident.id}
    >
      <div className="incident-head">
        <span className={`incident-status ${incident.status}`}>
          {incidentStatusLabel[incident.status]}
        </span>
        <strong title={incident.fingerprint}>{incident.title}</strong>
        <span className="incident-count" title={t("一共出现了 {0} 次", { 0: incident.count })}>
          ×{incident.count}
        </span>
      </div>
      <small>
        {[
          sourceLabel[incident.source],
          t("最近 {0}", { 0: when(incident.lastSeenAt) }),
          incident.failedAttempts > 0
            ? t("修失败 {0} 次", { 0: incident.failedAttempts })
            : undefined,
          incident.fixCommit ? t("修复 {0}", { 0: incident.fixCommit.slice(0, 8) }) : undefined,
        ]
          .filter(Boolean)
          .join(" · ")}
      </small>
      {note && <p className="incident-note">{note}</p>}
      <details open={focused || undefined}>
        <summary>{t("现场与派修记录")}</summary>
        {sample && (
          <dl className="incident-sample">
            {sample.route && (
              <>
                <dt>{t("位置")}</dt>
                <dd>{sample.route}</dd>
              </>
            )}
            {(sample.agentName || sample.roomId) && (
              <>
                <dt>{t("在哪")}</dt>
                <dd>
                  {[sample.agentName, sample.provider, sample.roomId ? `#${sample.roomId}` : ""]
                    .filter(Boolean)
                    .join(" · ")}
                </dd>
              </>
            )}
            {(sample.detailText || sample.detail) && (
              <>
                <dt>{t("说明")}</dt>
                <dd>{serverString(sample.detailText, sample.detail ?? "")}</dd>
              </>
            )}
            {sample.url && (
              <>
                <dt>{t("页面")}</dt>
                <dd>{sample.url}</dd>
              </>
            )}
            {sample.codeVersion && (
              <>
                <dt>{t("代码版本")}</dt>
                <dd>{sample.codeVersion.slice(0, 12)}</dd>
              </>
            )}
            {sample.stack && (
              <>
                <dt>{t("调用栈")}</dt>
                <dd>
                  <pre>{sample.stack}</pre>
                </dd>
              </>
            )}
          </dl>
        )}
        {incident.dispatches.length > 0 && (
          <ul className="incident-dispatches">
            {incident.dispatches.map((dispatch) => (
              <li key={dispatch.id}>
                {t("第 {0} 次 · {1} · {2}", {
                  0: dispatch.attempt,
                  1: dispatch.agentName,
                  2: when(dispatch.at),
                })}
                {" · "}
                {dispatchOutcomeLabel[dispatch.outcome]}
                {dispatch.commit ? ` · ${dispatch.commit.slice(0, 8)}` : ""}
                {dispatch.reason ? ` · ${dispatch.reason}` : ""}
              </li>
            ))}
          </ul>
        )}
      </details>
      <div className="incident-actions">
        {canDispatch && (
          <button type="button" onClick={() => onAction(incident.id, "dispatch")}>
            {t("派修")}
          </button>
        )}
        {incident.status !== "resolved" && incident.status !== "ignored" && (
          <>
            <button type="button" onClick={() => onAction(incident.id, "resolve")}>
              {t("标为已解决")}
            </button>
            <button type="button" onClick={() => onAction(incident.id, "ignore")}>
              {t("忽略")}
            </button>
          </>
        )}
        {canReopen && (
          <button type="button" onClick={() => onAction(incident.id, "reopen")}>
            {t("重新打开")}
          </button>
        )}
      </div>
    </li>
  );
}

const dispatchOutcomeLabel: Record<Incident["dispatches"][number]["outcome"], string> = localized(
  () => ({
    pending: t("修复中"),
    submitted: t("交了修复"),
    failed: t("没修成"),
    superseded: t("人接手了"),
  }),
);

function ProposalRow({
  proposal,
  focused = false,
  onDecide,
}: {
  proposal: RuleProposal;
  focused?: boolean;
  onDecide: (id: string, decision: "approve" | "reject" | "retire") => void;
}) {
  return (
    <li className={`incident-proposal${focused ? " focused" : ""}`} data-incident-id={proposal.id}>
      <strong>{proposal.text}</strong>
      <small>{t("{0} 提议 · {1}", { 0: proposal.agentName, 1: when(proposal.createdAt) })}</small>
      <p>{proposal.reason}</p>
      <div className="incident-actions">
        {proposal.status === "pending" ? (
          <>
            <button type="button" onClick={() => onDecide(proposal.id, "approve")}>
              {t("批准")}
            </button>
            <button type="button" onClick={() => onDecide(proposal.id, "reject")}>
              {t("拒绝")}
            </button>
          </>
        ) : (
          <button type="button" onClick={() => onDecide(proposal.id, "retire")}>
            {t("撤下")}
          </button>
        )}
      </div>
    </li>
  );
}
