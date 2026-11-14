import { useCallback, useEffect, useState } from "react";
import type { LocalAgentModelsResponse } from "@superhive/protocol";
import { t } from "./i18n";
import { Select, type SelectOption } from "./select";

const CUSTOM = "\u0000custom";

/**
 * 选模型：列表从运行时拉（Server 的 /models），拉不到或列表里没有的可以手填。
 * value 为空串表示用运行时自己的默认模型（allowDefault 时才有这一项）。
 * 完全受控：选列表里的、手填时每次输入都通过 onChange 交出去，什么时候保存由外面决定。
 */
export function ModelPicker({
  data,
  value,
  onChange,
  onRefresh,
  allowDefault = false,
  disabled = false,
  id,
  "aria-label": ariaLabel,
}: {
  data: LocalAgentModelsResponse | undefined;
  value: string;
  onChange: (value: string) => void;
  /** 让 Server 重新拉一次列表 */
  onRefresh?: () => void;
  allowDefault?: boolean;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
}) {
  const models = data?.models ?? [];
  const listed = value === "" || models.some((model) => model.id === value);
  // 人点了「手动输入」；列表到了以后当前值不在列表里也按手填显示
  const [custom, setCustom] = useState(false);
  const runtimeDefault = models.find((model) => model.isDefault);
  const options: SelectOption[] = [
    ...(allowDefault
      ? [
          {
            value: "",
            label: t("运行时默认"),
            description: runtimeDefault
              ? t("现在是 {0}", { 0: runtimeDefault.label ?? runtimeDefault.id })
              : t("用这个 Agent CLI 自己配置的模型"),
          },
        ]
      : []),
    ...models.map((model) => ({
      value: model.id,
      label: model.label ?? model.id,
      ...(model.label ? { description: model.id } : {}),
    })),
    { value: CUSTOM, label: t("手动输入…"), description: t("列表里没有的模型名") },
  ];
  // 没有可选的（拉不到、不是本机 Agent）又不能选默认：直接给手填框
  const editing =
    custom ||
    (data !== undefined && !listed) ||
    (data !== undefined && models.length === 0 && !allowDefault);

  return (
    <div className="model-picker">
      <div className="model-picker-row">
        <Select
          {...(id ? { id } : {})}
          {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
          value={editing ? CUSTOM : value}
          options={options}
          disabled={disabled || !data}
          placeholder={data ? t("选择模型") : t("正在读取模型列表…")}
          onChange={(next) => {
            if (next === CUSTOM) {
              setCustom(true);
              return;
            }
            setCustom(false);
            onChange(next);
          }}
        />
        {onRefresh && (
          <button type="button" disabled={disabled || !data} onClick={onRefresh}>
            {t("刷新")}
          </button>
        )}
      </div>
      {editing && (
        <input
          className="model-picker-input"
          type="text"
          value={value}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          placeholder={t("模型名，例如 {0}", { 0: models[0]?.id ?? "gpt-5" })}
          aria-label={t("模型名")}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {data?.error && (
        <p className="agent-mcp-hint">
          {t("没能从运行时拉到模型列表（{0}），可以手动输入。", { 0: data.error })}
        </p>
      )}
      {data && !data.error && data.source === "preset" && (
        <p className="agent-mcp-hint">
          {t("这个运行时没有列模型的命令，下面是常用选项，也可以手动输入。")}
        </p>
      )}
    </div>
  );
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 「换个模型重试」：选一个模型，只对这一次重试生效，之后还是用 Agent 设置里的模型。
 * 本机 Agent 能拉到运行时的模型列表；其他 Agent 只能手填。
 */
export function RetryModelDialog({
  agentName,
  currentModel,
  load,
  onRetry,
  onClose,
}: {
  agentName: string;
  /** Agent 设置里的模型（不知道或用默认时为 undefined） */
  currentModel?: string | null | undefined;
  /** 拉模型列表；不是本机 Agent 时不给，只能手填 */
  load?: ((refresh: boolean) => Promise<LocalAgentModelsResponse>) | undefined;
  onRetry: (model: string) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<LocalAgentModelsResponse | undefined>(
    load ? undefined : { source: "preset", models: [] },
  );
  const [model, setModel] = useState("");

  const fetchModels = useCallback(
    async (refresh: boolean) => {
      if (!load) return;
      if (refresh) setData(undefined);
      try {
        setData(await load(refresh));
      } catch (cause) {
        setData({
          source: "preset",
          models: [],
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
    [load],
  );

  useEffect(() => {
    void fetchModels(false);
  }, [fetchModels]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const picked = model.trim();
  return (
    <div className="room-dialog-layer">
      <button
        className="room-dialog-scrim"
        type="button"
        aria-label={t("关闭")}
        onClick={onClose}
      />
      <form
        className="invite-dialog retry-model-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="retry-model-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (picked) onRetry(picked);
        }}
      >
        <header className="invite-dialog-header">
          <div>
            <h2 id="retry-model-title">{t("换个模型重试 @{0}", { 0: agentName })}</h2>
            <p>
              {currentModel
                ? t("只对这一次重试生效，之后还是用它设置里的模型 {0}。", { 0: currentModel })
                : t("只对这一次重试生效，之后还是用它设置里的模型。")}
            </p>
          </div>
          <button type="button" className="invite-close" aria-label={t("关闭")} onClick={onClose}>
            <CloseGlyph />
          </button>
        </header>
        <div className="invite-dialog-body">
          <ModelPicker
            aria-label={t("模型")}
            data={data}
            value={model}
            onChange={setModel}
            {...(load ? { onRefresh: () => void fetchModels(true) } : {})}
          />
          {!load && (
            <p className="agent-mcp-hint">
              {t("这个 Agent 不在这台电脑上，拿不到它的模型列表，请手动输入模型名。")}
            </p>
          )}
          <button type="submit" className="invite-submit" disabled={!picked}>
            {picked ? t("用 {0} 重试", { 0: picked }) : t("重试")}
          </button>
        </div>
      </form>
    </div>
  );
}
