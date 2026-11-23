import { useCallback, useMemo, useRef, useState } from "react";
import type { Invocation, MetaResponse, Schedule } from "@superhive/protocol";
import { localizeServerPayload } from "./server-text";
import { t } from "./i18n";
import { isPendingSchedule, scheduleNeedsAttention, upsertSchedule } from "./schedules";

/** 上次打开「定时任务」面板的时间：之后才失败、错过的才在入口上醒目提示 */
export const schedulesSeenKey = "superhive.schedules-seen-at";

function readSeenAt(): string {
  try {
    return localStorage.getItem(schedulesSeenKey) ?? "";
  } catch {
    return "";
  }
}

/** 两个时间里较晚的那个（ISO 字符串可以直接比较） */
function later(a: string, b: string | undefined): string {
  return b && b > a ? b : a;
}

/**
 * 左侧「定时任务」面板的数据：请求者能看到的所有房间的定时任务，以及已发出的那些触发的调用。
 * 打开页面、重连时整体拉一次；之后靠全局推送的 schedule.updated / invocation.updated 增量合并。
 */
export function useSchedules({
  base,
  meta,
  authToken,
  username,
}: {
  base: string;
  meta: MetaResponse | undefined;
  authToken: string | undefined;
  username: string;
}) {
  const [schedules, setSchedules] = useState<ReadonlyMap<string, Schedule>>(new Map());
  const [invocations, setInvocations] = useState<ReadonlyMap<string, Invocation>>(new Map());
  const [onlineInvocationIds, setOnlineInvocationIds] = useState<ReadonlySet<string>>(new Set());
  const [seenAt, setSeenAt] = useState(readSeenAt);
  const schedulesRef = useRef(schedules);
  schedulesRef.current = schedules;
  const invocationsRef = useRef(invocations);
  invocationsRef.current = invocations;
  const refreshTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!meta || !authToken) return;
    const response = await fetch(`${base}/api/schedules`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!response.ok) throw new Error(t("请求失败 ({0})", { 0: response.status }));
    const payload = localizeServerPayload(
      (await response.json()) as {
        schedules: Schedule[];
        invocations?: Invocation[];
        onlineInvocationIds?: string[];
      },
    );
    setSchedules(new Map(payload.schedules.map((schedule) => [schedule.id, schedule])));
    setInvocations(
      new Map((payload.invocations ?? []).map((invocation) => [invocation.id, invocation])),
    );
    setOnlineInvocationIds(new Set(payload.onlineInvocationIds ?? []));
  }, [authToken, base, meta]);

  const refreshSoon = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void refresh().catch(() => undefined), 1_000);
  }, [refresh]);

  /** 推送来的定时任务：直接合并；新挂上的调用本地还没有就稍后整体拉一次 */
  const onSchedule = useCallback(
    (schedule: Schedule) => {
      setSchedules((current) => upsertSchedule(current, schedule));
      if (schedule.invocationId && !invocationsRef.current.has(schedule.invocationId)) {
        refreshSoon();
      }
    },
    [refreshSoon],
  );

  /** 推送来的调用：只留定时任务触发的那些 */
  const onInvocation = useCallback((invocation: Invocation) => {
    const linked = [...schedulesRef.current.values()].some(
      (schedule) => schedule.invocationId === invocation.id,
    );
    setInvocations((current) => {
      if (!linked && !current.has(invocation.id)) return current;
      const existing = current.get(invocation.id);
      if (existing && existing.updatedAt > invocation.updatedAt) return current;
      const next = new Map(current);
      next.set(invocation.id, invocation);
      return next;
    });
  }, []);

  /** 在面板里取消：跨房间走 HTTP，结果随 schedule.updated 推回来，这里也先合并一次 */
  const cancel = useCallback(
    async (schedule: Schedule) => {
      if (!authToken) throw new Error(t("尚未连接 Hive Server。"));
      const response = await fetch(
        `${base}/api/schedules/${encodeURIComponent(schedule.id)}/cancel`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(username ? { by: username } : {}),
        },
      );
      const payload = localizeServerPayload(
        (await response.json().catch(() => ({}))) as { schedule?: Schedule; error?: string },
      );
      if (!response.ok || !payload.schedule) {
        throw new Error(payload.error ?? t("请求失败 ({0})", { 0: response.status }));
      }
      setSchedules((current) => upsertSchedule(current, payload.schedule!));
    },
    [authToken, base, username],
  );

  /** 打开面板：之前的失败、错过算看过了，入口上不再醒目提示 */
  const markSeen = useCallback(() => {
    const at = new Date().toISOString();
    setSeenAt(at);
    try {
      localStorage.setItem(schedulesSeenKey, at);
    } catch {
      // 存不下就只在本页生效
    }
  }, []);

  const relocalize = useCallback(() => {
    const again = <T>(map: ReadonlyMap<string, T>) =>
      new Map([...map].map(([id, value]) => [id, localizeServerPayload(value)]));
    setSchedules(again);
    setInvocations(again);
  }, []);

  const counts = useMemo(() => {
    let pending = 0;
    let attention = 0;
    for (const schedule of schedules.values()) {
      if (isPendingSchedule(schedule)) {
        pending += 1;
        continue;
      }
      const invocation = schedule.invocationId ? invocations.get(schedule.invocationId) : undefined;
      if (!scheduleNeedsAttention(schedule, invocation)) continue;
      if (later(schedule.updatedAt, invocation?.updatedAt) > seenAt) attention += 1;
    }
    return { pending, attention };
  }, [invocations, schedules, seenAt]);

  return {
    schedules,
    invocations,
    onlineInvocationIds,
    counts,
    refresh,
    onSchedule,
    onInvocation,
    cancel,
    markSeen,
    relocalize,
  };
}
