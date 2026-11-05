import type { Invocation } from "./index.js";

/**
 * 「为什么是这个状态」：网页的调用详情和 hive_invoke / hive_wait 共用同一套判断，
 * 只返回结构化的原因和参数，文案由各端自己出（网页要多语言，MCP 给 Agent 看中文）。
 */

/** 派出后多久还没开始算「迟迟没开始」（参考 herdr agent prompt --wait 的 5 秒活动门闩） */
export const INVOCATION_STALL_MS = 5_000;
/** 进行中多久没有新的执行事件算「安静」，和调用详情里的待核实提示一致 */
export const INVOCATION_QUIET_MS = 120_000;

export type InvocationStateReason =
  /** Agent 不在线，消息留在服务端，上线后才会收到 */
  | { code: "queued_offline" }
  /** 前面还有这个 Agent 的任务（正在做或排着） */
  | { code: "queued_behind"; ahead: number; current?: Invocation }
  /** Agent 在线、前面没有任务，但还没确认收到 */
  | { code: "queued_undelivered" }
  /** Agent 已确认收到，等它开始 */
  | { code: "queued_received" }
  /** 进行中，最近有执行事件 */
  | { code: "running_active"; quietMs: number }
  /** 进行中，但较长时间没有新的执行事件 */
  | { code: "running_quiet"; quietMs: number }
  /** 这种 Runtime 不上报执行事件，只能确认 Bridge 还在 */
  | { code: "running_heartbeat"; quietMs: number }
  /** 进行中，但 Agent 已断线 */
  | { code: "running_offline" }
  | { code: "waiting_human" }
  | { code: "blocked"; reason?: Invocation["blockReason"] }
  | { code: "cancelling"; waitedMs: number }
  | { code: "timed_out" }
  | { code: "finished" };

export type InvocationState = InvocationStateReason & {
  /** 派出后超过门闩仍没开始：委派方和人需要知道，而不是干等回执 */
  stalled: boolean;
  /** 从派出（或开始执行）到现在的毫秒数 */
  waitedMs: number;
};

const ms = (iso: string | undefined) => (iso ? Date.parse(iso) : Number.NaN);

/** 排在这条前面的同一 Agent 的任务：正在执行的，以及更早排队的 */
export function invocationsAhead(
  invocation: Invocation,
  others: Iterable<Invocation>,
): Invocation[] {
  const ahead: Invocation[] = [];
  for (const other of others) {
    if (other.id === invocation.id || other.agentId !== invocation.agentId) continue;
    const executing =
      other.status === "running" ||
      other.status === "cancelling" ||
      (other.status === "waiting_human" && !other.finishedAt);
    const queuedEarlier =
      other.status === "queued" &&
      !other.resolution &&
      (other.createdAt < invocation.createdAt ||
        (other.createdAt === invocation.createdAt && other.id < invocation.id));
    if (executing || queuedEarlier) ahead.push(other);
  }
  // 正在执行的排最前，其余按派出先后
  return ahead.sort(
    (a, b) =>
      Number(a.status === "queued") - Number(b.status === "queued") ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

export function explainInvocationState(input: {
  invocation: Invocation;
  agentOnline: boolean;
  /** 同一 Agent 的其它调用（同房间即可：Agent 一次只执行一个房间里的一轮） */
  others?: Iterable<Invocation>;
  now?: number;
}): InvocationState {
  const { invocation, agentOnline } = input;
  const now = input.now ?? Date.now();
  const since = (iso: string | undefined) => {
    const at = ms(iso);
    return Number.isFinite(at) ? Math.max(0, now - at) : 0;
  };
  const waitedMs = since(
    invocation.status === "queued"
      ? invocation.createdAt
      : (invocation.startedAt ?? invocation.createdAt),
  );
  const done = (reason: InvocationStateReason, stalled = false): InvocationState => ({
    ...reason,
    stalled,
    waitedMs,
  });

  switch (invocation.status) {
    case "queued": {
      const late = waitedMs >= INVOCATION_STALL_MS;
      if (!agentOnline) return done({ code: "queued_offline" }, late);
      const ahead = invocationsAhead(invocation, input.others ?? []);
      if (ahead.length > 0) {
        const current = ahead.find((other) => other.status !== "queued");
        return done(
          { code: "queued_behind", ahead: ahead.length, ...(current ? { current } : {}) },
          late,
        );
      }
      if (invocation.receivedAt) return done({ code: "queued_received" }, late);
      return done({ code: "queued_undelivered" }, late);
    }
    case "running": {
      if (!agentOnline) return done({ code: "running_offline" });
      const runtime = invocation.runtime;
      if (runtime?.observability === "heartbeat") {
        return done({ code: "running_heartbeat", quietMs: since(runtime.lastHeartbeatAt) });
      }
      const quietMs = since(
        runtime?.lastProgressAt ??
          runtime?.lastRuntimeEventAt ??
          invocation.startedAt ??
          invocation.createdAt,
      );
      return quietMs >= INVOCATION_QUIET_MS
        ? done({ code: "running_quiet", quietMs })
        : done({ code: "running_active", quietMs });
    }
    case "waiting_human":
      return done({ code: "waiting_human" });
    case "blocked":
      return done({
        code: "blocked",
        ...(invocation.blockReason ? { reason: invocation.blockReason } : {}),
      });
    case "cancelling":
      return done({ code: "cancelling", waitedMs: since(invocation.updatedAt) });
    case "timed_out":
      return done({ code: "timed_out" });
    default:
      return done({ code: "finished" });
  }
}

function duration(value: number): string {
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

/** 给 Agent 看的一句话（hive_invoke / hive_wait 的返回里用） */
export function formatInvocationStateForAgent(state: InvocationState, agentName: string): string {
  switch (state.code) {
    case "queued_offline":
      return `${agentName} 当前离线，子任务要等它上线才会开始（已等 ${duration(state.waitedMs)}）。急的话换个在线的 Agent，或在最终回复里告诉人。`;
    case "queued_behind":
      return `${agentName} 前面还有 ${state.ahead} 个任务${state.current ? `（正在做 ${state.current.requesterName} 派的那条）` : ""}，子任务在排队，轮到后才会开始。`;
    case "queued_undelivered":
      return state.stalled
        ? `已派出 ${duration(state.waitedMs)}，${agentName} 在线但还没确认收到，可能连接异常。`
        : `已派出，等 ${agentName} 确认收到。`;
    case "queued_received":
      return state.stalled
        ? `${agentName} 已收到，但 ${duration(state.waitedMs)} 了还没开始。`
        : `${agentName} 已收到，马上开始。`;
    case "running_active":
      return `${agentName} 正在执行，最近一次进展在 ${duration(state.quietMs)} 前。`;
    case "running_quiet":
      return `${agentName} 在执行，但已经 ${duration(state.quietMs)}没有新的进展，状态待核实（不会自动停止或重试）。`;
    case "running_heartbeat":
      return `${agentName} 在执行；这种 Runtime 不上报执行过程，只能确认 ${duration(state.quietMs)} 前还在。`;
    case "running_offline":
      return `${agentName} 执行到一半断线了，重连后会继续上报。`;
    case "waiting_human":
      return `${agentName} 在等人回答，人回复后它会继续。`;
    case "blocked":
      return state.reason === "guest_approval"
        ? "子任务在等房主批准。"
        : "子任务被预算拦下，需要人在页面上点「继续」。";
    case "cancelling":
      return `已请求停止 ${duration(state.waitedMs)}，等 ${agentName} 确认。`;
    case "timed_out":
      return "结果未知：长时间没有进展，不代表失败。";
    default:
      return "子任务已结束。";
  }
}
