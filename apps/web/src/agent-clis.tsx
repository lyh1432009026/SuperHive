import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentCliInstallation, AgentCliJob, AgentCliSource } from "@superhive/protocol";
import { ConfirmPopover } from "./confirm-popover";
import { t } from "./i18n";
import type { AgentCliWithAgents, LocalAgentsState } from "./local-agents";
import "./styles/agent-clis.css";

/**
 * 这台电脑装了哪些 Agent CLI（只在 Server 所在电脑上的本机房主页面显示）：版本、安装位置与来源、
 * 有没有新版；一键升级前把要在这台电脑上跑的命令原样给人确认，全局一次只升级一个，
 * 进度只显示最近一行，失败显示输出末几行。升级完提示重启用这个运行时的本机 Agent。
 */

export type AgentClisApi = Pick<
  LocalAgentsState,
  "agentClis" | "upgradeAgentCli" | "agentCliJob" | "act"
>;

export const JOB_POLL_MS = 1_000;

const SOURCE_LABELS: Record<AgentCliSource, string> = {
  nvm: "nvm",
  fnm: "fnm",
  mise: "mise",
  volta: "Volta",
  homebrew: "Homebrew",
  bun: "bun",
  pnpm: "pnpm",
  npm: "npm",
  native: "官方安装器",
  unknown: "来源不明",
};

const sourceLabel = (source: AgentCliSource) =>
  source === "native" || source === "unknown" ? t(SOURCE_LABELS[source]) : SOURCE_LABELS[source];

const errorMessage = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/** 升级还没结束：在跑，或者成功了但还没重新探测到版本 */
const pending = (job: AgentCliJob) =>
  job.state === "running" || (job.state === "succeeded" && job.versionAfter === undefined);

export function AgentClisGroup({ api }: { api: AgentClisApi }) {
  const [tools, setTools] = useState<AgentCliWithAgents[]>();
  const [job, setJob] = useState<AgentCliJob | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const { agentClis, agentCliJob } = api;

  const load = useCallback(
    async (refresh: boolean) => {
      setLoading(true);
      setError(undefined);
      try {
        const result = await agentClis(refresh);
        setTools(result.tools);
        // 打开页面时有升级在跑：接着显示进度；已经结束的旧结果不再翻出来
        setJob((current) => current ?? (result.job && pending(result.job) ? result.job : null));
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        setLoading(false);
      }
    },
    [agentClis],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // 升级进行中：轮询进度；结束后重新取一次列表（服务端已作废检测缓存）
  const jobId = job && pending(job) ? job.id : undefined;
  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      agentCliJob(jobId).then(
        (next) => {
          if (stopped) return;
          setJob(next);
          if (!pending(next)) void load(false);
        },
        (reason: unknown) => !stopped && setError(errorMessage(reason)),
      );
    }, JOB_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [jobId, agentCliJob, load]);

  const busy = Boolean(job && job.state === "running");

  return (
    <div className="settings-group">
      <div className="settings-section-heading agent-clis-heading">
        <div>
          <h4>{t("已安装的 Agent CLI")}</h4>
          <p>
            {t(
              "检测这台电脑上装了哪些 Agent CLI、版本和安装位置（按登录终端的 PATH 查找）。一键升级会在这台电脑上执行对应的包管理器命令，执行前先给你确认，一次只升级一个。",
            )}
          </p>
        </div>
        <button
          type="button"
          className="settings-action"
          disabled={loading || busy}
          onClick={() => void load(true)}
        >
          {loading ? t("正在检测…") : t("重新检测")}
        </button>
      </div>
      {!tools && loading && <p className="settings-note">{t("正在检测…")}</p>}
      {tools?.map((tool) => (
        <AgentCliCard
          key={tool.tool}
          api={api}
          info={tool}
          job={job?.tool === tool.tool ? job : undefined}
          blocked={busy}
          onStarted={setJob}
        />
      ))}
      {error && <p className="settings-note error">{error}</p>}
    </div>
  );
}

