import { useEffect, useState } from "react";
import { InvocationDetails } from "./invocation-details";
import {
  explainInvocationState,
  type ChatMessage,
  type Invocation,
  type Participant,
  type TraceStep,
} from "@superhive/protocol";
import { localized, t } from "./i18n";

/** 人点一次「继续」为当前 Agent 对话追加的轮数，同时放宽连续轮数、转交深度和单链条数 */
export const BUDGET_EXTEND_TURNS = 10;

/** 被预算拦下、可以由人点「继续」恢复的调用：三种预算都随追加的轮数一起放宽 */
export function isExtendableBlock(invocation: Invocation): boolean {
  return (
    invocation.status === "blocked" &&
    (invocation.blockReason === "hop_limit" ||
      invocation.blockReason === "consecutive_limit" ||
      invocation.blockReason === "pair_limit")
  );
}

/**
 * 顶部「继续」提示只针对人最后一次发言之后被拦下的调用，与服务端追加额度的范围一致；
 * 更早的拦截已经被人的发言越过，点「继续」也不会恢复，不再提示。
 */
export function currentPausedInvocations(
  invocations: Iterable<Invocation>,
  messages: readonly ChatMessage[],
): Invocation[] {
  let lastHumanSeq = 0;
  const seqById = new Map<string, number>();
  for (const message of messages) {
    seqById.set(message.id, message.seq);
    if (message.senderType === "human" && message.seq > lastHumanSeq) lastHumanSeq = message.seq;
  }
  return [...invocations].filter(
    (invocation) =>
      isExtendableBlock(invocation) && (seqById.get(invocation.messageId) ?? 0) >= lastHumanSeq,
  );
}

/** 上游模型服务出错中断（Bridge 写的说明以此开头）：重试即接着原会话继续 */
export const UPSTREAM_FAILURE_PREFIX = "上游模型服务出错";

export function isUpstreamInterrupted(invocation: Invocation): boolean {
  return (
    invocation.status === "failed" &&
    // 新版 Bridge 带结构化文案，按键判断；旧版只有中文说明，按前缀判断
    (invocation.detailText
      ? invocation.detailText.key === "bridge.upstreamFailed"
      : Boolean(invocation.detail?.startsWith(UPSTREAM_FAILURE_PREFIX)))
  );
}

function retryLabel(invocation: Invocation): string {
  if (invocation.blockReason === "guest_approval") return t("批准");
  return isUpstreamInterrupted(invocation) ? t("继续") : t("重试");
}

export function canRetryInvocation(invocation: Invocation): boolean {
  return (
    invocation.status === "failed" ||
    invocation.status === "cancelled" ||
    (invocation.status === "blocked" && invocation.blockReason !== "hop_limit")
  );
}

/** 可以「忽略」的调用：失败、被拦、结果未知，且还没被收起 */
export function canDismissInvocation(invocation: Invocation): boolean {
  return (
    !invocation.resolution &&
    (invocation.status === "failed" ||
      invocation.status === "blocked" ||
      invocation.status === "timed_out")
  );
}

/** 支持把新消息插进正在执行的这一轮的运行时 */
const STEERABLE_PROVIDERS = new Set(["claude", "codex", "opencode", "omp"]);

/**
 * 能「引导」：人发的、还在排队的消息，而且同一个 Agent 在这个房间正有任务在执行、
 * 它的运行时支持引导。服务端会再核对一遍（定时触发、Agent 发的消息都会被拒绝）。
 */
export function canSteerInvocation(
  invocation: Invocation,
  all: Iterable<Invocation>,
  provider: string | undefined,
): boolean {
  if (invocation.status !== "queued" || invocation.resolution) return false;
  if (invocation.requesterType !== "human") return false;
  if (!provider || !STEERABLE_PROVIDERS.has(provider)) return false;
  for (const other of all) {
    if (
      other.id !== invocation.id &&
      other.agentId === invocation.agentId &&
      other.roomId === invocation.roomId &&
      other.status === "running"
    ) {
      return true;
    }
  }
  return false;
}

