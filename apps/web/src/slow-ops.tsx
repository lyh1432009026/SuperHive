import { useCallback, useMemo, useState } from "react";
import type { SlowOperation, SlowOperationsResponse } from "@superhive/protocol";
import { t } from "./i18n";
import "./styles/slow-ops.css";

/** 同名操作在这么长时间内连着出现，列表里合成一行 */
export const SLOW_OPS_MERGE_WINDOW_MS = 60_000;

/** 毫秒数给人看：不到 1 秒按毫秒，否则按秒保留一位 */
export function formatDuration(ms: number): string {
  return ms < 1000
    ? t("{0} 毫秒", { 0: Math.round(ms) })
    : t("{0} 秒", { 0: ms < 10_000 ? Number((ms / 1000).toFixed(1)) : Math.round(ms / 1000) });
}

function kindLabel(kind: SlowOperation["kind"]): string {
  switch (kind) {
    case "lock":
      return t("锁");
    case "git":
      return "git";
    case "request":
      return t("请求");
    default:
      return t("操作");
  }
}

/** 发生时间：今天的只显示时分秒，更早的带上日期 */
function formatTime(iso: string, now: Date): string {
  const at = new Date(iso);
  return at.toDateString() === now.toDateString()
    ? at.toLocaleTimeString()
    : at.toLocaleString(undefined, {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
}

/** 仓库只显示最后一级目录名，悬停看全路径 */
function repoLabel(repo: string): string {
  return repo.split(/[\\/]/).filter(Boolean).at(-1) ?? repo;
}

const totalMs = (item: SlowOperation) => item.durationMs + (item.waitMs ?? 0);
const keyOf = (item: SlowOperation) => `${item.kind} ${item.name}`;

export type SlowOpGroup = {
  key: string;
  /** 最近的一次：时间、来源、仓库按它显示 */
  latest: SlowOperation;
  /** 最慢的一次：耗时按它显示 */
  slowest: SlowOperation;
  count: number;
  /** 最早一次的时间，判断是否已读用 */
  oldestAt: string;
};

/**
 * 同类同名、前后相隔不超过 windowMs 的慢操作合成一组（例如一次排队里连着十几个 git status）。
 * operations 是新的在前，返回的组也是新的在前。
 */
export function groupSlowOps(
  operations: readonly SlowOperation[],
  windowMs = SLOW_OPS_MERGE_WINDOW_MS,
): SlowOpGroup[] {
  const groups: SlowOpGroup[] = [];
  const open = new Map<string, SlowOpGroup>();
  for (const item of operations) {
    const key = keyOf(item);
    const group = open.get(key);
    if (group && Date.parse(group.oldestAt) - Date.parse(item.at) <= windowMs) {
      group.count++;
      group.oldestAt = item.at;
      if (totalMs(item) > totalMs(group.slowest)) group.slowest = item;
      continue;
    }
    const created = { key, latest: item, slowest: item, count: 1, oldestAt: item.at };
    groups.push(created);
    open.set(key, created);
  }
  return groups;
}

export type SlowOpsState = {
  /** 收到过全集才算可用：只有这台电脑上的房主页面会收到 */
  enabled: boolean;
  operations: SlowOperation[];
  settings: Omit<SlowOperationsResponse, "operations"> | undefined;
  /** WebSocket 连上（含重连）时的全集 */
  receiveSnapshot(snapshot: SlowOperationsResponse): void;
  /** WebSocket 推来的新一条 */
  receive(operation: SlowOperation): void;
};

function newestFirst(items: Iterable<SlowOperation>, capacity: number): SlowOperation[] {
  const byId = new Map<string, SlowOperation>();
  for (const item of items) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, capacity);
}

/**
 * 本机房主页面上的慢操作，全靠 WebSocket：连上时服务端给一份全集（receiveSnapshot），
 * 之后逐条推（receive），不轮询。只在左侧「故障 → 慢操作」给排查问题的人看，入口不为它标数字：
 * 多个 Agent 同时跑测试、装依赖时慢操作一多就是上百条，标数字或弹提示只会被当成噪音。
 */
export function useSlowOps(): SlowOpsState {
  const [operations, setOperations] = useState<SlowOperation[]>([]);
  const [settings, setSettings] = useState<SlowOpsState["settings"]>();
  const capacity = settings?.capacity ?? 200;

  const receiveSnapshot = useCallback(
    ({ operations: snapshot, ...rest }: SlowOperationsResponse) => {
      setSettings(rest);
      // 同一条连接上全集先于逐条推送到达，直接替换即可；Server 重启后全集变短也以它为准
      setOperations(newestFirst(snapshot, rest.capacity));
    },
    [],
  );

  const receive = useCallback(
    (operation: SlowOperation) =>
      setOperations((current) => newestFirst([operation, ...current], capacity)),
    [capacity],
  );

  return { enabled: settings !== undefined, operations, settings, receiveSnapshot, receive };
}

/** 慢操作列表：同名的合成一行，耗时按最慢的一次，其余按最近的一次 */
export function SlowOpsList({
  operations,
  label,
}: {
  operations: readonly SlowOperation[];
  label: string;
}) {
  const groups = useMemo(() => groupSlowOps(operations), [operations]);
  const now = new Date();
  return (
    <ul className="slow-ops" aria-label={label}>
      {groups.map(({ key, latest, slowest, count }) => {
        const failed = latest.failed || slowest.failed;
        return (
          <li key={`${key} ${latest.id}`} className={failed ? "failed" : undefined}>
            <span className={`slow-op-kind ${latest.kind}`}>{kindLabel(latest.kind)}</span>
            <span className="slow-op-main">
              <span className="slow-op-name">
                <strong title={latest.name}>{latest.name}</strong>
                {count > 1 && (
                  <span
                    className="slow-op-count"
                    title={t("1 分钟内连着出现了 {0} 次", { 0: count })}
                  >
                    ×{count}
                  </span>
                )}
              </span>
              <small>
                {[
                  formatTime(latest.at, now),
                  latest.source ? t("来自 {0}", { 0: latest.source }) : undefined,
                  latest.roomId ? `#${latest.roomId}` : undefined,
                  latest.status !== undefined ? String(latest.status) : undefined,
                  failed ? t("出错") : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                {latest.repo && (
                  <>
                    {" · "}
                    <span title={latest.repo}>{repoLabel(latest.repo)}</span>
                  </>
                )}
              </small>
            </span>
            <span className="slow-op-time">
              <strong>
                {count > 1
                  ? t("最长 {0}", { 0: formatDuration(slowest.durationMs) })
                  : formatDuration(slowest.durationMs)}
              </strong>
              {slowest.waitMs !== undefined && (
                <small>{t("等锁 {0}", { 0: formatDuration(slowest.waitMs) })}</small>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function thresholdNote(settings: NonNullable<SlowOpsState["settings"]>): string {
  return t("记录超过 {0}（请求 {1}）的操作，只保存在 Server 内存里，最多 {2} 条，重启后清空。", {
    0: formatDuration(settings.thresholdMs),
    1: formatDuration(settings.requestThresholdMs),
    2: settings.capacity,
  });
}
