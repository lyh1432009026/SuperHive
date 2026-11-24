import { InvocationUsage } from "./usage";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { explainInvocationState, type Invocation, type TraceStep } from "@superhive/protocol";
import { stateExplanation } from "./invocation-state";
import { TraceLog } from "./live-trace";
import "./styles/invocation-details.css";
import { getLocale, t } from "./i18n";
import { Tooltip } from "./tooltip";
import { Button, IconButton } from "./button";
import { Icon } from "./app-icons";

function activeElement(): Element | null {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}

function Clock({ value, now }: { value?: string; now: number }) {
  if (!value || !Number.isFinite(Date.parse(value))) return <span>{t("尚未收到")}</span>;
  const age = Math.max(0, Math.floor((now - Date.parse(value)) / 1000));
  return (
    <span>
      <time dateTime={value} title={new Date(value).toLocaleString()}>
        {new Date(value).toLocaleTimeString(getLocale(), { hour12: false })}
      </time>
      <small>
        {age < 60 ? t("{0} 秒前", { 0: age }) : t("{0} 分钟前", { 0: Math.floor(age / 60) })}
      </small>
    </span>
  );
}

/** 状态的色调：进行中、完成、需要留意、已停止 */
function statusTone(invocation: Invocation): "active" | "done" | "attention" | "muted" {
  switch (invocation.status) {
    case "queued":
    case "running":
    case "cancelling":
      return "active";
    case "completed":
      return "done";
    case "cancelled":
      return "muted";
    default:
      return "attention";
  }
}