/** 正在执行的任务（「停下当前，改做这条」需要有它；不要求运行时支持引导） */
export function hasRunningTask(invocation: Invocation, all: Iterable<Invocation>): boolean {
  for (const other of all) {
    if (
      other.id !== invocation.id &&
      other.agentId === invocation.agentId &&
      other.roomId === invocation.roomId &&
      other.status === "running"
    ) {
      return true;
    }
  }
  return false;
}

export function canCancelInvocation(invocation: Invocation): boolean {
  if (invocation.resolution) return false;
  return (
    invocation.status === "queued" ||
    invocation.status === "running" ||
    invocation.status === "timed_out" ||
    invocation.status === "waiting_human"
  );
}

/** Agent 的提问消息对应的、仍在等人回答的调用（提问挂在触发消息下，由提问的 Agent 发出） */
export function waitingInvocationForQuestion(
  question: ChatMessage,
  invocations: Iterable<Invocation>,
): Invocation | undefined {
  if (question.kind !== "question" || !question.parentMessageId || question.deletedAt) {
    return undefined;
  }
  for (const invocation of invocations) {
    if (
      invocation.status === "waiting_human" &&
      invocation.messageId === question.parentMessageId &&
      invocation.agentId === question.senderId
    ) {
      return invocation;
    }
  }
  return undefined;
}

export function upsertInvocation(
  current: ReadonlyMap<string, Invocation>,
  invocation: Invocation,
): Map<string, Invocation> {
  const existing = current.get(invocation.id);
  // 乱序到达的旧快照不能覆盖更新的状态
  if (existing && existing.updatedAt > invocation.updatedAt)
    return current as Map<string, Invocation>;
  const next = new Map(current);
  next.set(invocation.id, invocation);
  return next;
}

/** 按触发消息分组，组内按创建时间排序，渲染时 O(1) 取用 */
export function groupInvocationsByMessage(
  invocations: ReadonlyMap<string, Invocation>,
): Map<string, Invocation[]> {
  const groups = new Map<string, Invocation[]>();
  for (const invocation of invocations.values()) {
    const group = groups.get(invocation.messageId);
    if (group) group.push(invocation);
    else groups.set(invocation.messageId, [invocation]);
  }
  for (const group of groups.values()) {
    group.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.agentName.localeCompare(b.agentName),
    );
  }
  return groups;
}

const continuationLabels: Record<NonNullable<Invocation["continuation"]>, string> = localized(
  () => ({
    pending: t("结果待回执"),
    delivered: t("结果已回执"),
    consumed: t("结果已被取走"),
    failed: t("回执失败"),
  }),
);

export type DelegationView = {
  /** 上游：谁派来的；relation 区分 hive_invoke 委派和普通 @ 转交 */
  upstream?: { invocation?: Invocation; requesterName: string; relation: "委派" | "转交" };
  downstream: Invocation[];
  /** 子任务结果回执状态（只有 hive_invoke 委派的子任务才有） */
  continuation?: string;
};

/**
 * 从调用记录里还原委派关系：上游按 parentInvocationId 精确查找，下游是以它为上游的调用。
 * 上游不在已加载的记录里时只给出发起方名字，不拼凑不存在的关系。
 */
