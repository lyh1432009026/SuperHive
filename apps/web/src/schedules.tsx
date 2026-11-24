import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Invocation, Schedule } from "@superhive/protocol";
import { AppDialog } from "./app-dialog";
import { getLocale, t } from "./i18n";
import { Tooltip } from "./tooltip";
import { Button } from "./button";

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
 * 还没执行的定时任务，按执行时间从近到远。侧栏角标、弹窗 tab 上的数字和列表都用它，三处数字一致。
 * 周期任务算 1 个：到点时服务端先登记好下一次，正在发出的这一次和下一次会短暂并存，只留还能取消的那条。
 */
export function pendingSchedules(schedules: Iterable<Schedule>): Schedule[] {
  const bySeries = new Map<string, Schedule>();
  for (const schedule of schedules) {
    if (!isPendingSchedule(schedule)) continue;
    const key = schedule.seriesId ?? schedule.id;
    const kept = bySeries.get(key);
    if (!kept || (kept.status !== "scheduled" && schedule.status === "scheduled")) {
      bySeries.set(key, schedule);
    }
  }
  return [...bySeries.values()].sort((a, b) => a.runAt.localeCompare(b.runAt));
}

/**
 * 分组：「待执行」见 pendingSchedules；「已结束」按执行时间从新到旧，周期任务每一次单独一行。
 */
export function groupSchedules(schedules: Iterable<Schedule>) {
  const all = [...schedules];
  return {
    pending: pendingSchedules(all),
    history: all
      .filter((schedule) => !isPendingSchedule(schedule))
      .sort((a, b) => b.runAt.localeCompare(a.runAt)),
  };
}

const ALL_ROOMS = "";

