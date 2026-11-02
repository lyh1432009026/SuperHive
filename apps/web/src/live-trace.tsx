import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Invocation, TraceStep } from "@superhive/protocol";
import { localized, t } from "./i18n";

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

/** 连续多次时合成一行的说法，例如「读取 5 个文件」 */
const groupNames: Partial<Record<NonNullable<TraceStep["tool"]>, string>> = localized(() => ({
  read: t("读取 {0} 个文件"),
  write: t("编辑 {0} 次"),
  search: t("搜索 {0} 次"),
  other: t("调用工具 {0} 次"),
  collaboration: t("协作工具 {0} 次"),
}));

function seconds(step: TraceStep, now: number): number {
  const end = step.endedAt ? Date.parse(step.endedAt) : now;
  return Math.max(0, Math.round((end - Date.parse(step.startedAt)) / 1000));
}

/** 时长：不到一分钟「22 秒」，否则「3 分 53 秒」 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return total < 60
    ? t("{0} 秒", { 0: total })
    : t("{0} 分 {1} 秒", { 0: Math.floor(total / 60), 1: total % 60 });
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

/** 最近一步在做什么：给底部「正在执行」浮条用 */
export function currentTraceStep(steps: readonly TraceStep[]): string | undefined {
  const actions = steps.filter((item) => item.kind !== "text");
  const step = [...actions].reverse().find((item) => item.status === "running") ?? actions.at(-1);
  if (!step) return undefined;
  if (step.kind === "thinking") return step.endedAt ? undefined : t("思考中");
  return `${toolNames[step.tool ?? "other"]} ${step.summary || step.name || ""}`.trim();
}

type TraceRow =
  | { type: "step"; step: TraceStep }
  | { type: "group"; id: string; tool: NonNullable<TraceStep["tool"]>; steps: TraceStep[] };

/**
 * 连续的同类工具步骤（读文件、搜索、编辑……）合成一行，点开再看明细，像 CLI 的「Read 5 files」。
 * 命令一条一行；失败和进行中的步骤总是单独显示，不被合并藏起来。
 */
export function groupTraceSteps(steps: readonly TraceStep[]): TraceRow[] {
  const rows: TraceRow[] = [];
  let run: TraceStep[] = [];
  const flush = () => {
    if (run.length >= 2) {
      rows.push({ type: "group", id: run[0]!.id, tool: run[0]!.tool!, steps: run });
    } else if (run.length === 1) rows.push({ type: "step", step: run[0]! });
    run = [];
  };
  for (const step of steps) {
    const groupable =
      step.kind === "tool" &&
      step.tool !== undefined &&
      step.tool !== "command" &&
      step.status !== "error" &&
      step.status !== "running";
    if (groupable && (run.length === 0 || run[0]!.tool === step.tool)) {
      run.push(step);
      continue;
    }
    flush();
    if (groupable) run.push(step);
    else rows.push({ type: "step", step });
  }
  flush();
  return rows;
}

/** 中途说的话：默认只露三行，长了点开看全文 */
function TraceText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 180 || text.split("\n").length > 3;
  return (
    <div className={`trace-text${long && !open ? " clamped" : ""}`}>
      <p>{text}</p>
      {long && (
        <button type="button" className="trace-text-toggle" onClick={() => setOpen(!open)}>
          {open ? t("收起") : t("展开全文")}
        </button>
      )}
    </div>
  );
}

