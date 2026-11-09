import { useEffect, useState } from "react";
import type { Invocation, Schedule } from "@superhive/protocol";
import { getLocale, t } from "./i18n";

export function upsertSchedule(
  current: ReadonlyMap<string, Schedule>,
  schedule: Schedule,
): Map<string, Schedule> {
  const existing = current.get(schedule.id);
  if (existing && existing.updatedAt > schedule.updatedAt) return current as Map<string, Schedule>;
  const next = new Map(current);
  next.set(schedule.id, schedule);
  return next;
}

/** 还没发出、仍可取消（或正在发出）的定时任务 */
export function isPendingSchedule(schedule: Schedule): boolean {
  return schedule.status === "scheduled" || schedule.status === "firing";
}

export type ScheduleTone = "pending" | "active" | "attention" | "done" | "muted";

/**
 * 面向人的状态：发出以后以触发的调用为准（排队、执行中、等人处理、结果未知……），
 * 不把「这一轮跑完了」当成「任务成功了」——没有回复单独标出来。
 */
export function scheduleState(
  schedule: Schedule,
  invocation: Invocation | undefined,
  agentOnline: boolean,
): { label: string; tone: ScheduleTone } {
  switch (schedule.status) {
    case "scheduled":
      return { label: t("待执行"), tone: "pending" };
    case "firing":
      return { label: t("正在发出"), tone: "active" };
    case "missed":
      return { label: t("已错过"), tone: "attention" };
    case "cancelled":
      return { label: t("已取消"), tone: "muted" };
    case "failed":
      return { label: t("没能发出"), tone: "attention" };
    case "fired":
      break;
  }
  if (!invocation) return { label: t("已发出"), tone: "muted" };
  switch (invocation.status) {
    case "queued":
      return agentOnline
        ? { label: t("排队中"), tone: "active" }
        : { label: t("等待 Agent 上线"), tone: "pending" };
    case "running":
    case "cancelling":
      return { label: t("执行中"), tone: "active" };
    case "waiting_human":
      return { label: t("等人处理"), tone: "attention" };
    case "blocked":
      return { label: t("等待批准"), tone: "attention" };
    case "completed":
      return invocation.replyMessageId
        ? { label: t("已完成"), tone: "done" }
        : { label: t("没有回复"), tone: "attention" };
    case "failed":
      return { label: t("失败"), tone: "attention" };
    case "timed_out":
      return { label: t("结果未知"), tone: "attention" };
    case "cancelled":
      return { label: t("已停止"), tone: "muted" };
  }
}