export function InvocationDetails({
  invocation,
  steps,
  label,
  agentOnline,
  connectionState,
  delegation,
  others,
  onClose,
  onJump,
  onOpenTerminal,
  onViewChanges,
}: {
  /** 在终端里接着这个 Agent 的会话（本机 Agent 才有） */
  onOpenTerminal?: () => void;
  /** 打开「代码」面板看这个 Agent 的改动（能看工作区的人才有） */
  onViewChanges?: () => void;
  invocation: Invocation;
  /** 同房间的其它调用：解释排队时排在谁后面 */
  others?: readonly Invocation[];
  /** 执行过程（房主和获准看过程的访客的页面有） */
  steps?: TraceStep[] | undefined;
  /** 委派关系：上游是谁派来的，下游派出了哪些子任务 */
  delegation?: { upstream?: string; downstream: string[]; continuation?: string } | undefined;
  label: string;
  agentOnline: boolean;
  connectionState?: "online" | "connecting" | "offline";
  onClose: () => void;
  onJump?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [now, setNow] = useState(Date.now);
  const runtime = invocation.runtime;
  const error = runtime?.lastError;
  const inProgress = ["queued", "running", "timed_out", "cancelling"].includes(invocation.status);
  const terminalAt = invocation.finishedAt ?? (!inProgress ? invocation.updatedAt : undefined);
  const elapsed = Math.max(
    0,
    Math.floor(
      ((terminalAt ? Date.parse(terminalAt) : now) -
        Date.parse(invocation.startedAt ?? invocation.createdAt)) /
        1000,
    ),
  );
  const liveLabel =
    connectionState === "online"
      ? t("随事件实时更新")
      : connectionState === "connecting"
        ? t("正在重连 · 显示最近快照")
        : t("连接未确认或已断开 · 显示最近快照");

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const trigger = activeElement();
    const dialog = ref.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (dialog?.showModal) dialog.showModal();
    else dialog?.setAttribute("open", "");
    dialog?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      dialog?.close?.();
      document.body.style.overflow = overflow;
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true });
    };
  }, []);

  const tone = statusTone(invocation);
  const explanation = stateExplanation(
    explainInvocationState({ invocation, agentOnline, others: others ?? [], now }),
    invocation,
    steps,
  );
  const capability =
    runtime?.observability === "full"
      ? t("完整事件能力")
      : runtime?.observability === "partial"
        ? t("部分事件可见")
        : t("仅心跳 / 未接入事件");
  return createPortal(
    <dialog
      ref={ref}
      className="invocation-details"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="invocation-details-header">
        <div>
          <p className="invocation-details-eyebrow">
            {t("@{0} · 第 {1} 次执行", { 0: invocation.agentName, 1: invocation.attempts })}
          </p>
          <h2 id={titleId}>{t("调用详情")}</h2>
        </div>
        <IconButton
          className="invocation-details-close"
          label={t("关闭调用详情")}
          onClick={onClose}
        >
          <Icon name="close" size={18} />
        </IconButton>
      </header>
      <div className="invocation-details-content">
        <div
          className="invocation-details-state"
          data-tone={tone}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="invocation-details-badge">
            <span className="invocation-details-dot" aria-hidden="true" />
            <strong>{label}</strong>
          </span>
          <span className="invocation-details-live">{liveLabel}</span>
        </div>
        <dl className="invocation-details-stats" aria-live="off">
          <div>
            <dt>{inProgress ? t("已等待") : t("本次耗时")}</dt>
            <dd>
              {Number.isFinite(elapsed)
                ? t("{0} 分 {1} 秒", { 0: Math.floor(elapsed / 60), 1: elapsed % 60 })
                : t("未知")}
            </dd>
          </div>
          <div>
            <dt>{t("最近执行进展")}</dt>
            <dd>
              <Clock value={runtime?.lastProgressAt} now={now} />
            </dd>
          </div>
          <div>
            <dt>{t("Bridge 最近回报")}</dt>
            <dd>
              <Clock value={runtime?.lastHeartbeatAt} now={now} />
            </dd>
          </div>
          <div>
            <dt>{t("最近 Runtime 事件")}</dt>
            <dd>
              <Clock value={runtime?.lastRuntimeEventAt} now={now} />
            </dd>
          </div>
        </dl>
        {explanation && (
          <section
            className={`invocation-details-why ${explanation.tone}`}
            aria-label={t("为什么是这个状态")}
          >
            <h3>{t("为什么是这个状态")}</h3>
            <p>{explanation.text}</p>
          </section>
        )}
        {invocation.detail && <p className="invocation-details-callout">{invocation.detail}</p>}
        {error && (
          <section
            className={`invocation-details-notice ${error.recoveredAt ? "recovered" : "warning"}`}
            aria-label={t("最近 API 异常")}
          >
            <strong>
              {error.recoveredAt ? t("最近异常 · 已收到恢复证据") : t("最近异常 · 尚未确认恢复")}
              {error.code ? ` · HTTP ${error.code}` : ""}
            </strong>
            <p>
              {t("发生于")}{" "}
              <time dateTime={error.at}>
                {new Date(error.at).toLocaleTimeString(getLocale(), { hour12: false })}
              </time>
              {error.retryAttempt
                ? t("，记录到第 {0} 次重试", { 0: error.retryAttempt })
                : t("，未提供重试次数")}
              {t("。")}
            </p>
            {!error.recoveredAt && error.nextRetryAt && inProgress && (
              <p>
                {t("上报的预计重试时间： {0} ；不代表已执行或保证恢复。", {
                  0: new Date(error.nextRetryAt).toLocaleTimeString(getLocale(), { hour12: false }),
                })}
              </p>
            )}
            {!error.recoveredAt && !inProgress && <p>{t("本次调用已结束，不表示仍在重试。")}</p>}
          </section>
        )}
        {!agentOnline && (
          <p className="invocation-details-description">
            {t("Agent 当前离线；保留的是最后收到的信息。")}
          </p>
        )}
        {steps?.length ? (
          // 过程主要在对话流的卡片里看；这里收起放完整时间线，免得同一份内容摆两遍
          <details className="invocation-details-trace">
            <summary>{t("完整执行过程（{0} 步）", { 0: steps.length })}</summary>
            <TraceLog invocation={invocation} steps={steps} />
          </details>
        ) : null}
        {invocation.usage ? (
          <InvocationUsage usage={invocation.usage} />
        ) : (
          !inProgress && (
            <p className="invocation-details-description">
              {runtime?.usage
                ? t("没有收到这一轮的用量：可能在上报前就中断了。")
                : t("这一轮没有用量记录：这种 Runtime 尚未接入用量采集，或 Agent 还在用旧版本。")}
            </p>
          )
        )}
        {delegation && (
          <section aria-label={t("委派关系")}>
            <h3>{t("委派关系")}</h3>
            <dl className="invocation-details-delegation">
              {delegation.upstream && (
                <div>
                  <dt>{t("来源")}</dt>
                  <dd>{delegation.upstream}</dd>
                </div>
              )}
              {delegation.continuation && (
                <div>
                  <dt>{t("结果回执")}</dt>
                  <dd>{delegation.continuation}</dd>
                </div>
              )}
              {delegation.downstream.length > 0 && (
                <div>
                  <dt>{t("派出的子任务")}</dt>
                  <dd>
                    <ul>
                      {delegation.downstream.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </dd>
                </div>
              )}
            </dl>
          </section>
        )}
        <details className="invocation-details-metadata">
          <summary>{t("技术细节")}</summary>
          <p>
            {t("观测能力")} <span className="invocation-details-capability">{capability}</span>
          </p>
          {runtime?.observability !== "full" && (
            <p>
              {runtime?.observability === "partial"
                ? t("部分工具和响应事件可见；CLI 未暴露的内部重试或等待无法展示。")
                : t("当前适配器尚未上报结构化执行事件，无法判断它在执行、等待还是重试。")}
            </p>
          )}
          <dl>
            <dt>{t("调用 ID")}</dt>
            <dd>{invocation.id}</dd>
            <dt>{t("最后更新")}</dt>
            <dd>{new Date(invocation.updatedAt).toLocaleString()}</dd>
          </dl>
          <p id={descriptionId}>
            {t(
              "只展示已上报的执行事实：连接存活不代表模型正在执行，没有新事件也不等于卡死。执行过程房主和获准的访客能看到，只在内存里保留到刷新页面为止，已脱敏截断，不含模型内部思考、命令输出和文件正文。",
            )}
          </p>
        </details>
      </div>
      {(onJump || onOpenTerminal || onViewChanges) && (
        <footer className="invocation-details-footer dialog-actions">
          {onViewChanges && (
            <Tooltip content={t("在「代码」面板里打开它的任务线，看它改了什么")}>
              <Button onClick={onViewChanges}>{t("看改动")}</Button>
            </Tooltip>
          )}
          {onOpenTerminal && (
            <Tooltip
              content={
                invocation.status === "running" || invocation.status === "cancelling"
                  ? t("它正在执行：打开后能看到到目前为止的会话记录，别在终端里发消息")
                  : t("在终端里接着它在这个房间的会话")
              }
            >
              <Button onClick={onOpenTerminal}>{t("在终端打开会话")}</Button>
            </Tooltip>
          )}
          {onJump && (
            <Button variant="primary" onClick={onJump}>
              {t("查看回复")}
            </Button>
          )}
        </footer>
      )}
    </dialog>,
    document.body,
  );
}