function StepLine({ step, now, live }: { step: TraceStep; now: number; live: boolean }) {
  if (step.kind === "text") return <TraceText text={step.text ?? ""} />;
  // 调用已经结束、但这一步没收到结束事件：不再显示「进行中」，也不再计时
  const status = step.status === "running" && !live ? "stopped" : (step.status ?? "");
  if (step.kind === "thinking") {
    return (
      <p className={`trace-step thinking ${status}`}>
        <span className="trace-mark" aria-hidden="true" />
        <span className="trace-label">
          {step.endedAt || !live
            ? t("思考了 {0} 秒", { 0: seconds(step, now) })
            : t("思考中 {0} 秒", { 0: seconds(step, now) })}
        </span>
      </p>
    );
  }
  const label = status === "error" ? t("失败") : status === "running" ? t("进行中") : undefined;
  return (
    <p className={`trace-step tool ${status}`}>
      <span className="trace-mark" aria-hidden="true" />
      <span className="trace-label">{toolNames[step.tool ?? "other"]}</span>
      <code className="trace-summary" title={step.summary}>
        {step.summary || step.name}
      </code>
      <span className="trace-meta">
        {label && <span className="trace-status">{label}</span>}
        {(step.endedAt || status === "running") && `${seconds(step, now)}s`}
      </span>
    </p>
  );
}

function GroupLine({
  row,
  now,
  live,
}: {
  row: Extract<TraceRow, { type: "group" }>;
  now: number;
  live: boolean;
}) {
  const total = row.steps.reduce((sum, step) => sum + seconds(step, now), 0);
  return (
    <details className="trace-group">
      <summary className="trace-step tool ok">
        <span className="trace-mark" aria-hidden="true" />
        <span className="trace-label">
          {(groupNames[row.tool] ?? t("调用工具 {0} 次")).replace("{0}", String(row.steps.length))}
        </span>
        <code className="trace-summary">
          {row.steps
            .map((step) => step.summary || step.name)
            .filter(Boolean)
            .join(", ")}
        </code>
        <span className="trace-meta">{`${total}s`}</span>
      </summary>
      <div className="trace-group-steps">
        {row.steps.map((step) => (
          <StepLine key={step.id} step={step} now={now} live={live} />
        ))}
      </div>
    </details>
  );
}

/** 一步一行的时间线；执行中的过程框和调用详情弹窗共用 */
export function TraceTimeline({
  steps,
  now,
  live,
}: {
  steps: readonly TraceStep[];
  now: number;
  live: boolean;
}) {
  return (
    <div className="live-trace-steps">
      {groupTraceSteps(steps).map((row) =>
        row.type === "group" ? (
          <GroupLine key={`g-${row.id}`} row={row} now={now} live={live} />
        ) : (
          <StepLine key={row.step.id} step={row.step} now={now} live={live} />
        ),
      )}
    </div>
  );
}

export function isLiveInvocation(invocation: Invocation): boolean {
  return invocation.status === "running" || invocation.status === "cancelling";
}

/** 执行中每秒走一次；结束后停在结束时刻 */
export function useTraceClock(invocation: Invocation): number {
  const live = isLiveInvocation(invocation);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  if (live) return now;
  const end = Date.parse(invocation.finishedAt ?? invocation.updatedAt);
  return Number.isFinite(end) ? end : now;
}

/**
 * 调用详情里的执行过程（像终端一样滚动刷新）：只有房主的页面会收到数据。
 * 新步骤自动滚到底；往上翻时停止跟随，回到底部再继续。结束后保留到刷新页面为止。
 */
export function TraceLog({ invocation, steps }: { invocation: Invocation; steps: TraceStep[] }) {
  const live = isLiveInvocation(invocation);
  const now = useTraceClock(invocation);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && followRef.current) element.scrollTop = element.scrollHeight;
  }, [steps, live]);
  return (
    <section className="trace-log" aria-label={t("执行过程")}>
      <header>
        {live && <span className="live-trace-dot" aria-hidden="true" />}
        <strong>{t("执行过程")}</strong>
        <span className="live-trace-line">{traceSummary(steps, now)}</span>
        <span className="live-trace-elapsed">
          {formatDuration(now - Date.parse(invocation.startedAt ?? invocation.createdAt))}
        </span>
      </header>
      <div
        ref={scrollRef}
        className="trace-log-scroll"
        aria-live="off"
        onScroll={(event) => {
          const element = event.currentTarget;
          followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
      >
        <TraceTimeline steps={steps} now={now} live={live} />
      </div>
    </section>
  );
}