/** 绝对时间加时区（按任务登记的时区显示），例如「11月4日 00:07 · Asia/Shanghai」 */
export function formatScheduleTime(schedule: Schedule): string {
  let text: string;
  try {
    text = new Date(schedule.runAt).toLocaleString(getLocale(), {
      timeZone: schedule.timeZone,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    text = new Date(schedule.runAt).toLocaleString(getLocale());
  }
  return `${text} · ${schedule.timeZone}`;
}

/** 周期任务：「每 5 分钟 · 第 3 次 · 到 11月10日 20:00」；一次性的返回 undefined */
export function formatRepeat(schedule: Schedule): string | undefined {
  if (!schedule.everyMinutes || !schedule.until) return undefined;
  const every =
    schedule.everyMinutes % 60 === 0
      ? t("每 {0} 小时", { 0: schedule.everyMinutes / 60 })
      : t("每 {0} 分钟", { 0: schedule.everyMinutes });
  const until = formatScheduleTime({ ...schedule, runAt: schedule.until }).split(" · ")[0];
  return t("{0} · 第 {1} 次 · 到 {2}", { 0: every, 1: schedule.occurrence ?? 1, 2: until });
}

export function formatCountdown(iso: string, now: number): string {
  const minutes = Math.round((new Date(iso).getTime() - now) / 60_000);
  if (minutes <= 0) return t("即将执行");
  if (minutes < 60) return t("{0} 分钟后", { 0: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return minutes % 60
      ? t("{0} 小时 {1} 分钟后", { 0: hours, 1: minutes % 60 })
      : t("{0} 小时后", { 0: hours });
  }
  return t("{0} 天后", { 0: Math.round(hours / 24) });
}

export function SchedulePanel({
  schedules,
  invocations,
  onlineAgents,
  onCancel,
  onJump,
}: {
  schedules: ReadonlyMap<string, Schedule>;
  invocations: ReadonlyMap<string, Invocation>;
  onlineAgents: ReadonlySet<string>;
  onCancel: (schedule: Schedule) => void;
  onJump: (messageId: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (schedules.size === 0) {
    return (
      <div className="whiteboard-empty">
        <strong>{t("还没有定时任务")}</strong>
        <p>
          {t("让 Agent 「到点做某件事」时，它会用")} <code>hive_schedule_create</code>{" "}
          {t("登记在这里：到点后服务端发消息唤醒它，关掉网页、重启 Server 都不影响。")}
        </p>
      </div>
    );
  }

  const all = [...schedules.values()];
  const pending = all.filter(isPendingSchedule).sort((a, b) => a.runAt.localeCompare(b.runAt));
  const history = all
    .filter((schedule) => !isPendingSchedule(schedule))
    .sort((a, b) => b.runAt.localeCompare(a.runAt));
  const groups = [
    { key: "pending", label: t("待执行"), items: pending },
    { key: "history", label: t("已发出与结束"), items: history },
  ].filter((group) => group.items.length > 0);

  return (
    <div className="whiteboard schedules">
      {groups.map((group) => (
        <section
          key={group.key}
          className="whiteboard-slot"
          aria-labelledby={`schedule-group-${group.key}`}
        >
          <h3 id={`schedule-group-${group.key}`}>
            {group.label}
            <span className="whiteboard-slot-count">{group.items.length}</span>
          </h3>
          <ul>
            {group.items.map((schedule) => {
              const invocation = schedule.invocationId
                ? invocations.get(schedule.invocationId)
                : undefined;
              const state = scheduleState(
                schedule,
                invocation,
                onlineAgents.has(schedule.agentName.toLocaleLowerCase()),
              );
              const resultId = invocation?.replyMessageId ?? schedule.triggerMessageId;
              return (
                <li key={schedule.id} className="whiteboard-entry schedule-entry">
                  <p className="schedule-when">
                    <time dateTime={schedule.runAt} title={new Date(schedule.runAt).toString()}>
                      {formatScheduleTime(schedule)}
                    </time>
                    <span className={`schedule-state ${state.tone}`}>{state.label}</span>
                  </p>
                  {formatRepeat(schedule) && (
                    <p className="schedule-repeat">{formatRepeat(schedule)}</p>
                  )}
                  <p className="whiteboard-summary schedule-task">{schedule.task}</p>
                  {(schedule.detail || (invocation?.detail && state.tone === "attention")) && (
                    <p className="whiteboard-unblocks">{schedule.detail ?? invocation?.detail}</p>
                  )}
                  <p className="whiteboard-meta">
                    <span>
                      {t("{0} 执行 · {1} 发起", {
                        0: schedule.agentName,
                        1: schedule.requesterName,
                      })}
                    </span>
                    {schedule.status === "scheduled" && (
                      <span>{formatCountdown(schedule.runAt, now)}</span>
                    )}
                  </p>
                  <p className="schedule-actions">
                    {resultId && (
                      <button type="button" onClick={() => onJump(resultId)}>
                        {invocation?.replyMessageId ? t("查看结果") : t("查看消息")}
                      </button>
                    )}
                    {schedule.status === "scheduled" && (
                      <button
                        type="button"
                        className="danger"
                        aria-label={t("取消定时任务：{0}", { 0: schedule.task })}
                        title={
                          schedule.everyMinutes
                            ? t("取消后整个周期结束，后面的不再执行")
                            : undefined
                        }
                        onClick={() => onCancel(schedule)}
                      >
                        {schedule.everyMinutes ? t("结束周期") : t("取消")}
                      </button>
                    )}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
