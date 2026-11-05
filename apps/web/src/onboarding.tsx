import { useEffect, useId, useRef } from "react";
import { t } from "./i18n";

/**
 * 首次使用引导：第一次打开网页的房主，带着做完三件事——接入 Agent、开通知、连 IM。
 * 可以跳过；做完或跳过后不再出现。之前就用过的人（本机已有昵称）不显示。
 */
export const ONBOARDING_STORAGE_KEY = "superhive.onboarding";

/** 页面加载时判断：本机还没有昵称，说明是第一次用，标成待引导 */
export function markOnboardingIfNew(storage: Storage, usernameKey: string): void {
  try {
    if (!storage.getItem(usernameKey) && !storage.getItem(ONBOARDING_STORAGE_KEY)) {
      storage.setItem(ONBOARDING_STORAGE_KEY, "pending");
    }
  } catch {
    // 存储不可用就不引导
  }
}

export function onboardingPending(storage: Storage): boolean {
  try {
    return storage.getItem(ONBOARDING_STORAGE_KEY) === "pending";
  } catch {
    return false;
  }
}

export function finishOnboarding(storage: Storage): void {
  try {
    storage.setItem(ONBOARDING_STORAGE_KEY, "done");
  } catch {
    // 存不了下次还会出现，不影响使用
  }
}

export type OnboardingStep = {
  id: "agent" | "notifications" | "im";
  title: string;
  description: string;
  action: string;
  done: boolean;
  /** 这一步当前做不了时的说明（比如浏览器不支持通知） */
  unavailable?: string;
  onAction: (trigger: HTMLButtonElement) => void;
};

export function OnboardingGuide({
  steps,
  onClose,
}: {
  steps: readonly OnboardingStep[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const doneCount = steps.filter((step) => step.done).length;
  const allDone = doneCount === steps.length;

  useEffect(() => {
    const dialog = ref.current;
    if (dialog?.showModal && !dialog.open) dialog.showModal();
    else dialog?.setAttribute("open", "");
    return () => dialog?.close?.();
  }, []);

  return (
    <dialog
      ref={ref}
      className="onboarding-guide"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <p className="onboarding-eyebrow">
          {t("第一次使用 · 已完成 {0}/{1}", { 0: doneCount, 1: steps.length })}
        </p>
        <h2 id={titleId}>{t("三步开始用 SuperHive")}</h2>
        <p>{t("每一步都可以以后再做，在右侧栏和设置里都能找到。")}</p>
      </header>
      <ol className="onboarding-steps">
        {steps.map((step, index) => (
          <li key={step.id} className={step.done ? "done" : ""}>
            <span className="onboarding-step-index" aria-hidden="true">
              {step.done ? "✓" : index + 1}
            </span>
            <div>
              <strong>{step.title}</strong>
              <small>{step.unavailable ?? step.description}</small>
            </div>
            {step.done ? (
              <span className="onboarding-step-done">{t("已完成")}</span>
            ) : (
              <button
                type="button"
                disabled={Boolean(step.unavailable)}
                onClick={(event) => step.onAction(event.currentTarget)}
              >
                {step.action}
              </button>
            )}
          </li>
        ))}
      </ol>
      <footer>
        <button type="button" className={allDone ? "primary" : ""} onClick={onClose}>
          {allDone ? t("开始使用") : t("跳过，以后再说")}
        </button>
      </footer>
    </dialog>
  );
}
