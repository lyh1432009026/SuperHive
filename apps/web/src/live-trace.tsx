import { useEffect, useState } from "react";
import type { Invocation, TraceStep } from "@superhive/protocol";
import { localized, t } from "./i18n";
import { formatElapsed } from "./invocations";

/** 按 id 合并新到的步骤，保持首次出现的顺序 */
export function mergeTraceSteps(current: readonly TraceStep[], incoming: TraceStep[]): TraceStep[] {
  const next = [...current];
  for (const step of incoming) {
    const index = next.findIndex((item) => item.id === step.id);
    if (index >= 0) next[index] = { ...next[index], ...step };
    else next.push(step);
  }
  return next.slice(-300);
}

const toolNames: Record<NonNullable<TraceStep["tool"]>, string> = localized(() => ({
  read: t("读取"),
  write: t("编辑"),
  search: t("搜索"),
  command: t("运行"),
  collaboration: t("协作"),
  other: t("工具"),
}));

function seconds(step: TraceStep, now: number): number {
  const end = step.endedAt ? Date.parse(step.endedAt) : now;
  return Math.max(0, Math.round((end - Date.parse(step.startedAt)) / 1000));
}

/** 一行汇总：思考多久、跑了几条命令、改了几个文件…… */
export function traceSummary(steps: readonly TraceStep[], now: number): string {
  const thinking = steps
    .filter((step) => step.kind === "thinking")
    .reduce((total, step) => total + seconds(step, now), 0);
  const count = (tool: TraceStep["tool"]) =>
    steps.filter((step) => step.kind === "tool" && step.tool === tool).length;
  const others = steps.filter(
    (step) =>
      step.kind === "tool" &&
      step.tool !== "command" &&
      step.tool !== "write" &&
      step.tool !== "read" &&
      step.tool !== "search",
  ).length;
  const parts = [
    thinking > 0 ? t("思考 {0} 秒", { 0: thinking }) : undefined,
    count("command") ? t("运行 {0} 条命令", { 0: count("command") }) : undefined,
    count("write") ? t("编辑 {0} 次", { 0: count("write") }) : undefined,
    count("read") ? t("读取 {0} 次", { 0: count("read") }) : undefined,
    count("search") ? t("搜索 {0} 次", { 0: count("search") }) : undefined,
    others ? t("其他工具 {0} 次", { 0: others }) : undefined,
  ].filter(Boolean);
  return parts.join(" · ");
}

function StepLine({ step, now }: { step: TraceStep; now: number }) {
  if (step.kind === "text") {
    return <p className="trace-text">{step.text}</p>;
  }
  if (step.kind === "thinking") {
    return (
      <p className={`trace-step thinking ${step.status ?? ""}`}>
        <span className="trace-mark" aria-hidden="true" />
        <span className="trace-label">
          {step.endedAt
            ? t("思考了 {0} 秒", { 0: seconds(step, now) })
            : t("思考中 {0} 秒", { 0: seconds(step, now) })}
        </span>
      </p>
    );
  }
  const status =
    step.status === "error" ? t("失败") : step.status === "running" ? t("进行中") : undefined;
  return (
    <p className={`trace-step tool ${step.status ?? ""}`}>
      <span className="trace-mark" aria-hidden="true" />
      <span className="trace-label">{toolNames[step.tool ?? "other"]}</span>
      <code className="trace-summary" title={step.summary}>
        {step.summary || step.name}
      </code>
      <span className="trace-meta">
        {status && <span className="trace-status">{status}</span>}
        {(step.endedAt || step.status === "running") && `${seconds(step, now)}s`}
      </span>
    </p>
  );
}

/** 最近几步默认展示的条数；中途说的话总是显示 */
const RECENT_STEPS = 6;

/**
 * 执行中的实时过程（像 CLI 一样滚动刷新）：只有房主的页面会收到数据，结束后就消失，
 * 结果以 Agent 的回复为准。
 */
export function LiveTrace({ invocation, steps }: { invocation: Invocation; steps: TraceStep[] }) {
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  if (steps.length === 0) return null;
  const visible = expanded ? steps : steps.slice(-RECENT_STEPS);
  const hidden = steps.length - visible.length;
  const summary = traceSummary(steps, now);
  const since = invocation.startedAt ?? invocation.updatedAt;
  return (
    <section
      className="live-trace"
      aria-label={t("@{0} 的执行过程", { 0: invocation.agentName })}
      aria-live="off"
      onClick={(event) => event.stopPropagation()}
    >
      <header>
        <span className="live-trace-dot" aria-hidden="true" />
        <strong>{t("@{0} 执行中", { 0: invocation.agentName })}</strong>
        <span>
          {[summary, t("已用 {0}", { 0: formatElapsed(now - Date.parse(since)) })]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </header>
      {hidden > 0 && (
        <button type="button" className="live-trace-more" onClick={() => setExpanded(true)}>
          {t("显示前面 {0} 步", { 0: hidden })}
        </button>
      )}
      <div className="live-trace-steps">
        {visible.map((step) => (
          <StepLine key={step.id} step={step} now={now} />
        ))}
      </div>
      {expanded && steps.length > RECENT_STEPS && (
        <button type="button" className="live-trace-more" onClick={() => setExpanded(false)}>
          {t("只看最近 {0} 步", { 0: RECENT_STEPS })}
        </button>
      )}
    </section>
  );
}