/** 顶部房间 tab：只列有待执行任务的房间，当前房间排最前，其余按名称；数字是待执行数 */
export function scheduleRoomTabs(
  schedules: Iterable<Schedule>,
  roomName: (roomId: string) => string,
  currentRoomId: string,
): Array<{ id: string; name: string; pending: number }> {
  const byRoom = new Map<string, number>();
  for (const schedule of pendingSchedules(schedules)) {
    byRoom.set(schedule.roomId, (byRoom.get(schedule.roomId) ?? 0) + 1);
  }
  return [...byRoom]
    .map(([id, pending]) => ({ id, name: roomName(id), pending }))
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
 * 顶部一行 tab 是「全部」和每个有待执行任务的房间，主区只列待执行；已结束的收在底部，点开才看。
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
  const [now, setNow] = useState(() => Date.now());
  const rooms = useMemo(
    () => scheduleRoomTabs(schedules.values(), roomName, currentRoomId),
    [currentRoomId, roomName, schedules],
  );
  // 打开时：当前房间有待执行的就选它，没有就选「全部」
  const [roomTab, setRoomTab] = useState(() =>
    rooms.some((room) => room.id === currentRoomId) ? currentRoomId : ALL_ROOMS,
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());
  const idPrefix = useId();
  const tablistRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // 选中的房间没有待执行的了（刚取消、刚执行）就回到全部
  const selected = rooms.some((room) => room.id === roomTab) ? roomTab : ALL_ROOMS;
  const { pending: allPending, history: allHistory } = useMemo(
    () => groupSchedules(schedules.values()),
    [schedules],
  );
  const inTab = (schedule: Schedule) => selected === ALL_ROOMS || schedule.roomId === selected;
  const pending = allPending.filter(inTab);
  const history = allHistory.filter(inTab);
  const tabs = [
    { id: ALL_ROOMS, label: t("全部"), title: undefined, count: allPending.length },
    ...rooms.map((room) => ({
      id: room.id,
      label: `# ${room.name}`,
      title: room.name,
      count: room.pending,
    })),
  ];
  const tabId = (index: number) => `${idPrefix}-tab-${index}`;
  const panelId = `${idPrefix}-panel`;
  const historyId = `${idPrefix}-history`;
  const selectedIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === selected),
  );

  function selectTab(index: number) {
    const tab = tabs[index];
    if (!tab) return;
    setRoomTab(tab.id);
    const button = tablistRef.current?.ownerDocument.getElementById(tabId(index));
    button?.focus();
    button?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

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

  const renderRow = (schedule: Schedule) => (
    <ScheduleRow
      key={schedule.id}
      schedule={schedule}
      invocation={schedule.invocationId ? invocations.get(schedule.invocationId) : undefined}
      isAgentOnline={isAgentOnline}
      roomName={roomName(schedule.roomId)}
      currentRoom={schedule.roomId === currentRoomId}
      now={now}
      cancelling={cancelling.has(schedule.id)}
      onCancel={() => void cancel(schedule)}
      onJump={(messageId) => onJump(schedule.roomId, messageId)}
      onOpenRoom={() => onOpenRoom(schedule.roomId)}
    />
  );

  return (
    <AppDialog
      size="lg"
      className="schedules-dialog"
      title={t("定时任务")}
      toolbar={
        schedules.size > 0 && (
          <div
            ref={tablistRef}
            className="schedule-tabs"
            role="tablist"
            aria-label={t("按房间查看待执行的定时任务")}
            onKeyDown={(event) => {
              const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
              if (event.key === "Home") selectTab(0);
              else if (event.key === "End") selectTab(tabs.length - 1);
              else if (step) selectTab((selectedIndex + step + tabs.length) % tabs.length);
              else return;
              event.preventDefault();
            }}
          >
            {tabs.map((tab, index) => (
              <Tooltip key={tab.id || "all"} content={tab.title}>
                <button
                  type="button"
                  role="tab"
                  id={tabId(index)}
                  aria-selected={index === selectedIndex}
                  aria-controls={panelId}
                  aria-label={t("{0}，{1} 个待执行", { 0: tab.label, 1: tab.count })}
                  tabIndex={index === selectedIndex ? 0 : -1}
                  onClick={() => setRoomTab(tab.id)}
                >
                  <span className="schedule-tab-name">{tab.label}</span>
                  <span className="schedule-tab-count" aria-hidden="true">
                    {tab.count}
                  </span>
                </button>
              </Tooltip>
            ))}
          </div>
        )
      }
      bodyClassName="schedules-dialog-body"
      onClose={onClose}
    >
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
        <div
          className="whiteboard schedules"
          id={panelId}
          role="tabpanel"
          aria-labelledby={tabId(selectedIndex)}
        >
          {pending.length > 0 ? (
            <ul className="schedule-list" aria-label={t("待执行")}>
              {pending.map(renderRow)}
            </ul>
          ) : (
            <div className="whiteboard-empty schedules-empty">
              <strong>{t("没有待执行的定时任务")}</strong>
              <p>{t("Agent 登记了「到点做某件事」就会列在这里；已执行、取消或错过的收在下面。")}</p>
            </div>
          )}
          {history.length > 0 && (
            <section className="schedules-history">
              <Button
                variant="ghost"
                size="sm"
                className="schedules-history-toggle"
                aria-expanded={historyOpen}
                aria-controls={historyId}
                onClick={() => setHistoryOpen((open) => !open)}
              >
                {t("已结束 {0} 条", { 0: history.length })}
                <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </Button>
              <ul
                id={historyId}
                className="schedule-list"
                aria-label={t("已结束")}
                hidden={!historyOpen}
              >
                {historyOpen && history.map(renderRow)}
              </ul>
            </section>
          )}
        </div>
      )}
    </AppDialog>
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
          <Button size="sm" onClick={() => onJump(resultId)}>
            {invocation?.replyMessageId ? t("查看结果") : t("查看消息")}
          </Button>
        )}
        {schedule.status === "scheduled" && (
          <Tooltip
            content={schedule.everyMinutes ? t("取消后整个周期结束，后面的不再执行") : undefined}
          >
            <Button
              size="sm"
              tone="danger"
              loading={cancelling}
              aria-label={t("取消定时任务：{0}", { 0: schedule.task })}
              onClick={onCancel}
            >
              {schedule.everyMinutes ? t("结束周期") : t("取消")}
            </Button>
          </Tooltip>
        )}
      </p>
    </li>
  );
}
