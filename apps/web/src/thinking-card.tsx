import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Invocation, TraceStep } from "@superhive/protocol";
import { t } from "./i18n";
import {
  TraceTimeline,
  currentTraceStep,
  formatDuration,
  isLiveInvocation,
  traceSummary,
  useTraceClock,
} from "./live-trace";
import "./styles/thinking-card.css";

/**
 * 对话流里的「思考中」卡片：Agent 干活时出现在回复将来出现的位置，像一条正在写的回复。
 * 以人话为主：中途说的话、拿得到的思考摘要；命令和文件操作收成一行，点开才是完整时间线。
 * 回复出来后收成回复上方的一行（TraceRecap），过程只在内存里，刷新后没有。
 */

/** 给人看的那部分：中途说的话、有正文的思考 */
export function narrativeSteps(steps: readonly TraceStep[]): TraceStep[] {
  return steps.filter(
    (step) => (step.kind === "text" || step.kind === "thinking") && Boolean(step.text?.trim()),
  );
}

/** 卡片该不该出现：执行中（含停止中），或者这一轮还没结束的等人回答 */
export function showsLiveCard(invocation: Invocation): boolean {
  return (
    isLiveInvocation(invocation) ||
    (invocation.status === "waiting_human" && !invocation.finishedAt)
  );
}

function NarrativeLine({ step }: { step: TraceStep }) {
  return (
    <p className={`thinking-card-line ${step.kind}`}>
      {/* 思考和中途的话一律按纯文本显示：可能转述了网页或文件里的内容，不能当链接或 HTML 解析 */}
      {step.text}
    </p>
  );
}

function Narrative({
  steps,
  expanded,
  live,
}: {
  steps: readonly TraceStep[];
  expanded: boolean;
  live: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [behind, setBehind] = useState(false);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && followRef.current) element.scrollTop = element.scrollHeight;
  }, [steps, expanded]);
  if (steps.length === 0) return null;
  return (
    <div className="thinking-card-narrative-wrap">
      <div
        ref={scrollRef}
        className={`thinking-card-narrative${expanded ? " expanded" : ""}`}
        aria-live="off"
        onScroll={(event) => {
          const element = event.currentTarget;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 16;
          followRef.current = atBottom;
          setBehind(!atBottom);
        }}
      >
        {steps.map((step) => (
          <NarrativeLine key={step.id} step={step} />
        ))}
      </div>
      {live && behind && (
        <button
          type="button"
          className="thinking-card-latest"
          onClick={() => {
            const element = scrollRef.current;
            if (!element) return;
            followRef.current = true;
            setBehind(false);
            element.scrollTop = element.scrollHeight;
          }}
        >
          {t("↓ 最新")}
        </button>
      )}
    </div>
  );
}

/** 卡片主体：叙述 + 收起的执行步骤；执行中的卡片和结束后的回顾共用 */
function CardBody({
  invocation,
  steps,
  expanded,
  now,
}: {
  invocation: Invocation;
  steps: readonly TraceStep[];
  expanded: boolean;
  now: number;
}) {
  const live = isLiveInvocation(invocation);
  const narrative = narrativeSteps(steps);
  const tools = steps.filter((step) => step.kind !== "text");
  const toolSummary = traceSummary(tools, now);
  return (
    <>
      <Narrative steps={narrative} expanded={expanded} live={live} />
      {tools.length > 0 && (
        <details className="thinking-card-steps">
          <summary>{toolSummary || t("执行步骤 {0} 个", { 0: tools.length })}</summary>
          <div className="thinking-card-timeline">
            <TraceTimeline steps={tools} now={now} live={live} />
          </div>
        </details>
      )}
    </>
  );
}

function stateLabel(invocation: Invocation, steps: readonly TraceStep[]): string {
  if (invocation.status === "cancelling") return t("停止中");
  if (invocation.status === "waiting_human") return t("等你回答");
  // 最近一步是还没结束的思考才叫「思考中」，在跑命令、改文件时是「执行中」
  const last = steps.filter((step) => step.kind !== "text").at(-1);
  return last?.kind === "thinking" && !last.endedAt ? t("思考中") : t("执行中");
}