function AgentCliCard({
  api,
  info,
  job,
  blocked,
  onStarted,
}: {
  api: AgentClisApi;
  info: AgentCliWithAgents;
  job: AgentCliJob | undefined;
  blocked: boolean;
  onStarted: (job: AgentCliJob) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const upgradeRef = useRef<HTMLButtonElement>(null);
  const primary = info.installations.find((install) => install.pathDefault);
  const command = info.plan?.kind === "anchored" ? info.plan.command : undefined;
  const canUpgrade =
    Boolean(command) &&
    !info.nodeGap &&
    info.status !== "notInstalled" &&
    (info.updateAvailable || info.latest === null);

  const start = async () => {
    if (!command) return;
    setStarting(true);
    setError(undefined);
    try {
      onStarted(await api.upgradeAgentCli(info.tool, command));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setStarting(false);
      setConfirming(false);
      upgradeRef.current?.focus();
    }
  };

  return (
    <section className="agent-cli" aria-label={info.name}>
      <div className="agent-cli-head">
        <div className="agent-cli-title">
          <h5>{info.name}</h5>
          <StatusLine info={info} />
        </div>
        {canUpgrade && (!job || job.state !== "running") && (
          <button
            type="button"
            ref={upgradeRef}
            className="settings-action"
            aria-expanded={confirming}
            disabled={blocked || starting}
            onClick={() => setConfirming(true)}
          >
            {info.updateAvailable && info.latest
              ? t("升级到 {0}", { 0: info.latest })
              : t("尝试升级")}
          </button>
        )}
      </div>
      {primary && (
        <small className="agent-cli-path">
          <code>{primary.path}</code>
          <span className="agent-cli-source">{sourceLabel(primary.source)}</span>
        </small>
      )}
      {primary && !primary.runnable && primary.error && (
        <pre className="agent-cli-output">{primary.error}</pre>
      )}
      {info.conflict && <Installations installations={info.installations} />}
      {info.nodeGap && (
        <p className="settings-note warning">
          {t("新版需要 Node {0}，这一处用的是 Node {1}。先升级 Node，再升级 {2}。", {
            0: info.nodeGap.required,
            1: info.nodeGap.current,
            2: info.name,
          })}
        </p>
      )}
      {info.plan?.kind === "manual" && info.status !== "notInstalled" && (
        <p className="settings-note">{info.plan.reason}</p>
      )}
      {job && <JobStatus api={api} info={info} job={job} />}
      {confirming && command && (
        <ConfirmPopover
          ariaLabel={t("确认升级 {0}", { 0: info.name })}
          title={t("在这台电脑上执行升级命令")}
          message={
            <>
              <span>{t("将在这台电脑上运行：")}</span>
              <code className="agent-cli-command">{command}</code>
              <span>
                {t("正在用 {0} 的 Agent 不会自动重启，升级完再手动重启。", { 0: info.name })}
              </span>
            </>
          }
          confirmLabel={t("升级")}
          cancelLabel={t("取消")}
          anchorRef={upgradeRef}
          busy={starting}
          onConfirm={() => void start()}
          onCancel={() => {
            setConfirming(false);
            upgradeRef.current?.focus();
          }}
        />
      )}
      {error && <p className="settings-note error">{error}</p>}
    </section>
  );
}

function StatusLine({ info }: { info: AgentCliWithAgents }) {
  if (info.status === "notInstalled") {
    return <span className="agent-cli-status muted">{t("未安装")}</span>;
  }
  const latest =
    info.latest === null
      ? t("查不到最新版")
      : info.updateAvailable && info.version
        ? t("有新版 {0}", { 0: info.latest })
        : info.updateAvailable
          ? t("最新版 {0}", { 0: info.latest })
          : t("已是最新");
  return (
    <span className={`agent-cli-status${info.status === "broken" ? " broken" : ""}`}>
      {info.status === "broken" ? t("装了但跑不起来") : (info.version ?? t("版本未知"))}
      <span className={info.updateAvailable ? "agent-cli-update" : undefined}> · {latest}</span>
    </span>
  );
}

function Installations({ installations }: { installations: AgentCliInstallation[] }) {
  return (
    <details className="agent-cli-installs">
      <summary>
        {t("装了 {0} 处，版本或可用性不一致：命令行和 Agent 用的是标「默认」的那处", {
          0: installations.length,
        })}
      </summary>
      <ul>
        {installations.map((install) => (
          <li key={install.realPath}>
            <code>{install.path}</code>
            <span>
              {install.runnable ? (install.version ?? t("版本未知")) : t("跑不起来")}
              {" · "}
              {sourceLabel(install.source)}
              {install.pathDefault ? ` · ${t("默认")}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function JobStatus({
  api,
  info,
  job,
}: {
  api: AgentClisApi;
  info: AgentCliWithAgents;
  job: AgentCliJob;
}) {
  const [restarting, setRestarting] = useState(false);
  const [restartResult, setRestartResult] = useState<string>();
  const live = info.agents.filter((agent) => agent.status !== "stopped");

  if (pending(job)) {
    return (
      <div className="agent-cli-job" role="status">
        <span className="agent-cli-spinner" aria-hidden />
        <span>{t("正在升级…")}</span>
        {job.progress && <code className="agent-cli-progress">{job.progress}</code>}
      </div>
    );
  }

  if (job.state === "failed") {
    return (
      <div className="agent-cli-job failed" role="alert">
        <p>{t("升级失败：{0}", { 0: job.reason ?? "" })}</p>
        {job.error && <pre className="agent-cli-output">{job.error}</pre>}
      </div>
    );
  }

  const restart = async () => {
    setRestarting(true);
    setRestartResult(undefined);
    const failed: string[] = [];
    for (const agent of live) {
      try {
        await api.act(agent.id, "restart");
      } catch {
        failed.push(agent.name);
      }
    }
    setRestarting(false);
    setRestartResult(
      failed.length
        ? t("这些 Agent 没能重启：{0}", { 0: failed.join(t("、")) })
        : t("已重启 {0} 个 Agent", { 0: live.length }),
    );
  };

  const unchanged = job.versionAfter && job.versionAfter === job.versionBefore;
  return (
    <div className="agent-cli-job done" role="status">
      <p>
        {unchanged
          ? t("命令执行成功，但这一处的版本仍是 {0}，可能装到了别处。", { 0: job.versionAfter })
          : job.versionAfter
            ? t("已升级到 {0}。", { 0: job.versionAfter })
            : t("升级命令执行成功。")}{" "}
        {info.agents.length
          ? t("用 {0} 的 Agent 重启后才用上新版：{1}", {
              0: info.name,
              1: info.agents.map((agent) => agent.name).join(t("、")),
            })
          : t("这台电脑上还没有用 {0} 的 Agent。", { 0: info.name })}
      </p>
      {live.length > 0 && !unchanged && (
        <button
          type="button"
          className="settings-action"
          disabled={restarting}
          onClick={() => void restart()}
        >
          {restarting ? t("正在重启…") : t("重启这 {0} 个 Agent", { 0: live.length })}
        </button>
      )}
      {restartResult && <p className="settings-note">{restartResult}</p>}
    </div>
  );
}
