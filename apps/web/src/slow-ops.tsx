import { useCallback, useEffect, useState } from "react";
import type { SlowOperation, SlowOperationsResponse } from "@superhive/protocol";
import { t } from "./i18n";
import type { LocalAgentsState } from "./local-agents";
import "./styles/slow-ops.css";

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

/**
 * 本机：Server 上最近超过阈值的慢操作（任务目录锁、git、重查询、请求）。
 * 排查「卡住」「等锁超时」时看是谁占着锁、别人等了多久；只在内存里，Server 重启后清空。
 */
export function SlowOpsGroup({ local }: { local: LocalAgentsState }) {
  const [data, setData] = useState<SlowOperationsResponse>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const { slowOps } = local;
  const load = useCallback(() => {
    setLoading(true);
    setError(undefined);
    slowOps()
      .then(setData, (reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setLoading(false));
  }, [slowOps]);
  useEffect(load, [load]);
  const now = new Date();
  return (
    <div className="settings-group">
      <div className="settings-section-heading slow-ops-heading">
        <div>
          <h4>{t("最近慢操作")}</h4>
          <p>
            {t(
              "Server 上超过阈值的任务目录锁、git 命令、重查询和请求。Agent 开工卡住、等锁超时时，可以在这里看是谁占着、等了多久。只保存在内存里，Server 重启后清空。",
            )}
          </p>
        </div>
        <button type="button" className="settings-action" disabled={loading} onClick={load}>
          {loading ? t("正在刷新…") : t("刷新")}
        </button>
      </div>
      {data && (
        <p className="settings-note">
          {t("记录阈值：操作 {0}，请求 {1}；最多保留最近 {2} 条。", {
            0: formatDuration(data.thresholdMs),
            1: formatDuration(data.requestThresholdMs),
            2: data.capacity,
          })}
        </p>
      )}
      {data &&
        (data.operations.length ? (
          <ul className="slow-ops" aria-label={t("最近慢操作")}>
            {data.operations.map((item) => (
              <li key={item.id} className={item.failed ? "failed" : undefined}>
                <span className={`slow-op-kind ${item.kind}`}>{kindLabel(item.kind)}</span>
                <span className="slow-op-main">
                  <strong title={item.name}>{item.name}</strong>
                  <small>
                    {[
                      formatTime(item.at, now),
                      item.source ? t("来自 {0}", { 0: item.source }) : undefined,
                      item.roomId ? `#${item.roomId}` : undefined,
                      item.status !== undefined ? String(item.status) : undefined,
                      item.failed ? t("出错") : undefined,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    {item.repo && (
                      <>
                        {" · "}
                        <span title={item.repo}>{repoLabel(item.repo)}</span>
                      </>
                    )}
                  </small>
                </span>
                <span className="slow-op-time">
                  <strong>{formatDuration(item.durationMs)}</strong>
                  {item.waitMs !== undefined && (
                    <small>{t("等锁 {0}", { 0: formatDuration(item.waitMs) })}</small>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="settings-note">{t("最近没有慢操作。")}</p>
        ))}
      {error && <p className="settings-note error">{error}</p>}
    </div>
  );
}
