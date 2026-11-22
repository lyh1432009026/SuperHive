import { useEffect, useRef, useState } from "react";
import {
  IncidentDispatchSettings,
  IncidentsPanel,
  type IncidentsState,
  type RoomAgent,
} from "./incidents-panel";
import { SlowOpsList, thresholdNote, type SlowOpsState } from "./slow-ops";
import { t } from "./i18n";

export type IncidentsTab = "incidents" | "slow-ops";

/**
 * 左侧「故障」入口弹出的面板，和「Agent 任务」同款：
 * 「故障单」看我们自己的问题、规则提议和经验库，手动派修或关闭；「慢操作」排查卡顿。
 * 自动派修怎么派在「故障单」顶部点「派修设置」展开，不进偏好设置。
 */
export function IncidentsDialog({
  tab,
  focusId,
  incidents,
  slowOps,
  rooms,
  currentRoomId,
  username,
  loadAgents,
  onTab,
  onClose,
}: {
  tab: IncidentsTab;
  /** 从「需要你处理」点进来的故障单或规则提议 */
  focusId?: string;
  incidents: IncidentsState;
  slowOps: SlowOpsState;
  /** 派修设置里选在哪个房间派活、派给谁；派活消息以 username（房主）的名义发出 */
  rooms: ReadonlyArray<{ id: string; name: string }>;
  currentRoomId: string;
  username: string;
  loadAgents: (roomId: string) => Promise<RoomAgent[]>;
  onTab: (tab: IncidentsTab) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { data, error, refresh } = incidents;
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    panelRef.current?.focus();
    // 打开时拉一次最新的，不只靠推送
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!focusId || tab !== "incidents") return;
    const row = bodyRef.current?.querySelector<HTMLElement>(
      `[data-incident-id="${CSS.escape(focusId)}"]`,
    );
    row?.scrollIntoView?.({ block: "center" });
  }, [focusId, tab, data]);

  const slowCount = slowOps.operations.length;
  const tabs: Array<{ id: IncidentsTab; label: string; count?: number }> = [
    { id: "incidents", label: t("故障单"), count: incidents.unhandled || undefined },
    { id: "slow-ops", label: t("慢操作") },
  ];

  return (
    <div className="activity-layer">
      <button type="button" className="activity-scrim" aria-label={t("关闭")} onClick={onClose} />
      <div
        ref={panelRef}
        className="activity-panel incidents-dialog"
        role="dialog"
        aria-label={t("故障")}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          onClose();
        }}
      >
        <header className="activity-header">
          <h2>{t("故障")}</h2>
          <div className="activity-filter" role="tablist" aria-label={t("故障分类")}>
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => onTab(item.id)}
              >
                {item.label}
                {item.count ? ` ${item.count}` : ""}
              </button>
            ))}
          </div>
          <button type="button" className="activity-close" aria-label={t("关闭")} onClick={onClose}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </header>
        <div className="activity-body incidents-dialog-body" ref={bodyRef} role="tabpanel">
          {tab === "incidents" && (
            <>
              <p className="incidents-dialog-note">
                {data?.settings.autoDispatch
                  ? t("自动派修已打开：同一种错误出现到次数就派给 {0} 修。", {
                      0: data.settings.fixer || t("指定的 Agent"),
                    })
                  : t("自动派修没打开，只记录和归类，可以手动派修。")}{" "}
                {data && (
                  <button
                    type="button"
                    className="incident-link incidents-dispatch-toggle"
                    aria-expanded={settingsOpen}
                    aria-controls="incidents-dispatch-settings"
                    onClick={() => setSettingsOpen((open) => !open)}
                  >
                    {t("派修设置")}
                    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                )}
              </p>
              {data && settingsOpen && (
                <section
                  id="incidents-dispatch-settings"
                  className="incidents-dispatch"
                  aria-label={t("派修设置")}
                >
                  <IncidentDispatchSettings
                    data={data}
                    rooms={rooms}
                    currentRoomId={currentRoomId}
                    username={username}
                    loadAgents={loadAgents}
                    onSave={incidents.updateSettings}
                  />
                </section>
              )}
              {error && <p className="settings-note error">{error}</p>}
              {data ? (
                <IncidentsPanel
                  data={data}
                  focusId={focusId}
                  onAction={incidents.act}
                  onDecide={incidents.decide}
                />
              ) : (
                !error && <p className="activity-empty">{t("正在加载…")}</p>
              )}
            </>
          )}
          {tab === "slow-ops" &&
            (slowCount === 0 ? (
              <p className="activity-empty">
                {slowOps.enabled ? t("最近没有慢操作。") : t("还没收到 Server 的慢操作记录。")}
              </p>
            ) : (
              <>
                <p className="incidents-dialog-note">
                  {t(
                    "Server 上的任务目录锁、git 命令、重查询和请求超过阈值时记在这里，页面卡顿、Agent 起不来时用来排查。",
                  )}{" "}
                  {slowOps.settings && thresholdNote(slowOps.settings)}
                </p>
                <SlowOpsList operations={slowOps.operations} label={t("最近慢操作")} />
              </>
            ))}
        </div>
      </div>
    </div>
  );
}