/** 执行中的卡片 */
export function ThinkingCard({
  invocation,
  steps,
  avatar,
  traceAllowed = true,
  defaultCollapsed = false,
}: {
  invocation: Invocation;
  steps: readonly TraceStep[] | undefined;
  avatar: ReactNode;
  /** 当前用户能不能看执行过程（房主，或邀请时开了「看执行过程」的访客） */
  traceAllowed?: boolean;
  /** 同时有多张卡片时，较早的默认收起，只展开最新的；用户手动点过以后以用户为准 */
  defaultCollapsed?: boolean;
}) {
  const [userCollapsed, setUserCollapsed] = useState<boolean>();
  const [expanded, setExpanded] = useState(false);
  const waiting = invocation.status === "waiting_human";
  // 等你回答时，提问消息、提醒、侧栏都已经标出来了，卡片默认只留一行
  const collapsed = userCollapsed ?? (defaultCollapsed || waiting);
  const now = useTraceClock(invocation);
  const list = steps ?? [];
  const current = currentTraceStep(list);
  const elapsed = formatDuration(now - Date.parse(invocation.startedAt ?? invocation.createdAt));
  const observable = list.length > 0;
  // 看不到过程：访客没获准，或者这种 Runtime 只报心跳——只显示在做、做了多久，不编造过程。
  // 能看、只是第一步还没到（刚开工那一两秒）时叫「启动中」，不能误报成看不到
  const unobservable =
    !observable && (!traceAllowed || invocation.runtime?.observability === "heartbeat");
  const hasNarrative = narrativeSteps(list).length > 0;
  return (
    <article
      className={`thinking-card${collapsed ? " collapsed" : ""}`}
      data-invocation-id={invocation.id}
      aria-label={t("{0} 正在处理", { 0: invocation.agentName })}
      title={unobservable ? t("这种 Agent 不上报执行过程，或你没有查看执行过程的权限") : undefined}
    >
      <span className="avatar agent" aria-hidden="true">
        {avatar}
      </span>
      <div className="thinking-card-content">
        <header>
          <strong>{invocation.agentName}</strong>
          <span className={`thinking-card-state ${invocation.status}`}>
            <span className="thinking-card-dot" aria-hidden="true" />
            {stateLabel(invocation, list)}
          </span>
          <span className="thinking-card-current" title={current}>
            {observable ? current : unobservable ? t("看不到具体步骤") : t("启动中")}
          </span>
          {/* 等你回答时不再计时：这一轮已经停下在等人 */}
          {!waiting && <span className="thinking-card-elapsed">{elapsed}</span>}
          {observable && (
            <button
              type="button"
              className="thinking-card-toggle"
              aria-expanded={!collapsed}
              onClick={() => setUserCollapsed(!collapsed)}
            >
              {collapsed ? t("展开") : t("收起")}
            </button>
          )}
        </header>
        {!collapsed && observable && (
          <>
            <CardBody invocation={invocation} steps={list} expanded={expanded} now={now} />
            {hasNarrative && (
              <button
                type="button"
                className="thinking-card-more"
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? t("只看最近几行") : t("看全部")}
              </button>
            )}
          </>
        )}
      </div>
    </article>
  );
}

/** 结束后：收成回复上方（或没回复时触发消息下方）的一行，点开回看这一轮的过程 */
const outcomeLabels: Partial<Record<Invocation["status"], () => string>> = {
  failed: () => t("失败"),
  cancelled: () => t("已停止"),
  timed_out: () => t("结果未知"),
};

/** 最后一段中途的话往往就是最终回复本身：回顾里去掉，免得和下面的回复重复一遍 */
export function withoutFinalReply(steps: readonly TraceStep[], replyText?: string): TraceStep[] {
  const reply = replyText?.trim();
  if (!reply) return [...steps];
  const lastText = [...steps].reverse().find((step) => step.kind === "text" && step.text?.trim());
  const text = lastText?.text?.trim();
  if (!lastText || !text || !(reply === text || reply.startsWith(text) || text.startsWith(reply))) {
    return [...steps];
  }
  return steps.filter((step) => step !== lastText);
}

export function TraceRecap({
  invocation,
  steps: allSteps,
  replyText,
}: {
  invocation: Invocation;
  steps: readonly TraceStep[];
  /** 这一轮的回复正文：用来去掉和回复重复的最后一段 */
  replyText?: string;
}) {
  const steps = withoutFinalReply(allSteps, replyText);
  const [open, setOpen] = useState(false);
  const now = useTraceClock(invocation);
  const start = Date.parse(invocation.startedAt ?? invocation.createdAt);
  const end = Date.parse(invocation.finishedAt ?? invocation.updatedAt);
  const total = Number.isFinite(start) && Number.isFinite(end) ? end - start : 0;
  const outcome = outcomeLabels[invocation.status]?.();
  const summary = [
    outcome,
    traceSummary(steps, now),
    total > 0 ? t("用时 {0}", { 0: formatDuration(total) }) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={`trace-recap${open ? " open" : ""}`}>
      <button
        type="button"
        className="trace-recap-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="trace-recap-caret" aria-hidden="true">
          ▸
        </span>
        {t("{0} 的过程", { 0: invocation.agentName })}
        {summary && <span className="trace-recap-summary">· {summary}</span>}
      </button>
      {open && (
        <div className="trace-recap-body">
          <CardBody invocation={invocation} steps={steps} expanded now={now} />
        </div>
      )}
    </div>
  );
}
