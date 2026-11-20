import { useCallback, useEffect, useRef, useState } from "react";
import type { WorktreeStatus } from "@superhive/protocol";
import type { LocalAgentsState } from "./local-agents";
import { ConfirmPopover } from "./confirm-popover";
import { t } from "./i18n";

type WorktreeApi = Pick<
  LocalAgentsState,
  | "worktrees"
  | "cleanupWorktrees"
  | "configureWorktreeCleanup"
  | "cleanWorktreeBatch"
  | "repairWorktree"
  | "canManage"
>;

function dependencyLabel(state: NonNullable<WorktreeStatus["dependencies"]>["state"]): string {
  switch (state) {
    case "preparing":
      return t("正在准备依赖");
    case "installed":
      return t("依赖已安装");
    case "linked":
      return t("依赖软链自主目录");
    default:
      return t("依赖没准备好");
  }
}

export function WorktreePanel({ roomId, api }: { roomId: string; api: WorktreeApi }) {
  const [rows, setRows] = useState<WorktreeStatus[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [automatic, setAutomatic] = useState(false);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const autoRef = useRef<HTMLInputElement>(null);
  const closeAutoConfirm = useCallback(() => {
    setConfirmAuto(false);
    autoRef.current?.focus();
  }, []);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [keepBranch, setKeepBranch] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<string>();
  const [batch, setBatch] = useState<{ id: string; count: number } | null>();
  const heads = useRef(new Map<string, string | undefined>());
  const refreshVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const inventory = await api.worktrees(roomId);
      const next = inventory.worktrees ?? [];
      if (version !== refreshVersion.current) return;
      setRows(next);
      setAutomatic(inventory.autoCleanup);
      setBatch(next.some((item) => item.removable) ? inventory.cleanupBatch : null);
      const previousHeads = heads.current;
      setSelected((current) =>
        current.filter((id) =>
          next.some(
            (item) =>
              item.worktree.id === id &&
              item.removable &&
              previousHeads.get(id) === item.headCommit,
          ),
        ),
      );
      heads.current = new Map(next.map((item) => [item.worktree.id, item.headCommit]));
      setError(undefined);
    } catch (reason) {
      if (version === refreshVersion.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (version === refreshVersion.current) setLoading(false);
    }
  }, [api.worktrees, roomId]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const eligible = rows.filter((item) => item.removable);
  const picked = rows.filter(
    (item) => selected.includes(item.worktree.id) && item.removable && item.headCommit,
  );
  const clean = async () => {
    refreshVersion.current++;
    setBusy(true);
    setResult(undefined);
    try {
      const response = await api.cleanupWorktrees(roomId, {
        items: picked.map((item) => ({ id: item.worktree.id, headCommit: item.headCommit! })),
        deleteBranch: !keepBranch,
      });
      const removed = response.results.filter((item) => item.removed).length;
      setResult(
        t("已清理 {0} 个目录，保留 {1} 个。", { 0: removed, 1: response.results.length - removed }),
      );
      const problems = response.results.flatMap((item) =>
        item.error || item.branchError ? [item.error ?? item.branchError!] : [],
      );
      if (problems.length) setResult((current) => `${current}\n${problems.join("\n")}`);
      setSelected([]);
      setConfirmCleanup(false);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const repair = async (item: WorktreeStatus, action: "restore" | "adopt") => {
    setBusy(true);
    setResult(undefined);
    setError(undefined);
    try {
      await api.repairWorktree(roomId, item.worktree.id, action);
      setResult(
        action === "restore"
          ? t("已切回登记的分支 {0}。", { 0: item.worktree.branch })
          : t("已按当前分支 {0} 重新登记。", { 0: item.branchSwitched?.current ?? "" }),
      );
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const configure = async (enabled: boolean) => {
    setBusy(true);
    try {
      await api.configureWorktreeCleanup(roomId, enabled);
      setAutomatic(enabled);
      setConfirmAuto(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="worktree-panel" aria-label="Worktree">
      <div className="worktree-panel-heading">
        <div>
          <h3>Worktree</h3>
          <p>{t("一条开发任务一个目录；合入后安全回收，不删除聊天记录。")}</p>
        </div>
        <button type="button" disabled={busy} onClick={() => void refresh()}>
          {t("刷新")}
        </button>
      </div>
      {batch && (
        <div className="worktree-batch" role="status">
          <span>{t("{0} 个 worktree 已合入，可清理。", { 0: batch.count })}</span>
          <button
            type="button"
            disabled={busy || !api.canManage}
            onClick={async () => {
              setBusy(true);
              try {
                await api.cleanWorktreeBatch(roomId, batch.id);
                setResult(t("已提交批量清理请求，完成后通知。"));
                setBatch(null);
              } catch (reason) {
                setError(String(reason));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("清理这批目录")}
          </button>
        </div>
      )}
      {loading && <p role="status">{t("正在核对 worktree…")}</p>}
      {!loading && rows.length === 0 && !error && (
        <p className="worktree-empty">
          {t("还没有 Hive 管理的 worktree。手工建立的目录不会被接管或删除。")}
        </p>
      )}
      <div className="worktree-rows">
        {rows.map((item) => (
          <div className="worktree-entry" key={item.worktree.id}>
            <label className={`worktree-row ${item.removable ? "eligible" : ""}`}>
              <input
                type="checkbox"
                aria-label={`${t("选择目录")} ${item.worktree.branch}`}
                checked={selected.includes(item.worktree.id)}
                disabled={!item.removable || busy || !api.canManage}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, item.worktree.id]
                      : current.filter((id) => id !== item.worktree.id),
                  )
                }
              />
              <div className="worktree-identity">
                <strong>
                  <code>{item.worktree.branch}</code>
                </strong>
                <small>
                  {item.worktree.agentName} · {item.worktree.slug}
                </small>
                <code className="worktree-path">{item.worktree.path}</code>
                <div className="worktree-statuses">
                  {/* 换了分支时没法判断登记的分支合没合入，不显示 */}
                  {!item.branchSwitched && (
                    <span className={item.merged ? "passed" : ""}>
                      {item.merged ? t("已合入") : t("尚未合入")}
                    </span>
                  )}
                  <span>{item.dirty || item.untracked ? t("有未提交文件") : t("工作区干净")}</span>
                  {item.ignored && <span className="warning">{t("有忽略文件，需先自行处理")}</span>}
                  {item.dependencies && item.dependencies.state !== "skipped" && (
                    <span
                      className={item.dependencies.state === "failed" ? "warning" : ""}
                      title={item.dependencies.message}
                    >
                      {dependencyLabel(item.dependencies.state)}
                    </span>
                  )}
                  {item.activeInvocationIds.length > 0 && <span>{t("有任务占用")}</span>}
                  {item.removable && <span className="passed">{t("可清理")}</span>}
                </div>
                {item.ignoredFiles && item.ignoredFiles.length > 0 && (
                  <small className="worktree-ignored">
                    {t("挡住清理的忽略文件：{0}", { 0: item.ignoredFiles.join(t("、")) })}
                  </small>
                )}
                {item.error && !item.branchSwitched && <small role="alert">{item.error}</small>}
              </div>
            </label>
            {item.branchSwitched && (
              <div className="worktree-switched" role="alert">
                <strong>
                  {t("分支已被切换：登记 {0}，当前 {1}", {
                    0: item.branchSwitched.registered,
                    1: item.branchSwitched.current,
                  })}
                </strong>
                <p>
                  {t(
                    "处理前 Agent 不会再沿用这个目录，也不会自动清理。切回只在没有未提交文件时可用；重新登记要求新分支没被别的任务线占用。两种都要等占用它的任务结束。",
                  )}
                </p>
                <div className="worktree-toolbar">
                  <button
                    type="button"
                    disabled={
                      busy ||
                      !api.canManage ||
                      item.dirty ||
                      item.untracked ||
                      item.activeInvocationIds.length > 0
                    }
                    onClick={() => void repair(item, "restore")}
                  >
                    {t("切回登记分支")}
                  </button>
                  <button
                    type="button"
                    disabled={busy || !api.canManage || item.activeInvocationIds.length > 0}
                    onClick={() => void repair(item, "adopt")}
                  >
                    {t("按当前分支重新登记")}
                  </button>
                </div>
                {(item.dirty || item.untracked) && (
                  <small>
                    {t("目录里有未提交或未跟踪的文件，不能切回；可以按当前分支重新登记。")}
                  </small>
                )}
                {item.activeInvocationIds.length > 0 && (
                  <small>{t("还有任务在用这个目录，结束后才能处理。")}</small>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {rows.length > 0 && (
        <div className="worktree-toolbar">
          <button
            type="button"
            disabled={!eligible.length || busy || !api.canManage}
            onClick={() => setSelected(eligible.map((item) => item.worktree.id))}
          >
            {t("选择可清理项（{0}）", { 0: eligible.length })}
          </button>
          <button
            type="button"
            disabled={!picked.length || busy || !api.canManage}
            onClick={() => setConfirmCleanup(true)}
          >
            {t("清理选中（{0}）", { 0: picked.length })}
          </button>
        </div>
      )}
      {confirmCleanup && (
        <div className="worktree-confirmation" role="alert">
          <strong>{t("确认移除这些目录？")}</strong>
          <p>{t("删除前重新核对文件、合入证据和任务占用；检查不通过就保留，不强删。")}</p>
          {picked.map((item) => (
            <code key={item.worktree.id}>{item.worktree.path}</code>
          ))}
          <label>
            <input
              type="checkbox"
              checked={keepBranch}
              onChange={(event) => setKeepBranch(event.target.checked)}
            />
            {t("保留分支")}
          </label>
          <p>{t("不保留时也只用安全删除；squash 后 Git 拒绝删分支就保留并告知。")}</p>
          <div className="worktree-toolbar">
            <button type="button" disabled={busy} onClick={() => setConfirmCleanup(false)}>
              {t("取消")}
            </button>
            <button
              type="button"
              disabled={busy || !picked.length || !api.canManage}
              onClick={() => void clean()}
            >
              {t("确认清理")}
            </button>
          </div>
        </div>
      )}
      {/* 开启自动清理要确认：就地弹一个轻量确认气泡，确认后才勾上；关闭不用确认 */}
      <div>
        <label className="worktree-auto">
          <input
            ref={autoRef}
            type="checkbox"
            checked={automatic}
            aria-expanded={confirmAuto}
            disabled={busy || !api.canManage}
            onChange={(event) =>
              event.target.checked ? setConfirmAuto(true) : void configure(false)
            }
          />
          <span>
            <strong>{t("自动清理已合入的 worktree")}</strong>
            <small>
              {t(
                "默认关闭；只回收已登记、干净且无任务占用的目录。node_modules 和构建产物随目录一起删，其他忽略文件会阻止删除。",
              )}
            </small>
          </span>
        </label>
        {confirmAuto && (
          <ConfirmPopover
            ariaLabel={t("确认开启自动清理")}
            message={t("开启后符合安全条件的目录会直接回收，不再逐次询问。")}
            confirmLabel={t("开启")}
            cancelLabel={t("取消")}
            anchorRef={autoRef}
            busy={busy}
            onConfirm={() => void configure(true)}
            onCancel={closeAutoConfirm}
          />
        )}
      </div>
      {error && (
        <p role="alert" className="room-dialog-error">
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="worktree-result">
          {result}
        </p>
      )}
    </section>
  );
}
