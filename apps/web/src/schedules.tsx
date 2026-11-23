import { useEffect, useMemo, useRef, useState } from "react";
import type { Invocation, Schedule } from "@superhive/protocol";
import { getLocale, t } from "./i18n";
import { Select, type SelectOption } from "./select";
import { Tooltip } from "./tooltip";

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

/** 已结束、但结果要人看一眼的：没能发出、已错过、失败、没有回复、等人处理…… */
export function scheduleNeedsAttention(
  schedule: Schedule,
  invocation: Invocation | undefined,
): boolean {
  return (
    !isPendingSchedule(schedule) && scheduleState(schedule, invocation, true).tone === "attention"
  );
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

/**
 * 分组：「待执行」按执行时间从近到远，「最近结束」按执行时间从新到旧；
 * 每组都是「下次（或那次）执行时间」排序，周期任务每一次单独一行。
 */
export function groupSchedules(schedules: Iterable<Schedule>) {
  const all = [...schedules];
  return {
    pending: all.filter(isPendingSchedule).sort((a, b) => a.runAt.localeCompare(b.runAt)),
    history: all
      .filter((schedule) => !isPendingSchedule(schedule))
      .sort((a, b) => b.runAt.localeCompare(a.runAt)),
  };
}

const ALL_ROOMS = "";

/** 房间筛选的选项：有定时任务的房间，当前房间排最前，其余按名称；每项带待执行数 */
export function scheduleRoomOptions(
  schedules: Iterable<Schedule>,
  roomName: (roomId: string) => string,
  currentRoomId: string,
): Array<{ id: string; name: string; total: number; pending: number }> {
  const byRoom = new Map<string, { total: number; pending: number }>();
  for (const schedule of schedules) {
    const entry = byRoom.get(schedule.roomId) ?? { total: 0, pending: 0 };
    entry.total += 1;
    if (isPendingSchedule(schedule)) entry.pending += 1;
    byRoom.set(schedule.roomId, entry);
  }
  return [...byRoom]
    .map(([id, counts]) => ({ id, name: roomName(id), ...counts }))
    .sort((a, b) =>
      a.id === currentRoomId
        ? -1
        : b.id === currentRoomId
          ? 1
          : a.name.localeCompare(b.name, getLocale()),
    );
}

/**
 * 左侧「定时任务」入口打开的面板，和「Agent 任务」「故障」同款：
 * 所有能看到的房间的定时任务放在一起，每条写明所属房间，可以按房间筛选。
 */
export function SchedulesDialog({
  schedules,
  invocations,
  isAgentOnline,
  roomName,
  currentRoomId,
  onCancel,
  onJump,
  onOpenRoom,
  onClose,
}: {
  schedules: ReadonlyMap<string, Schedule>;
  invocations: ReadonlyMap<string, Invocation>;
  isAgentOnline: (schedule: Schedule, invocation: Invocation | undefined) => boolean;
  roomName: (roomId: string) => string;
  currentRoomId: string;
  onCancel: (schedule: Schedule) => Promise<void>;
  /** 跳到某个房间里的消息（触发消息或执行结果） */
  onJump: (roomId: string, messageId: string) => void;
  onOpenRoom: (roomId: string) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [roomFilter, setRoomFilter] = useState(ALL_ROOMS);
  const [error, setError] = useState<string>();
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    panelRef.current?.focus();
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const rooms = useMemo(
    () => scheduleRoomOptions(schedules.values(), roomName, currentRoomId),
    [currentRoomId, roomName, schedules],
  );
  // 筛选的房间没有定时任务了（比如刚被清理）就回到全部
  const filter = rooms.some((room) => room.id === roomFilter) ? roomFilter : ALL_ROOMS;
  const visible = useMemo(
    () =>
      [...schedules.values()].filter(
        (schedule) => filter === ALL_ROOMS || schedule.roomId === filter,
      ),
    [filter, schedules],
  );
  const { pending, history } = groupSchedules(visible);
  const groups = [
    { key: "pending", label: t("待执行"), items: pending },
    { key: "history", label: t("最近结束"), items: history },
  ].filter((group) => group.items.length > 0);
  const filterOptions: SelectOption[] = [
    { value: ALL_ROOMS, label: t("全部房间（{0}）", { 0: schedules.size }) },
    ...rooms.map((room) => ({
      value: room.id,
      label: `# ${room.name}`,
      description: room.pending
        ? t("{0} 个待执行 · 共 {1} 个", { 0: room.pending, 1: room.total })
        : t("共 {0} 个", { 0: room.total }),
    })),
  ];

  async function cancel(schedule: Schedule) {
    setError(undefined);
    setCancelling((current) => new Set(current).add(schedule.id));
    try {
      await onCancel(schedule);
    } catch (reason) {
      setError(
        t("无法取消定时任务：{0}", {
          0: reason instanceof Error ? reason.message : String(reason),
        }),
      );
    } finally {
      setCancelling((current) => {
        const next = new Set(current);
        next.delete(schedule.id);
        return next;
      });
    }
  }

  return (
    <div className="activity-layer">
      <button type="button" className="activity-scrim" aria-label={t("关闭")} onClick={onClose} />
      <div
        ref={panelRef}
        className="activity-panel schedules-dialog"
        role="dialog"
        aria-label={t("定时任务")}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          onClose();
        }}
      >
        <header className="activity-header">
          <h2>{t("定时任务")}</h2>
          {rooms.length > 1 && (
            <Select
              className="schedules-room-filter"
              aria-label={t("按房间筛选")}
              value={filter}
              options={filterOptions}
              onChange={setRoomFilter}
              menuMinWidth={220}
            />
          )}
          <button type="button" className="activity-close" aria-label={t("关闭")} onClick={onClose}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </header>
        <div className="activity-body schedules-dialog-body">
          {error && (
            <p className="settings-note error" role="alert">
              {error}
            </p>
          )}
          {schedules.size === 0 ? (
            <div className="whiteboard-empty">
              <strong>{t("还没有定时任务")}</strong>
              <p>
                {t("让 Agent 「到点做某件事」时，它会用")} <code>hive_schedule_create</code>{" "}
                {t("登记在这里：到点后服务端发消息唤醒它，关掉网页、重启 Server 都不影响。")}
              </p>
            </div>
          ) : (
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
                    {group.items.map((schedule) => (
                      <ScheduleRow
                        key={schedule.id}
                        schedule={schedule}
                        invocation={
                          schedule.invocationId ? invocations.get(schedule.invocationId) : undefined
                        }
                        isAgentOnline={isAgentOnline}
                        roomName={roomName(schedule.roomId)}
                        currentRoom={schedule.roomId === currentRoomId}
                        now={now}
                        cancelling={cancelling.has(schedule.id)}
                        onCancel={() => void cancel(schedule)}
                        onJump={(messageId) => onJump(schedule.roomId, messageId)}
                        onOpenRoom={() => onOpenRoom(schedule.roomId)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ScheduleRow({
  schedule,
  invocation,
  isAgentOnline,
  roomName,
  currentRoom,
  now,
  cancelling,
  onCancel,
  onJump,
  onOpenRoom,
}: {
  schedule: Schedule;
  invocation: Invocation | undefined;
  isAgentOnline: (schedule: Schedule, invocation: Invocation | undefined) => boolean;
  roomName: string;
  currentRoom: boolean;
  now: number;
  cancelling: boolean;
  onCancel: () => void;
  onJump: (messageId: string) => void;
  onOpenRoom: () => void;
}) {
  const state = scheduleState(schedule, invocation, isAgentOnline(schedule, invocation));
  const resultId = invocation?.replyMessageId ?? schedule.triggerMessageId;
  const repeat = formatRepeat(schedule);
  return (
    <li className="whiteboard-entry schedule-entry" data-schedule-id={schedule.id}>
      <p className="schedule-when">
        <time
          dateTime={schedule.runAt}
          title={new Date(schedule.runAt).toLocaleString(getLocale())}
        >
          {formatScheduleTime(schedule)}
        </time>
        <span className={`schedule-state ${state.tone}`}>{state.label}</span>
      </p>
      {repeat && <p className="schedule-repeat">{repeat}</p>}
      <p className="whiteboard-summary schedule-task">{schedule.task}</p>
      {(schedule.detail || (invocation?.detail && state.tone === "attention")) && (
        <p className="whiteboard-unblocks">{schedule.detail ?? invocation?.detail}</p>
      )}
      <p className="whiteboard-meta">
        <Tooltip content={currentRoom ? t("当前房间") : t("去这个房间")}>
          <button
            type="button"
            className="schedule-room"
            aria-label={t("打开房间 {0}", { 0: roomName })}
            aria-current={currentRoom ? "page" : undefined}
            onClick={onOpenRoom}
          >
            # {roomName}
          </button>
        </Tooltip>
        <span>
          {t("{0} 执行 · {1} 发起", {
            0: schedule.agentName,
            1: schedule.requesterName,
          })}
        </span>
        {schedule.status === "scheduled" && <span>{formatCountdown(schedule.runAt, now)}</span>}
      </p>
      <p className="schedule-actions">
        {resultId && (
          <button type="button" onClick={() => onJump(resultId)}>
            {invocation?.replyMessageId ? t("查看结果") : t("查看消息")}
          </button>
        )}
        {schedule.status === "scheduled" && (
          <Tooltip
            content={schedule.everyMinutes ? t("取消后整个周期结束，后面的不再执行") : undefined}
          >
            <button
              type="button"
              className="danger"
              disabled={cancelling}
              aria-label={t("取消定时任务：{0}", { 0: schedule.task })}
              onClick={onCancel}
            >
              {schedule.everyMinutes ? t("结束周期") : t("取消")}
            </button>
          </Tooltip>
        )}
      </p>
    </li>
  );
}
