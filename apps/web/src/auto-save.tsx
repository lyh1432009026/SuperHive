import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "./i18n";

export type AutoSaveState =
  { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

/** 一次保存；和已确认的值一样、没发请求时返回 false */
type SaveJob = () => Promise<boolean | void>;

/**
 * 改了就存：同一区块的保存排成一队依次发，前一个还没回来时只记住最新的一次，
 * 回来后再发；中间被盖掉的改动不会发，所以连着快点几下只按最后一次存、审计也只多记一笔。
 *
 * run 在真正发出时才执行，自己和「已确认的值」比较，没变就直接返回（不发请求）；
 * 成功时把服务端回的值记成已确认。队列空了以后调一次 sync(ok)：失败时把界面回滚到已确认的值，
 * 成功时界面本来就是人最后选的，按需对齐服务端整理过的值（比如去掉首尾空格）。
 */
export function useAutoSave(sync: (ok: boolean) => void) {
  const [state, setState] = useState<AutoSaveState>({ kind: "idle" });
  const stateRef = useRef(state);
  stateRef.current = state;
  const running = useRef(false);
  const pending = useRef<SaveJob | undefined>(undefined);
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const save = useCallback((run: SaveJob) => {
    if (running.current) {
      pending.current = run;
      return;
    }
    running.current = true;
    // 这一批都没发请求（值没变）时，恢复成开始前的状态，不平白把「已保存」换掉
    const previous = stateRef.current;
    setState({ kind: "saving" });
    void (async () => {
      let job: SaveJob | undefined = run;
      let failure: unknown;
      let sent = false;
      while (job) {
        try {
          if ((await job()) !== false) sent = true;
          failure = undefined;
        } catch (cause) {
          failure = cause;
        }
        job = pending.current;
        pending.current = undefined;
      }
      running.current = false;
      if (!mounted.current) return;
      syncRef.current(failure === undefined);
      setState(
        failure === undefined
          ? sent
            ? { kind: "saved" }
            : previous
          : {
              kind: "error",
              message: failure instanceof Error ? failure.message : String(failure),
            },
      );
    })();
  }, []);

  return { state, save };
}

/**
 * 区块里那行说明兼保存状态：平时是说明（比如「从下一次回复开始生效」），
 * 保存时换成「保存中…」「已保存。…」或失败原因，始终占同一行，不会把下面的内容挤动。
 */
export function SaveStatus({
  state,
  hint,
  savedHint,
  className = "agent-save-status",
}: {
  state: AutoSaveState;
  /** 没在保存时显示的说明；空串时这一行平时什么都不显示 */
  hint: string;
  /** 保存成功后跟在「已保存。」后面的一句，默认同 hint */
  savedHint?: string;
  className?: string;
}) {
  const text =
    state.kind === "saving"
      ? t("保存中…")
      : state.kind === "saved"
        ? t("已保存。{0}", { 0: savedHint ?? hint }).trim()
        : state.kind === "error"
          ? t("保存失败：{0}。已恢复原来的设置。", { 0: state.message.replace(/[。.]$/, "") })
          : hint;
  return (
    <small className={`${className} ${state.kind}`} role="status" aria-live="polite">
      {text}
    </small>
  );
}