export function delegationView(
  invocation: Invocation,
  all: Iterable<Invocation>,
): DelegationView | undefined {
  const list = [...all];
  const downstream = list
    .filter((candidate) => candidate.parentInvocationId === invocation.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const relation = invocation.continuation ? t("委派") : t("转交");
  const upstream =
    invocation.requesterType === "agent"
      ? {
          ...(invocation.parentInvocationId
            ? {
                invocation: list.find(
                  (candidate) => candidate.id === invocation.parentInvocationId,
                ),
              }
            : {}),
          requesterName: invocation.requesterName,
          relation,
        }
      : undefined;
  if (!upstream && downstream.length === 0) return undefined;
  return {
    ...(upstream ? { upstream: upstream as NonNullable<DelegationView["upstream"]> } : {}),
    downstream,
    ...(invocation.continuation
      ? { continuation: continuationLabels[invocation.continuation] }
      : {}),
  };
}

/** 调用详情里的委派关系，逐行展示上下游及其状态 */
export function delegationLines(
  invocation: Invocation,
  all: Iterable<Invocation>,
): { upstream?: string; downstream: string[]; continuation?: string } | undefined {
  const view = delegationView(invocation, all);
  if (!view) return undefined;
  const upstream = view.upstream
    ? view.upstream.invocation
      ? t("@{0} {1}（上游调用：{2}）", {
          0: view.upstream.requesterName,
          1: view.upstream.relation,
          2: invocationStatusLabel(view.upstream.invocation, true),
        })
      : t("@{0} {1}（上游调用不在当前已加载的记录里）", {
          0: view.upstream.requesterName,
          1: view.upstream.relation,
        })
    : undefined;
  return {
    ...(upstream ? { upstream } : {}),
    downstream: view.downstream.map(
      (child) =>
        `@${child.agentName} · ${invocationStatusLabel(child, true)}${
          child.continuation ? ` · ${continuationLabels[child.continuation]}` : ""
        }`,
    ),
    ...(view.continuation ? { continuation: view.continuation } : {}),
  };
}

/** 一句话概括委派关系，用于任务列表和调用状态行 */
export function delegationSummary(
  invocation: Invocation,
  all: Iterable<Invocation>,
): string | undefined {
  const view = delegationView(invocation, all);
  if (!view) return undefined;
  const parts: string[] = [];
  if (view.upstream)
    parts.push(t("由 @{0} {1}", { 0: view.upstream.requesterName, 1: view.upstream.relation }));
  if (view.continuation) parts.push(view.continuation);
  if (view.downstream.length) {
    const open = view.downstream.filter((child) =>
      ["queued", "running", "cancelling", "blocked", "timed_out", "waiting_human"].includes(
        child.status,
      ),
    ).length;
    parts.push(
      open
        ? t("派出 {0} 个子任务，{1} 个未结束", { 0: view.downstream.length, 1: open })
        : t("派出的 {0} 个子任务都已结束", { 0: view.downstream.length }),
    );
  }
  return parts.join(" · ");
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return t("{0}秒", { 0: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("{0}分钟", { 0: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? t("{0}小时{1}分", { 0: hours, 1: rest }) : t("{0}小时", { 0: hours });
}

export function invocationStatusLabel(invocation: Invocation, agentOnline: boolean): string {
  const error = invocation.runtime?.lastError;
  if (invocation.status === "running" && error && !error.recoveredAt) {
    return error.code === 429
      ? t("服务限流 · HTTP 429")
      : t("API 异常{0}", { 0: error.code ? ` · HTTP ${error.code}` : "" });
  }
  switch (invocation.status as string) {
    case "queued":
      if (invocation.receivedAt) return t("已送达，排队中");
      return agentOnline ? t("排队中") : t("等待上线");
    case "running":
      return t("进行中");
    case "completed":
      return t("已完成");
    case "failed":
      return t("失败");
    case "blocked":
      return invocation.blockReason === "guest_approval" ? t("等房主批准") : t("已暂停");
    case "timed_out":
      return t("结果未知");
    case "cancelled":
      return t("已停止");
    case "cancelling":
      return t("正在停止 · 待确认");
    case "waiting_human":
      return t("等你回答");
    default:
      return t("状态待核实");
  }
}

function invocationHint(invocation: Invocation, agentOnline: boolean): string | undefined {
  if (invocation.status === "cancelling")
    return t("已请求停止，等待 Runtime 确认；确认前不能重试。");
  if (invocation.status === "timed_out") {
    return [invocation.detail, t("长时间未收到结果，这不一定是失败，迟到的回复仍可能到达。")]
      .filter(Boolean)
      .join(" · ");
  }
  if (invocation.status === "queued" && !invocation.receivedAt && !agentOnline) {
    return t("{0} 当前离线，上线后会自动收到这条消息。", { 0: invocation.agentName });
  }
  if (invocation.status === "running") return invocation.progress ?? invocation.detail;
  if (invocation.status === "waiting_human") {
    return [invocation.detail, t("回复它的提问即可继续")].filter(Boolean).join(" · ");
  }
  return invocation.detail;
}

function ElapsedTime({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="invocation-elapsed">{formatElapsed(now - new Date(since).getTime())}</span>
  );
}

/**
 * 排队中的调用为什么还没开始：前面有几个任务、派出多久还没确认收到。离线已由状态文字说明，这里不重复。
 * 每秒自己刷新，过了 5 秒的活动门闩就换成警示样式。
 */
function QueueHint({
  invocation,
  agentOnline,
  others,
}: {
  invocation: Invocation;
  agentOnline: boolean;
  others: readonly Invocation[];
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const state = explainInvocationState({ invocation, agentOnline, others, now });
  const seconds = Math.round(state.waitedMs / 1000);
  const waited =
    seconds < 60 ? t("{0} 秒", { 0: seconds }) : t("{0} 分钟", { 0: Math.floor(seconds / 60) });
  const text =
    state.code === "queued_behind"
      ? t("前面还有 {0} 个", { 0: state.ahead })
      : state.code === "queued_undelivered" && state.stalled
        ? t("派出 {0} 还没确认收到", { 0: waited })
        : state.code === "queued_received" && state.stalled
          ? t("已收到 {0}，还没开始", { 0: waited })
          : undefined;
  if (!text) return null;
  return (
    // 正常排队不算异常；没确认收到、收到了却不开始才用警示色
    <span
      className={`invocation-progress queue-hint${state.stalled && state.code !== "queued_behind" ? " stalled" : ""}`}
    >
      {text}
    </span>
  );
}

export function InvocationChips({
  invocations,
  participants,
  canJumpTo,
  onJump,
  onRetry,
  onCancel,
  onExtend,
  connectionState,
  allInvocations,
  isOwner = true,
  onLocate,
  onDismiss,
  traces,
  onSteer,
  onPreempt,
  onOpenTerminal,
  onRetryWithModel,
}: {
  /** 「换个模型重试」：只有房主能用，失败的任务上才有 */
  onRetryWithModel?: ((invocation: Invocation) => void) | undefined;
  /** 「在终端打开会话」：本机 Agent 才返回处理函数 */
  onOpenTerminal?: ((invocation: Invocation) => (() => void) | undefined) | undefined;
  /** 「引导」：把排队中的这条插进 Agent 正在执行的这一轮 */
  onSteer?: (invocation: Invocation) => void;
  /** 「停下当前，改做这条」 */
  onPreempt?: (invocation: Invocation) => void;
  /** 执行过程（房主和获准看过程的访客的页面有）：状态行显示当前这一步，详情弹窗里看完整过程 */
  traces?: ReadonlyMap<string, TraceStep[]>;
  /** 「忽略」：标为已处理，不再算作需要处理 */
  onDismiss?: (invocation: Invocation) => void;
  /** 底部状态栏里用：跳到触发这条调用的消息 */
  onLocate?: (messageId: string) => void;
  /** 访客看不到「批准」：访客的请求只能由房主放行 */
  isOwner?: boolean;
  invocations: Invocation[];
  /** 房间里全部调用，用来展示委派关系；省略时只看本条消息的调用 */
  allInvocations?: ReadonlyMap<string, Invocation>;
  participants: Participant[];
  canJumpTo: (messageId: string) => boolean;
  onJump: (messageId: string) => void;
  onRetry: (invocation: Invocation) => void;
  onCancel: (invocation: Invocation) => void;
  onExtend: () => void;
  connectionState?: "online" | "connecting" | "offline";
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const selected = invocations.find((invocation) => invocation.id === selectedId);
  return (
    <>
      <div className="invocation-row" role="list" aria-label={t("Agent 调用状态")}>
        {invocations.map((invocation) => {
          const agentOnline = participants.some(
            (participant) =>
              participant.id === invocation.agentId && participant.status !== "offline",
          );
          const label = invocationStatusLabel(invocation, agentOnline);
          const delegation = delegationSummary(invocation, allInvocations?.values() ?? invocations);
          const rawHint = [invocationHint(invocation, agentOnline), delegation]
            .filter(Boolean)
            .join(" · ");
          const hint = !rawHint || rawHint === label ? undefined : rawHint;
          // 有执行过程时，当前这一步显示在对话流的「思考中」卡片里，状态行不再重复
          const traced = Boolean(traces?.get(invocation.id)?.length);
          const jumpTarget =
            invocation.status === "completed" &&
            invocation.replyMessageId &&
            canJumpTo(invocation.replyMessageId)
              ? invocation.replyMessageId
              : undefined;
          const summary = (
            <>
              <span className="invocation-indicator" aria-hidden="true">
                {invocation.status === "completed" && (
                  <svg viewBox="0 0 24 24">
                    <path d="m5 12 4 4L19 6" />
                  </svg>
                )}
              </span>
              <span className="invocation-agent">@{invocation.agentName}</span>
              <span className="invocation-status">{label}</span>
              {invocation.status === "running" && !traced && invocation.progress && (
                <span className="invocation-progress">{invocation.progress}</span>
              )}
              {/* 引导的进展（正在插入、已并入 #n、没插进去转回排队……） */}
              {((invocation.status === "running" && !traced && !invocation.progress) ||
                invocation.status === "queued") &&
                invocation.detail &&
                // 服务端收到确认时写的「已送达，排队中」和状态文字一样，不重复显示
                invocation.detail !== label && (
                  <span className="invocation-progress">{invocation.detail}</span>
                )}
              {(invocation.status === "blocked" ||
                invocation.status === "failed" ||
                invocation.status === "waiting_human" ||
                // 完成但没有回复消息：Agent 判断无需回复，标出来免得像是漏处理
                (invocation.status === "completed" && !invocation.replyMessageId)) &&
                invocation.detail && (
                  <span className="invocation-progress">{invocation.detail}</span>
                )}
              {invocation.status === "queued" && agentOnline && (
                <QueueHint
                  invocation={invocation}
                  agentOnline={agentOnline}
                  others={[...(allInvocations?.values() ?? invocations)]}
                />
              )}
              {invocation.status === "running" && (
                <ElapsedTime since={invocation.startedAt ?? invocation.updatedAt} />
              )}
              {invocation.attempts > 1 && (
                <span className="invocation-attempts">
                  {t("第{0}次", { 0: invocation.attempts })}
                </span>
              )}
              {delegation && <span className="invocation-delegation">{delegation}</span>}
              {invocation.resolution && (
                <span className="invocation-resolution">
                  {invocation.resolution.kind === "dismissed"
                    ? t("{0}已忽略", { 0: invocation.resolution.by ?? "" })
                    : (invocation.resolution.note ?? t("已被后续处理取代"))}
                </span>
              )}
            </>
          );
          const ariaSummary = [
            `@${invocation.agentName}`,
            label,
            invocation.attempts > 1 ? t("第{0}次", { 0: invocation.attempts }) : undefined,
            hint,
          ]
            .filter(Boolean)
            .join(t("，"));
          return (
            <div
              key={invocation.id}
              role="listitem"
              data-invocation-id={invocation.id}
              className={`invocation-chip ${invocation.status}${invocation.resolution ? " resolved" : ""}`}
              title={hint}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="invocation-summary"
                aria-label={t("{0}，查看调用详情", { 0: ariaSummary })}
                aria-haspopup="dialog"
                onClick={() => setSelectedId(invocation.id)}
              >
                {summary}
                <span className="invocation-details-affordance" aria-hidden="true">
                  {t("详情 ›")}
                </span>
              </button>
              {onLocate && canJumpTo(invocation.messageId) && (
                <button
                  type="button"
                  className="invocation-action subtle"
                  aria-label={t("{0}，定位到原消息", { 0: ariaSummary })}
                  onClick={() => onLocate(invocation.messageId)}
                >
                  {t("原消息")}
                </button>
              )}
              {jumpTarget && (
                <button
                  type="button"
                  className="invocation-action"
                  aria-label={t("{0}，跳到回复", { 0: ariaSummary })}
                  onClick={() => onJump(jumpTarget)}
                >
                  {t("查看回复")}
                </button>
              )}
              {isExtendableBlock(invocation) ? (
                <button
                  type="button"
                  className="invocation-action primary"
                  aria-label={t("为 Agent 对话追加 {0} 轮，恢复 @{1}", {
                    0: BUDGET_EXTEND_TURNS,
                    1: invocation.agentName,
                  })}
                  onClick={onExtend}
                >
                  {t("继续 {0} 轮", { 0: BUDGET_EXTEND_TURNS })}
                </button>
              ) : (
                canRetryInvocation(invocation) &&
                (invocation.blockReason !== "guest_approval" || isOwner) && (
                  <button
                    type="button"
                    className={`invocation-action ${invocation.blockReason === "guest_approval" || isUpstreamInterrupted(invocation) ? "primary" : ""}`}
                    aria-label={`${retryLabel(invocation)} @${invocation.agentName}`}
                    title={
                      isUpstreamInterrupted(invocation)
                        ? t("接着原会话从中断处继续，不会从头重做")
                        : undefined
                    }
                    onClick={() => onRetry(invocation)}
                  >
                    {retryLabel(invocation)}
                  </button>
                )
              )}
              {onRetryWithModel && isOwner && invocation.status === "failed" && (
                <button
                  type="button"
                  className="invocation-action subtle"
                  aria-label={t("换个模型重试 @{0}", { 0: invocation.agentName })}
                  title={t("选一个模型，只对这一次重试生效")}
                  onClick={() => onRetryWithModel(invocation)}
                >
                  {t("换个模型重试")}
                </button>
              )}
              {onDismiss &&
                canDismissInvocation(invocation) &&
                (invocation.blockReason !== "guest_approval" || isOwner) && (
                  <button
                    type="button"
                    className="invocation-action subtle"
                    aria-label={t("忽略 @{0} 的这次调用", { 0: invocation.agentName })}
                    title={t("标为已处理，不再算作需要处理；记录仍保留")}
                    onClick={() => onDismiss(invocation)}
                  >
                    {t("忽略")}
                  </button>
                )}
              {onSteer &&
                canSteerInvocation(
                  invocation,
                  allInvocations?.values() ?? invocations,
                  participants.find((participant) => participant.id === invocation.agentId)
                    ?.provider,
                ) && (
                  <button
                    type="button"
                    className="invocation-action primary"
                    aria-label={t("用这条引导 @{0} 正在执行的任务", { 0: invocation.agentName })}
                    title={t("不排队，让它在当前这一轮里接着处理这条")}
                    onClick={() => onSteer(invocation)}
                  >
                    {t("引导")}
                  </button>
                )}
              {onPreempt &&
                isOwner &&
                invocation.status === "queued" &&
                invocation.requesterType === "human" &&
                !invocation.resolution &&
                hasRunningTask(invocation, allInvocations?.values() ?? invocations) && (
                  <button
                    type="button"
                    className="invocation-action subtle"
                    aria-label={t("停下 @{0} 当前的任务，改做这条", { 0: invocation.agentName })}
                    title={t("先停下正在执行的任务（它会变成已停止或结果未知），停下后先做这条")}
                    onClick={() => onPreempt(invocation)}
                  >
                    {t("停下当前，改做这条")}
                  </button>
                )}
              {canCancelInvocation(invocation) && (
                <button
                  type="button"
                  className="invocation-action subtle"
                  aria-label={t("停止 @{0}", { 0: invocation.agentName })}
                  onClick={() => onCancel(invocation)}
                >
                  {t("停止")}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {selected && (
        <InvocationDetails
          invocation={selected}
          steps={traces?.get(selected.id)}
          label={invocationStatusLabel(
            selected,
            participants.some((p) => p.id === selected.agentId && p.status !== "offline"),
          )}
          agentOnline={participants.some(
            (p) => p.id === selected.agentId && p.status !== "offline",
          )}
          connectionState={connectionState}
          delegation={delegationLines(selected, allInvocations?.values() ?? invocations)}
          others={[...(allInvocations?.values() ?? invocations)]}
          onClose={() => setSelectedId(undefined)}
          {...(onOpenTerminal?.(selected) ? { onOpenTerminal: onOpenTerminal(selected)! } : {})}
          {...(selected.replyMessageId && canJumpTo(selected.replyMessageId)
            ? {
                onJump: () => {
                  setSelectedId(undefined);
                  onJump(selected.replyMessageId!);
                },
              }
            : {})}
        />
      )}
    </>
  );
}
